import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { auxiliaryCapability, parseAuxiliaryModule } from "@/lib/auxiliary";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "auxiliary.close");
    const current = await d1.prepare(`SELECT e.*, r.status AS revision_status
      FROM fdp_auxiliary_executions e JOIN fdp_auxiliary_execution_revisions r ON r.workspace_id = e.workspace_id AND r.execution_id = e.id AND r.revision = e.current_revision
      WHERE e.workspace_id = ? AND e.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Lançamento auxiliar não encontrado.", "AUXILIARY_EXECUTION_NOT_FOUND");
    const moduleType = parseAuxiliaryModule(current.module_type); requireCapability(workspace, auxiliaryCapability(moduleType, "manage"));
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    if (current.status !== "approved" || current.revision_status !== "approved") throw ApiError.badRequest("Somente um lançamento aprovado pode ser fechado.", "AUXILIARY_NOT_APPROVED");
    const closed = await d1.prepare(`WITH updated AS (
        UPDATE fdp_auxiliary_executions SET status = 'closed', closed_by = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ? AND status = 'approved'
          AND EXISTS (SELECT 1 FROM fdp_auxiliary_execution_revisions revision WHERE revision.workspace_id = ? AND revision.execution_id = ? AND revision.revision = current_revision AND revision.status = 'approved')
        RETURNING *
      ), audited AS (
        INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, request_id)
        SELECT ?, workspace_id, ?, ?, 'auxiliary_execution.closed', 'auxiliary_execution', id, ?::jsonb,
          jsonb_build_object('status', status, 'closedAt', closed_at), ? FROM updated
      ) SELECT * FROM updated`)
      .bind(user.id, workspace.id, id, workspace.id, id, crypto.randomUUID(), user.id, auth.user.email,
        JSON.stringify({ status: current.status }), request.headers.get("x-fila-dp-request-id"))
      .first<Record<string, unknown>>();
    if (!closed) throw new ApiError(409, "AUXILIARY_CLOSE_CONFLICT", "O lançamento foi alterado por outra solicitação.");
    return Response.json({ execution: closed });
  } catch (error) { return apiError(error); }
}
