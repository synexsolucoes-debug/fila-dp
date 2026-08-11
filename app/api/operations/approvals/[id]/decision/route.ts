import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "approvals.decide");
    const approval = await d1.prepare(`SELECT a.*, m.company_id, m.requested_by, m.movement_type, m.status AS movement_status
      FROM fdp_movement_approval_steps a JOIN fdp_employee_movements m ON m.workspace_id = a.workspace_id AND m.id = a.movement_id
      WHERE a.workspace_id = ? AND a.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!approval) throw ApiError.notFound("Aprovação não encontrada.", "APPROVAL_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(approval.company_id));
    if (approval.approver_user_id !== user.id) throw ApiError.forbidden("Esta aprovação está atribuída a outro responsável.", "APPROVAL_NOT_ASSIGNED");
    if (approval.status !== "pending" || approval.movement_status !== "pending_approval") throw ApiError.badRequest("A aprovação já foi decidida.", "APPROVAL_ALREADY_DECIDED");
    if (["salary_change", "termination"].includes(String(approval.movement_type)) && approval.requested_by === user.id) throw ApiError.forbidden("Autoaprovação não é permitida para movimentações sensíveis.", "SELF_APPROVAL_FORBIDDEN");
    const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : "";
    if (!decision) throw ApiError.badRequest("Decisão inválida.", "INVALID_APPROVAL_DECISION");
    const comment = cleanText(body.comment, 1000);
    if (decision === "rejected" && !comment) throw ApiError.badRequest("Informe o motivo da rejeição.", "REJECTION_COMMENT_REQUIRED");
    const decided = await d1.prepare(`WITH decided_approval AS (
        UPDATE fdp_movement_approval_steps a
        SET status = ?, decided_at = CURRENT_TIMESTAMP, comment = ?
        WHERE a.workspace_id = ? AND a.id = ? AND a.status = 'pending'
          AND EXISTS (
            SELECT 1 FROM fdp_employee_movements current_movement
            WHERE current_movement.workspace_id = a.workspace_id
              AND current_movement.id = a.movement_id
              AND current_movement.status = 'pending_approval'
          )
        RETURNING a.movement_id, a.decided_at
      ), updated_movement AS (
        UPDATE fdp_employee_movements m
        SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_comment = ?, updated_at = CURRENT_TIMESTAMP
        FROM decided_approval decided
        WHERE m.workspace_id = ? AND m.id = decided.movement_id AND m.status = 'pending_approval'
        RETURNING m.id, m.status, decided.decided_at
      ), audited AS (
        INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
        SELECT ?, ?, ?, ?, ?, 'movement_approval', ?, ?::jsonb,
          jsonb_build_object('status', status, 'movementId', id), ?::jsonb, ?
        FROM updated_movement
      ) SELECT * FROM updated_movement`)
      .bind(decision, comment, workspace.id, id, decision, user.id, comment, workspace.id,
        crypto.randomUUID(), workspace.id, user.id, auth.user.email, `approval.${decision}`, id,
        JSON.stringify({ status: approval.status }), JSON.stringify({ commentProvided: Boolean(comment) }), request.headers.get("x-fila-dp-request-id"))
      .first<{ id: string; status: string; decided_at: string }>();
    if (!decided) throw new ApiError(409, "APPROVAL_ALREADY_DECIDED", "A aprovação já foi decidida por outra solicitação.");
    return Response.json({ approval: { id, status: decision, decidedAt: decided.decided_at }, movement: { id: decided.id, status: decided.status } });
  } catch (error) { return apiError(error); }
}
