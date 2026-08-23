import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { manualRunKey } from "@/lib/agent-schedule";
import { asAgentQueueConflict, prepareNextRun, requireSchedulableAgent } from "@/lib/agent-scheduler";
import { queueIntegrationRun } from "@/lib/integration-engine";
import { queueSankhyaRun } from "@/lib/sankhya/queue";
import { agentCadence } from "@/lib/agent-schedule";

/**
 * Executar agora (§24).
 *
 * O botão não executa: ele **enfileira**. A execução continua acontecendo fora
 * da requisição de quem clicou (§28), no mesmo executor de sempre — abrir uma
 * sessão de navegador dentro do request faria a pessoa esperar o Playwright
 * subir, e faria a função morrer no limite de tempo antes de terminar.
 *
 * Três recusas, todas explicadas:
 *
 *   * **sem confirmação** — disparar automação por engano custa requisição no
 *     sistema de origem e pode reabrir trabalho já triado;
 *   * **execução em andamento** — o índice único parcial impede o segundo job, e
 *     esta rota traduz a colisão em uma frase em vez de um erro de restrição;
 *   * **agente pausado ou sem credencial** — quem foi desligado por uma pessoa
 *     não volta a rodar por um clique em outra tela.
 *
 * A idempotência da janela curta é o que impede o clique duplo de virar duas
 * execuções: dois cliques em cinco minutos produzem a mesma chave.
 */

type RouteContext = { params: Promise<{ agente: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { agente } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.execute", "executar um agente");

    const channel = requireSchedulableAgent(agente);
    if (body.confirm !== true) {
      throw ApiError.badRequest(
        "Confirme a execução. Ela consulta o sistema de origem e pode abrir novas demandas.",
        "AGENT_RUN_CONFIRMATION_REQUIRED",
      );
    }

    const integration = await d1.prepare(`SELECT id, status, schedule_cadence, schedule_timezone
        FROM fdp_integrations WHERE workspace_id = ? AND channel = ?`)
      .bind(workspace.id, channel)
      .first<{ id: string; status: string; schedule_cadence: string; schedule_timezone: string }>();
    if (!integration) {
      throw ApiError.notFound("Este agente não está configurado neste grupo.", "AGENT_NOT_CONFIGURED");
    }
    if (integration.status === "paused") {
      throw new ApiError(409, "AGENT_PAUSED",
        "Este agente está pausado. Reative-o antes de executar — pausa é decisão de alguém, e um clique aqui não a desfaz.");
    }
    if (integration.status !== "connected") {
      throw new ApiError(409, "AGENT_NOT_CONNECTED",
        "Este agente ainda não tem uma conexão válida. Configure e teste a credencial antes de executar.");
    }

    const at = new Date();
    const idempotencyKey = manualRunKey({ agentKey: channel, at });
    const requestId = request.headers.get("x-fila-dp-request-id");

    try {
      const run = channel === "sankhya_browser"
        ? await queueSankhyaRun(d1, {
          workspaceId: workspace.id, integrationId: integration.id,
          triggerType: "manual", requestedBy: user.id, idempotencyKey,
        })
        : await queueIntegrationRun(d1, {
          workspaceId: workspace.id, integrationId: integration.id,
          triggerType: "manual", requestedBy: user.id, idempotencyKey,
        });

      /* Um disparo manual empurra o próximo automático: rodar agora e de novo em
         dois minutos não é o que quem clicou pediu, e é o que aconteceria se o
         horário previsto ficasse no passado. */
      await prepareNextRun(d1, {
        workspaceId: workspace.id, integrationId: integration.id,
        cadence: agentCadence(integration.schedule_cadence).key,
        timeZone: integration.schedule_timezone, from: at,
      }).run();

      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "agent.run_requested", entityType: "integration", entityId: integration.id,
        after: { agentKey: channel, runId: String(run?.id ?? ""), trigger: "manual" },
        requestId,
      }).run();

      return Response.json({
        queued: true,
        agent: { key: channel },
        run: { id: String(run?.id ?? ""), status: String(run?.status ?? "queued") },
        // A tela precisa dizer o que vai acontecer, e não "sucesso": nada foi
        // lido ainda, e a pessoa vai ficar olhando para o resultado antigo.
        detail: "Execução enfileirada. O resultado aparece aqui assim que a varredura drenar a fila.",
      }, { status: 202 });
    } catch (error) {
      const conflict = asAgentQueueConflict(error);
      if (conflict) throw conflict;
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}
