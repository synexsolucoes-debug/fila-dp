import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { agentAutomationPolicies, type AgentAutomationPolicy } from "@/lib/agent-proposals";
import { listAgentRuntime, readAgentAutomationPolicy, resolveAgentChannel } from "@/lib/agent-runtime";
import { agentCadences, isAgentCadence, nextRunAt } from "@/lib/agent-schedule";

/**
 * Administração de agentes (§65) e kill switch (§66).
 *
 * O `GET` responde o que um operador precisa antes de decidir pausar: quantas
 * execuções, quantas falharam, quantos eventos entraram, quantos foram
 * ignorados, quantas propostas estão em triagem e quantas foram aplicadas.
 * Tudo agregado por consulta — contador próprio que alguém esquece de
 * incrementar mente por meses.
 *
 * O `PATCH` é o kill switch. Ele muda `fdp_integrations.status`, que é o mesmo
 * interruptor que o webhook já respeita: não existe um segundo lugar onde a
 * automação continue rodando depois de pausada. E não depende de deploy, que é
 * exatamente o requisito.
 */

/**
 * O fuso existe de verdade?
 *
 * `Intl` é a única fonte que já conhece a base de fusos, com horário de verão
 * incluído. Testar convertendo é mais barato e mais correto do que manter uma
 * lista à mão, que envelhece toda vez que um país muda de regra.
 */
function isSupportedTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.status.read", "consultar os agentes");

    const [agents, policy] = await Promise.all([
      listAgentRuntime(d1, workspace.id),
      readAgentAutomationPolicy(d1, workspace.id),
    ]);

    return Response.json({
      agents,
      /* O catálogo vai junto com o estado: a tela precisa oferecer as cadências
         possíveis com o que cada uma significa, e não um `select` de enums. */
      cadences: agentCadences.map((cadence) => ({
        key: cadence.key, label: cadence.label, description: cadence.description,
        intervalMinutes: cadence.intervalMinutes, businessHoursOnly: cadence.businessHoursOnly,
      })),
      automation: {
        policy,
        /* O rótulo diz o que a política faz, não o nome dela: "suggest_only"
           não significa nada para quem opera. */
        label: policy === "off"
          ? "Desligada — toda entrada vai para triagem"
          : policy === "trusted"
            ? "Automática para rotina de alta confiança, com evidência"
            : "Só sugere — nenhuma ação acontece sem confirmação",
      },
      permissions: {
        manage: hasCapability(workspace, "integrations.manage"),
        execute: hasCapability(workspace, "integrations.execute"),
        reprocess: hasCapability(workspace, "integrations.run"),
        viewLogs: hasCapability(workspace, "integrations.logs.view"),
        resolveTriage: hasCapability(workspace, "integrations.reconcile"),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.manage", "pausar ou reativar um agente");
    const requestId = request.headers.get("x-fila-dp-request-id");

    const policy = text(body.automationPolicy, 20);
    if (policy) {
      if (!(agentAutomationPolicies as readonly string[]).includes(policy)) {
        throw ApiError.badRequest("Política de automação desconhecida.", "AGENT_POLICY_INVALID");
      }
      const previous = await readAgentAutomationPolicy(d1, workspace.id);
      await d1.batch([
        d1.prepare(`INSERT INTO fdp_workspace_settings (workspace_id, agent_automation)
          VALUES (?, ?)
          ON CONFLICT (workspace_id) DO UPDATE SET agent_automation = EXCLUDED.agent_automation, updated_at = now()`)
          .bind(workspace.id, policy as AgentAutomationPolicy),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "agent.automation_policy_changed", entityType: "workspace_settings", entityId: workspace.id,
          before: { agentAutomation: previous }, after: { agentAutomation: policy }, requestId,
        }),
      ]);
      return Response.json({ automation: { policy } });
    }

    const agentKey = resolveAgentChannel(body.agentKey);
    const enabled = body.enabled;
    const cadence = text(body.cadence, 30);
    const timeZone = text(body.timeZone, 60);
    if (!agentKey) {
      throw ApiError.badRequest(
        "Informe o agente e se ele deve ficar ativo, ou a política de automação do grupo.",
        "AGENT_TOGGLE_INVALID",
      );
    }
    if (typeof enabled !== "boolean" && !cadence && !timeZone) {
      throw ApiError.badRequest(
        "Informe o que muda: se o agente fica ativo, com que cadência ou em que fuso.",
        "AGENT_TOGGLE_INVALID",
      );
    }

    const current = await d1.prepare(`SELECT id, status, schedule_enabled, schedule_cadence, schedule_timezone
        FROM fdp_integrations WHERE workspace_id = ? AND channel = ?`)
      .bind(workspace.id, agentKey)
      .first<{ id: string; status: string; schedule_enabled: number; schedule_cadence: string; schedule_timezone: string }>();
    if (!current) throw ApiError.notFound("Este agente não está configurado neste grupo.", "AGENT_NOT_CONFIGURED");

    /* Cadência e fuso mudam sem passar pelo interruptor: pausar um agente e
       reagendá-lo são decisões diferentes, e juntá-las na mesma chamada faria
       um ajuste de horário reativar o que alguém desligou de propósito. */
    if (cadence || timeZone) {
      if (cadence && !isAgentCadence(cadence)) {
        throw ApiError.badRequest(
          "Cadência desconhecida. Escolha uma das oferecidas — frequências menores que 15 minutos não são aceitas.",
          "AGENT_CADENCE_INVALID",
        );
      }
      if (timeZone && !isSupportedTimeZone(timeZone)) {
        throw ApiError.badRequest(
          "Fuso horário desconhecido. Use um identificador como America/Sao_Paulo.",
          "AGENT_TIMEZONE_INVALID",
        );
      }
      const nextCadence = cadence || current.schedule_cadence;
      const nextTimeZone = timeZone || current.schedule_timezone;
      const scheduleEnabled = nextCadence === "manual" ? 0 : 1;
      const next = scheduleEnabled
        ? nextRunAt({ cadence: nextCadence, from: new Date(), timeZone: nextTimeZone })
        : null;

      await d1.batch([
        d1.prepare(`UPDATE fdp_integrations
            SET schedule_cadence = ?, schedule_timezone = ?, schedule_enabled = ?,
                next_sync_at = ?::timestamptz, updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = ? AND id = ?`)
          .bind(nextCadence, nextTimeZone, scheduleEnabled, next ? next.toISOString() : null, workspace.id, current.id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "agent.schedule_changed", entityType: "integration", entityId: current.id,
          before: { cadence: current.schedule_cadence, timeZone: current.schedule_timezone, scheduleEnabled: current.schedule_enabled },
          after: { cadence: nextCadence, timeZone: nextTimeZone, scheduleEnabled },
          metadata: { agentKey }, requestId,
        }),
      ]);

      if (typeof enabled !== "boolean") {
        return Response.json({
          agent: {
            key: agentKey, cadence: nextCadence, timeZone: nextTimeZone,
            scheduleEnabled: scheduleEnabled === 1, nextRunAt: next ? next.toISOString() : null,
          },
        });
      }
    }

    /* Reativar devolve o conector a `connected` só quando ele estava pausado.
       Um conector em `needs_credentials` não vira `connected` por um clique —
       isso seria declarar conectado o que nunca autenticou. */
    const nextStatus = enabled
      ? (current.status === "paused" ? "connected" : current.status)
      : "paused";
    await d1.batch([
      d1.prepare("UPDATE fdp_integrations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(nextStatus, workspace.id, current.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: enabled ? "agent.resumed" : "agent.paused",
        entityType: "integration", entityId: current.id,
        before: { status: current.status }, after: { status: nextStatus },
        metadata: { agentKey }, requestId,
      }),
    ]);

    return Response.json({ agent: { key: agentKey, status: nextStatus, enabled: nextStatus !== "paused" } });
  } catch (error) {
    return apiError(error);
  }
}
