import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { requireAgentChannel } from "@/lib/agent-scheduler";
import { cleanText } from "@/lib/registrations";

/**
 * Histórico de execução de um agente (§26, §69).
 *
 * Duas camadas, de propósito. A primeira é a **execução**: começou quando,
 * terminou quando, quantos itens vieram, quantos entraram, quantos foram
 * ignorados, quantos falharam e por quê — é o que responde "o agente está
 * fazendo o trabalho?" sem que ninguém precise abrir log de servidor. A segunda
 * são as **linhas de log** daquela execução, pedidas à parte: são detalhe
 * técnico, e carregar todas junto com a lista faria a tela abrir devagar para
 * mostrar o que quase ninguém lê.
 *
 * Paginação por cursor, e não por página numerada: o histórico cresce por cima,
 * e a página 2 de um minuto atrás não é a página 2 de agora. O cursor é o
 * instante da última linha entregue, que é estável.
 *
 * ## Segredo
 *
 * Nada aqui vem da credencial. As mensagens são escritas pelo executor com
 * texto próprio, e o metadado é filtrado na escrita — só número, booleano e
 * texto curto entram. Esta rota devolve o que está gravado; a garantia de que
 * segredo não chega ao log está na escrita, que é onde precisa estar.
 */

type RouteContext = { params: Promise<{ agente: string }> };

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

export async function GET(request: Request, { params }: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { agente } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.logs.view", "consultar o histórico do agente");

    const channel = requireAgentChannel(agente);
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(MAX_PAGE, Number(url.searchParams.get("limite")) || DEFAULT_PAGE));
    const cursor = cleanText(url.searchParams.get("cursor"), 40);
    const runId = cleanText(url.searchParams.get("execucao"), 80);

    const integration = await d1.prepare("SELECT id, display_name FROM fdp_integrations WHERE workspace_id = ? AND channel = ?")
      .bind(workspace.id, channel).first<{ id: string; display_name: string }>();
    if (!integration) {
      throw ApiError.notFound("Este agente não está configurado neste grupo.", "AGENT_NOT_CONFIGURED");
    }

    if (runId) {
      /* Linhas de uma execução, em ordem de acontecimento. O cursor é a
         sequência, que o próprio executor numera — nunca o instante, porque
         duas linhas podem cair no mesmo milissegundo. */
      const after = Number(cursor) || 0;
      const lines = await d1.prepare(`SELECT sequence, level, phase, code, message, metadata_json, created_at
          FROM fdp_integration_run_logs
        WHERE workspace_id = ? AND integration_id = ? AND run_id = ? AND sequence > ?
        ORDER BY sequence LIMIT ?`)
        .bind(workspace.id, integration.id, runId, after, limit + 1)
        .all<Record<string, unknown>>();

      const page = lines.results.slice(0, limit);
      return Response.json({
        runId,
        lines: page.map((row) => ({
          sequence: Number(row.sequence ?? 0),
          level: String(row.level ?? "info"),
          phase: String(row.phase ?? ""),
          code: String(row.code ?? ""),
          message: String(row.message ?? ""),
          metadata: (row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {}) as Record<string, unknown>,
          at: String(row.created_at ?? ""),
        })),
        nextCursor: lines.results.length > limit ? String(page[page.length - 1]?.sequence ?? "") : "",
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const runs = await d1.prepare(`SELECT r.id, r.trigger_type, r.status, r.attempt, r.received_count,
          r.processed_count, r.skipped_count, r.conflict_count, r.failed_count, r.duration_ms,
          r.summary, r.error_code, r.error_message, r.started_at, r.completed_at, r.created_at,
          (SELECT count(*)::int FROM fdp_integration_run_logs l
             WHERE l.workspace_id = r.workspace_id AND l.run_id = r.id) AS log_lines,
          (SELECT j.status FROM fdp_integration_jobs j
             WHERE j.workspace_id = r.workspace_id AND j.run_id = r.id
             ORDER BY j.created_at DESC LIMIT 1) AS job_status,
          (SELECT j.id FROM fdp_integration_jobs j
             WHERE j.workspace_id = r.workspace_id AND j.run_id = r.id
             ORDER BY j.created_at DESC LIMIT 1) AS job_id
        FROM fdp_integration_sync_runs r
      WHERE r.workspace_id = ? AND r.integration_id = ? AND (? = '' OR r.created_at < ?::timestamptz)
      ORDER BY r.created_at DESC LIMIT ?`)
      .bind(workspace.id, integration.id, cursor, cursor, limit + 1)
      .all<Record<string, unknown>>();

    const page = runs.results.slice(0, limit);
    return Response.json({
      agent: { key: channel, displayName: String(integration.display_name || channel) },
      runs: page.map((row) => ({
        id: String(row.id ?? ""),
        trigger: String(row.trigger_type ?? ""),
        status: String(row.status ?? ""),
        attempt: Number(row.attempt ?? 0),
        received: Number(row.received_count ?? 0),
        processed: Number(row.processed_count ?? 0),
        skipped: Number(row.skipped_count ?? 0),
        conflict: Number(row.conflict_count ?? 0),
        failed: Number(row.failed_count ?? 0),
        durationMs: Number(row.duration_ms ?? 0),
        summary: String(row.summary ?? ""),
        errorCode: String(row.error_code ?? ""),
        errorMessage: String(row.error_message ?? ""),
        startedAt: String(row.started_at ?? "") || null,
        completedAt: String(row.completed_at ?? "") || null,
        createdAt: String(row.created_at ?? ""),
        logLines: Number(row.log_lines ?? 0),
        jobStatus: String(row.job_status ?? ""),
        jobId: String(row.job_id ?? ""),
        /* O que a tela precisa saber para oferecer "reprocessar" sem descobrir
           depois do clique que não havia o que reprocessar (§56). */
        reprocessable: String(row.job_status ?? "") === "dead_letter",
      })),
      nextCursor: runs.results.length > limit ? String(page[page.length - 1]?.created_at ?? "") : "",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
