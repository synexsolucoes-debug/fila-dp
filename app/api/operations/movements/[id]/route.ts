import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { enumOr, movementTypes, sanitizeMovementDetails, validRequiredDate } from "@/lib/operations";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "movements.read");
    const movement = await d1.prepare(`SELECT m.*, e.full_name AS employee_name, e.social_name, c.legal_name AS company_name
      FROM fdp_employee_movements m JOIN fdp_employees e ON e.workspace_id = m.workspace_id AND e.id = m.employee_id
      JOIN fdp_companies c ON c.workspace_id = m.workspace_id AND c.id = m.company_id WHERE m.workspace_id = ? AND m.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!movement) throw ApiError.notFound("Movimentação não encontrada.", "MOVEMENT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(movement.company_id));
    const approvals = await d1.prepare("SELECT id, sequence, approver_user_id, status, decided_at, comment, created_at FROM fdp_movement_approval_steps WHERE workspace_id = ? AND movement_id = ? ORDER BY sequence").bind(workspace.id, id).all();
    return Response.json({ movement, approvals: approvals.results });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, context: Context) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params; const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "movements.manage");
    const current = await d1.prepare("SELECT * FROM fdp_employee_movements WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Movimentação não encontrada.", "MOVEMENT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    if (!["draft", "rejected"].includes(String(current.status))) throw ApiError.badRequest("Somente rascunhos ou rejeitadas podem ser editadas.", "MOVEMENT_NOT_EDITABLE");
    const movementType = enumOr(body.movementType, movementTypes, current.movement_type as typeof movementTypes[number]);
    const next = { title: cleanText(body.title, 180) || String(current.title), movementType,
      effectiveDate: Object.hasOwn(body, "effectiveDate") ? validRequiredDate(body.effectiveDate) : String(current.effective_date),
      details: Object.hasOwn(body, "details") ? sanitizeMovementDetails(movementType, body.details) : current.details_json };
    await d1.batch([
      d1.prepare("UPDATE fdp_employee_movements SET title = ?, movement_type = ?, effective_date = ?, details_json = ?::jsonb, status = 'draft', decision_comment = '', decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(next.title, next.movementType, next.effectiveDate, JSON.stringify(next.details), workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "movement.updated", entityType: "employee_movement", entityId: id,
        before: { title: current.title, movementType: current.movement_type, effectiveDate: current.effective_date, status: current.status }, after: { title: next.title, movementType: next.movementType, effectiveDate: next.effectiveDate, status: "draft" },
        metadata: { detailKeys: Object.keys(next.details as Record<string, unknown>) }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ movement: { id, ...next, status: "draft" } });
  } catch (error) { return apiError(error); }
}
