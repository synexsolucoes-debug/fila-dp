import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertNoClinicalData, auxiliaryCapability, parseAuxiliaryModule } from "@/lib/auxiliary";
import { cleanText } from "@/lib/registrations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "auxiliary.approvals.decide");
    const approval = await d1.prepare(`SELECT a.*, e.company_id, e.module_type, e.created_by, e.status AS execution_status, r.status AS revision_status
      FROM fdp_auxiliary_approval_steps a
      JOIN fdp_auxiliary_executions e ON e.workspace_id = a.workspace_id AND e.id = a.execution_id
      JOIN fdp_auxiliary_execution_revisions r ON r.workspace_id = a.workspace_id AND r.id = a.revision_id AND r.execution_id = a.execution_id
      WHERE a.workspace_id = ? AND a.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!approval) throw ApiError.notFound("Aprovação auxiliar não encontrada.", "AUXILIARY_APPROVAL_NOT_FOUND");
    const moduleType = parseAuxiliaryModule(approval.module_type); requireCapability(workspace, auxiliaryCapability(moduleType, "read"));
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(approval.company_id));
    if (approval.approver_user_id !== user.id) throw ApiError.forbidden("Esta aprovação está atribuída a outro responsável.", "APPROVAL_NOT_ASSIGNED");
    if (approval.created_by === user.id) throw ApiError.forbidden("Autoaprovação não é permitida.", "SELF_APPROVAL_FORBIDDEN");
    if (approval.status !== "pending" || approval.execution_status !== "pending_approval" || approval.revision_status !== "submitted") throw ApiError.badRequest("A aprovação já foi decidida.", "APPROVAL_ALREADY_DECIDED");
    const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : "";
    if (!decision) throw ApiError.badRequest("Decisão inválida.", "INVALID_APPROVAL_DECISION");
    const comment = cleanText(body.comment, 1000); if (decision === "rejected" && !comment) throw ApiError.badRequest("Informe o motivo da rejeição.", "REJECTION_COMMENT_REQUIRED");
    assertNoClinicalData(moduleType, comment);
    const decided = await d1.prepare(`WITH decided_approval AS (
        UPDATE fdp_auxiliary_approval_steps approval SET status = ?, comment = ?, decided_at = CURRENT_TIMESTAMP
        WHERE approval.workspace_id = ? AND approval.id = ? AND approval.approver_user_id = ? AND approval.status = 'pending'
          AND EXISTS (
            SELECT 1 FROM fdp_auxiliary_executions execution
            JOIN fdp_auxiliary_execution_revisions revision ON revision.workspace_id = execution.workspace_id AND revision.execution_id = execution.id
            WHERE execution.workspace_id = approval.workspace_id AND execution.id = approval.execution_id
              AND revision.id = approval.revision_id AND execution.status = 'pending_approval' AND revision.status = 'submitted'
          )
        RETURNING execution_id, revision_id, decided_at
      ), decided_revision AS (
        UPDATE fdp_auxiliary_execution_revisions revision SET status = ?
        FROM decided_approval approval
        WHERE revision.workspace_id = ? AND revision.id = approval.revision_id AND revision.execution_id = approval.execution_id AND revision.status = 'submitted'
        RETURNING revision.execution_id, revision.id AS revision_id, approval.decided_at
      ), updated_execution AS (
        UPDATE fdp_auxiliary_executions execution SET status = ?, updated_at = CURRENT_TIMESTAMP
        FROM decided_revision revision
        WHERE execution.workspace_id = ? AND execution.id = revision.execution_id AND execution.status = 'pending_approval'
        RETURNING execution.id, execution.status, revision.revision_id, revision.decided_at
      ), audited AS (
        INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
        SELECT ?, ?, ?, ?, ?, 'auxiliary_approval', ?, ?::jsonb,
          jsonb_build_object('status', status, 'executionId', id, 'revisionId', revision_id), ?::jsonb, ?
        FROM updated_execution
      ) SELECT * FROM updated_execution`)
      .bind(decision, comment, workspace.id, id, user.id, decision, workspace.id, decision, workspace.id,
        crypto.randomUUID(), workspace.id, user.id, auth.user.email, `auxiliary_approval.${decision}`, id,
        JSON.stringify({ status: approval.status }), JSON.stringify({ commentProvided: Boolean(comment) }), request.headers.get("x-fila-dp-request-id"))
      .first<Record<string, unknown>>();
    if (!decided) throw new ApiError(409, "APPROVAL_ALREADY_DECIDED", "A aprovação já foi decidida por outra solicitação.");
    return Response.json({ approval: { id, status: decision, decidedAt: decided.decided_at }, execution: { id: decided.id, status: decided.status } });
  } catch (error) { return apiError(error); }
}
