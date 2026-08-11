import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type Context = { params: Promise<{ runId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { runId } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.status.read");
    const run = await d1.prepare(`SELECT run.*, integration.display_name, integration.channel, mapping.resource_type, mapping.direction, mapping.version AS mapping_version
      FROM fdp_integration_sync_runs run
      JOIN fdp_integrations integration ON integration.workspace_id = run.workspace_id AND integration.id = run.integration_id
      LEFT JOIN fdp_integration_mappings mapping ON mapping.workspace_id = run.workspace_id AND mapping.id = run.mapping_id
      WHERE run.workspace_id = ? AND run.id = ?`).bind(workspace.id, runId).first<Record<string, unknown>>();
    if (!run) throw ApiError.notFound("Execução não encontrada.", "SYNC_RUN_NOT_FOUND");
    const [items, jobs] = await Promise.all([
      d1.prepare(`SELECT id, item_key, external_id, direction, status, payload_hash, target_type, target_id, metadata_json, error_code, error_message, processed_at, created_at
        FROM fdp_integration_sync_items WHERE workspace_id = ? AND run_id = ? ORDER BY created_at, id LIMIT 500`).bind(workspace.id, runId).all(),
      d1.prepare(`SELECT id, job_type, status, attempt, max_attempts, available_at, last_error_code, last_error_message, completed_at, created_at
        FROM fdp_integration_jobs WHERE workspace_id = ? AND run_id = ? ORDER BY created_at`).bind(workspace.id, runId).all(),
    ]);
    return Response.json({ run, items: items.results, jobs: jobs.results });
  } catch (error) { return apiError(error); }
}
