import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { auxiliaryCapability, parseAuxiliaryModule, sanitizeAuxiliaryPayload } from "@/lib/auxiliary";

function jsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { return {}; } }
  return {};
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const current = await d1.prepare(`SELECT e.*, r.id AS revision_id, r.input_json, r.output_json, r.status AS revision_status
      FROM fdp_auxiliary_executions e JOIN fdp_auxiliary_execution_revisions r ON r.workspace_id = e.workspace_id AND r.execution_id = e.id AND r.revision = e.current_revision
      WHERE e.workspace_id = ? AND e.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Lançamento auxiliar não encontrado.", "AUXILIARY_EXECUTION_NOT_FOUND");
    const moduleType = parseAuxiliaryModule(current.module_type); requireCapability(workspace, auxiliaryCapability(moduleType, "manage"));
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    if (current.status !== "rejected" || current.revision_status !== "rejected") throw ApiError.badRequest("Uma nova revisão só pode ser criada após rejeição.", "AUXILIARY_REVISION_NOT_ALLOWED");
    const sanitized = sanitizeAuxiliaryPayload(moduleType, body.input ?? jsonObject(current.input_json), body.output ?? jsonObject(current.output_json));
    const nextRevision = Number(current.current_revision) + 1; const revisionId = crypto.randomUUID();
    await d1.batch([
      d1.prepare("UPDATE fdp_auxiliary_execution_revisions SET status = 'superseded' WHERE workspace_id = ? AND id = ? AND status = 'rejected'").bind(workspace.id, current.revision_id),
      d1.prepare(`INSERT INTO fdp_auxiliary_execution_revisions (id, workspace_id, execution_id, revision, input_json, output_json, status, created_by)
        VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, 'draft', ?)`).bind(revisionId, workspace.id, id, nextRevision, JSON.stringify(sanitized.input), JSON.stringify(sanitized.output), user.id),
      d1.prepare("UPDATE fdp_auxiliary_executions SET status = 'draft', current_revision = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND status = 'rejected'").bind(nextRevision, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "auxiliary_revision.created", entityType: "auxiliary_execution", entityId: id,
        before: { status: current.status, revision: Number(current.current_revision) }, after: { status: "draft", revision: nextRevision }, metadata: { inputKeys: Object.keys(sanitized.input), outputKeys: Object.keys(sanitized.output) }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ execution: { id, status: "draft", currentRevision: nextRevision }, revision: { id: revisionId, revision: nextRevision, status: "draft", ...sanitized } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
