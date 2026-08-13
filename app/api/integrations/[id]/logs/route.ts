import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { requireSankhyaWorkspaceEnabled } from "@/lib/sankhya/queue";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.logs.view");
    await requireSankhyaWorkspaceEnabled(d1, workspace.id);
    const integration = await d1.prepare("SELECT 1 FROM fdp_integrations WHERE workspace_id = ? AND id = ? AND channel = 'sankhya_browser'")
      .bind(workspace.id, id).first();
    if (!integration) throw ApiError.notFound("Integração Sankhya não encontrada.", "SANKHYA_INTEGRATION_NOT_FOUND");
    const url = new URL(request.url);
    const runId = (url.searchParams.get("runId") ?? "").trim().slice(0, 120);
    const logs = await d1.prepare(`SELECT log.id, log.run_id, log.sequence, log.level, log.phase, log.code, log.message, log.metadata_json, log.created_at
      FROM fdp_integration_run_logs log
      WHERE log.workspace_id = ? AND log.integration_id = ? AND (? = '' OR log.run_id = ?)
      ORDER BY log.created_at DESC, log.sequence DESC LIMIT 300`).bind(workspace.id, id, runId, runId).all();
    const diagnostics = await d1.prepare(`SELECT id, run_id, kind, expires_at, created_at FROM fdp_integration_diagnostics
      WHERE workspace_id = ? AND integration_id = ? AND expires_at > CURRENT_TIMESTAMP AND (? = '' OR run_id = ?)
      ORDER BY created_at DESC LIMIT 20`).bind(workspace.id, id, runId, runId).all();
    return Response.json({ logs: logs.results, diagnostics: diagnostics.results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
