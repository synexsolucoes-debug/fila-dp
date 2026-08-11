import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "processes.publish");
    const version = await d1.prepare("SELECT * FROM fdp_process_versions WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!version) throw ApiError.notFound("Versão não encontrada.", "PROCESS_VERSION_NOT_FOUND"); if (version.status !== "draft") throw ApiError.badRequest("Somente uma versão em rascunho pode ser publicada.", "PROCESS_VERSION_NOT_DRAFT");
    const configuration = version.configuration_json as Record<string, unknown>; if (!Array.isArray(configuration.steps) || configuration.steps.length === 0) throw ApiError.badRequest("Inclua ao menos uma etapa antes de publicar.", "PROCESS_STEPS_REQUIRED");
    await d1.batch([
      d1.prepare("UPDATE fdp_process_versions SET status = 'retired' WHERE workspace_id = ? AND definition_id = ? AND status = 'published'").bind(workspace.id, version.definition_id),
      d1.prepare("UPDATE fdp_process_versions SET status = 'published', published_at = CURRENT_TIMESTAMP, published_by = ? WHERE workspace_id = ? AND id = ? AND status = 'draft'").bind(user.id, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "process.version_published", entityType: "process_version", entityId: id,
        before: { status: "draft" }, after: { status: "published", definitionId: version.definition_id, version: version.version }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ version: { id, definitionId: version.definition_id, version: version.version, status: "published" } });
  } catch (error) { return apiError(error); }
}
