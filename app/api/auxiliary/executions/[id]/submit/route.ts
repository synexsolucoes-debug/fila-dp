import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { auxiliaryCapability, parseAuxiliaryModule } from "@/lib/auxiliary";
import { cleanText } from "@/lib/registrations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "auxiliary.approvals.request");
    const current = await d1.prepare(`SELECT e.*, r.id AS revision_id, r.status AS revision_status
      FROM fdp_auxiliary_executions e JOIN fdp_auxiliary_execution_revisions r ON r.workspace_id = e.workspace_id AND r.execution_id = e.id AND r.revision = e.current_revision
      WHERE e.workspace_id = ? AND e.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Lançamento auxiliar não encontrado.", "AUXILIARY_EXECUTION_NOT_FOUND");
    const moduleType = parseAuxiliaryModule(current.module_type); requireCapability(workspace, auxiliaryCapability(moduleType, "manage"));
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    if (current.status !== "draft" || current.revision_status !== "draft") throw ApiError.badRequest("O lançamento não pode ser enviado neste estado.", "AUXILIARY_NOT_SUBMITTABLE");
    const approverUserId = cleanText(body.approverUserId, 120); if (!approverUserId) throw ApiError.badRequest("Selecione um aprovador.", "APPROVER_REQUIRED");
    const approver = await d1.prepare(`SELECT wm.role, EXISTS (
      SELECT 1 FROM fdp_member_company_access access WHERE access.workspace_id = wm.workspace_id AND access.user_id = wm.user_id AND access.company_id = ?
    ) AS company_access FROM fdp_workspace_members wm WHERE wm.workspace_id = ? AND wm.user_id = ?`)
      .bind(current.company_id, workspace.id, approverUserId).first<{ role: string; company_access: boolean }>();
    if (!approver || (approver.role !== "admin" && !approver.company_access)) throw ApiError.badRequest("O aprovador não possui acesso à empresa.", "INVALID_APPROVER");
    if (approverUserId === current.created_by) throw ApiError.badRequest("O responsável pelo lançamento não pode aprovar a própria entrega.", "SELF_APPROVAL_FORBIDDEN");
    const approvalId = crypto.randomUUID();
    const submitted = await d1.prepare(`WITH submitted_revision AS (
        UPDATE fdp_auxiliary_execution_revisions revision SET status = 'submitted'
        WHERE revision.workspace_id = ? AND revision.id = ? AND revision.execution_id = ? AND revision.status = 'draft'
          AND EXISTS (
            SELECT 1 FROM fdp_auxiliary_executions execution
            WHERE execution.workspace_id = revision.workspace_id AND execution.id = revision.execution_id
              AND execution.status = 'draft' AND execution.current_revision = revision.revision
          )
        RETURNING id, revision
      ), updated_execution AS (
        UPDATE fdp_auxiliary_executions e SET status = 'pending_approval', updated_at = CURRENT_TIMESTAMP
        FROM submitted_revision revision
        WHERE e.workspace_id = ? AND e.id = ? AND e.status = 'draft' AND e.current_revision = revision.revision
        RETURNING e.id, e.module_type, e.current_revision, revision.id AS revision_id
      ), inserted_approval AS (
        INSERT INTO fdp_auxiliary_approval_steps (id, workspace_id, execution_id, revision_id, sequence, approver_user_id, status)
        SELECT ?, ?, id, revision_id, 1, ?, 'pending' FROM updated_execution
        RETURNING id, execution_id, revision_id, approver_user_id, status
      ), audited AS (
        INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
        SELECT ?, ?, ?, ?, 'auxiliary_execution.submitted', 'auxiliary_execution', execution_id,
          ?::jsonb, jsonb_build_object('status', 'pending_approval', 'revisionId', revision_id),
          jsonb_build_object('approvalId', id, 'approverUserId', approver_user_id), ? FROM inserted_approval
      ) SELECT * FROM inserted_approval`)
      .bind(workspace.id, current.revision_id, id, workspace.id, id, approvalId, workspace.id, approverUserId,
        crypto.randomUUID(), workspace.id, user.id, auth.user.email, JSON.stringify({ status: current.status }), request.headers.get("x-fila-dp-request-id"))
      .first<Record<string, unknown>>();
    if (!submitted) throw new ApiError(409, "AUXILIARY_SUBMIT_CONFLICT", "O lançamento foi alterado por outra solicitação.");
    return Response.json({ execution: { id, status: "pending_approval", currentRevision: Number(current.current_revision) }, approval: submitted });
  } catch (error) { return apiError(error); }
}
