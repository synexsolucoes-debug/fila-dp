import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { requireAgentChannel } from "@/lib/agent-scheduler";

/**
 * Reprocessar uma execução que desistiu (§25, §35).
 *
 * O item irrecuperável não é apagado nem escondido: ele fica em `dead_letter`,
 * visível, esperando decisão humana. Reprocessar é essa decisão — devolver o
 * job à fila com as tentativas zeradas.
 *
 * ## Por que isto não duplica efeito
 *
 * A execução volta com o **mesmo** `run_id` e, portanto, com a mesma chave de
 * idempotência dos itens: `fdp_integration_sync_items` tem índice único em
 * (workspace, integração, mapeamento, id externo, hash do payload), e
 * `fdp_integration_events` em (workspace, integração, evento externo). Um
 * registro já processado na tentativa anterior não é processado de novo — ele
 * é reconhecido como reentrega e ignorado.
 *
 * É por isso que o reprocessamento reaproveita o job em vez de criar outro: um
 * job novo com chave nova reabriria a porta que a idempotência fecha.
 */

type RouteContext = { params: Promise<{ agente: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { agente } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.run", "reprocessar uma execução de agente");

    const channel = requireAgentChannel(agente);
    const jobId = text(body.jobId, 80);
    const runId = text(body.runId, 80);
    if (!jobId && !runId) {
      throw ApiError.badRequest("Informe qual execução deve ser reprocessada.", "AGENT_REPROCESS_TARGET_REQUIRED");
    }

    const integration = await d1.prepare("SELECT id, status FROM fdp_integrations WHERE workspace_id = ? AND channel = ?")
      .bind(workspace.id, channel).first<{ id: string; status: string }>();
    if (!integration) {
      throw ApiError.notFound("Este agente não está configurado neste grupo.", "AGENT_NOT_CONFIGURED");
    }
    if (integration.status === "paused") {
      throw new ApiError(409, "AGENT_PAUSED",
        "Este agente está pausado. Reative-o antes de reprocessar.");
    }

    /* A recolocação é condicionada a `dead_letter` e à ausência de outra
       execução ativa: sem isso, dois cliques criariam a segunda execução que o
       índice único proíbe, e a recusa chegaria como erro de banco. */
    const requeued = await d1.prepare(`UPDATE fdp_integration_jobs job
        SET status = 'queued', attempt = 0, available_at = CURRENT_TIMESTAMP,
            lease_token = '', lease_expires_at = NULL, completed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE job.workspace_id = ? AND job.integration_id = ? AND job.status = 'dead_letter'
        AND (? = '' OR job.id = ?) AND (? = '' OR job.run_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM fdp_integration_jobs active
          WHERE active.workspace_id = job.workspace_id AND active.integration_id = job.integration_id
            AND active.status IN ('queued', 'leased')
        )
      RETURNING job.id, job.run_id`)
      .bind(workspace.id, integration.id, jobId, jobId, runId, runId)
      .first<{ id: string; run_id: string }>();

    if (!requeued) {
      throw new ApiError(409, "AGENT_REPROCESS_NOT_AVAILABLE",
        "Nada a reprocessar: ou a execução não esgotou as tentativas, ou já existe outra em andamento para este agente.");
    }

    await d1.batch([
      d1.prepare(`UPDATE fdp_integration_sync_runs
          SET status = 'queued', error_code = '', error_message = '', completed_at = NULL
        WHERE workspace_id = ? AND id = ?`).bind(workspace.id, requeued.run_id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "agent.run_reprocessed", entityType: "integration_run", entityId: requeued.run_id,
        before: { status: "dead_letter" }, after: { status: "queued", agentKey: channel, jobId: requeued.id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({
      reprocessed: true,
      run: { id: requeued.run_id, status: "queued" },
      detail: "Execução devolvida à fila. O que já tinha sido importado não será importado de novo.",
    }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
