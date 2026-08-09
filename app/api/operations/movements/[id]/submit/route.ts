import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace.role, "approvals.request");
    const movement = await d1.prepare("SELECT * FROM fdp_employee_movements WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!movement) throw ApiError.notFound("Movimentação não encontrada.", "MOVEMENT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(movement.company_id));
    if (!["draft", "rejected"].includes(String(movement.status))) throw ApiError.badRequest("A movimentação não pode ser enviada neste estado.", "MOVEMENT_NOT_SUBMITTABLE");
    const approverUserId = cleanText(body.approverUserId, 120);
    if (!approverUserId) throw ApiError.badRequest("Selecione um aprovador.", "APPROVER_REQUIRED");
    const approver = await d1.prepare(`SELECT wm.role,
      EXISTS (SELECT 1 FROM fdp_member_company_access mca WHERE mca.workspace_id = wm.workspace_id AND mca.user_id = wm.user_id AND mca.company_id = ?) AS company_access
      FROM fdp_workspace_members wm WHERE wm.workspace_id = ? AND wm.user_id = ?`).bind(movement.company_id, workspace.id, approverUserId).first<{ role: string; company_access: boolean }>();
    if (!approver || (approver.role !== "admin" && !approver.company_access)) throw ApiError.badRequest("O aprovador não possui acesso à empresa.", "INVALID_APPROVER");
    if (["salary_change", "termination"].includes(String(movement.movement_type)) && approverUserId === movement.requested_by) {
      throw ApiError.badRequest("Movimentações sensíveis exigem aprovador diferente do solicitante.", "SELF_APPROVAL_FORBIDDEN");
    }
    const sequenceRow = await d1.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM fdp_movement_approval_steps WHERE workspace_id = ? AND movement_id = ?").bind(workspace.id, id).first<{ next_sequence: number }>();
    const approvalId = crypto.randomUUID(); const sequence = Number(sequenceRow?.next_sequence ?? 1);
    await d1.batch([
      d1.prepare("UPDATE fdp_employee_movements SET status = 'pending_approval', decision_comment = '', decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?").bind(workspace.id, id),
      d1.prepare("INSERT INTO fdp_movement_approval_steps (id, workspace_id, movement_id, sequence, approver_user_id, status) VALUES (?, ?, ?, ?, ?, 'pending')")
        .bind(approvalId, workspace.id, id, sequence, approverUserId),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "movement.submitted", entityType: "employee_movement", entityId: id,
        before: { status: movement.status }, after: { status: "pending_approval", approvalId, approverUserId, sequence }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ movement: { id, status: "pending_approval" }, approval: { id: approvalId, sequence, approverUserId, status: "pending" } });
  } catch (error) { return apiError(error); }
}
