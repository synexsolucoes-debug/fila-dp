import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { enumOr, movementTypes, sanitizeMovementDetails, validRequiredDate } from "@/lib/operations";

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "movements.read");
    const url = new URL(request.url); const companyId = cleanText(url.searchParams.get("companyId"), 120); const cycleId = cleanText(url.searchParams.get("competenceId"), 120);
    const status = cleanText(url.searchParams.get("status"), 30); const cursor = cleanText(url.searchParams.get("cursor"), 120); const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 1), 100);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ movements: [], nextCursor: null });
    const where = ["m.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) { const ids = [...access.companyIds]; where.push(`m.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
    if (companyId) { where.push("m.company_id = ?"); values.push(companyId); } if (cycleId) { where.push("m.payroll_cycle_id = ?"); values.push(cycleId); }
    if (["draft", "pending_approval", "approved", "rejected", "applied", "canceled"].includes(status)) { where.push("m.status = ?"); values.push(status); }
    if (cursor) { where.push("m.id > ?"); values.push(cursor); }
    const result = await d1.prepare(`SELECT m.id, m.company_id, m.employee_id, e.full_name AS employee_name, e.social_name, m.payroll_cycle_id, m.card_id,
      m.movement_type, m.effective_date, m.title, m.status, m.requested_by, m.decided_by, m.decided_at, m.decision_comment, m.created_at, m.updated_at
      FROM fdp_employee_movements m JOIN fdp_employees e ON e.workspace_id = m.workspace_id AND e.id = m.employee_id
      WHERE ${where.join(" AND ")} ORDER BY m.id LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit); return Response.json({ movements: rows, nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "movements.manage");
    const companyId = cleanText(body.companyId, 120); const employeeId = cleanText(body.employeeId, 120); const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120) || null;
    const movementType = enumOr(body.movementType, movementTypes, "other"); const title = cleanText(body.title, 180); const effectiveDate = validRequiredDate(body.effectiveDate);
    if (!companyId || !employeeId || !title) throw ApiError.badRequest("Empresa, colaborador, título e vigência são obrigatórios.", "MOVEMENT_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const [employee, cycle] = await Promise.all([
      d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND id = ?").bind(workspace.id, companyId, employeeId).first(),
      cycleId ? d1.prepare("SELECT id, status FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND id = ?").bind(workspace.id, companyId, cycleId).first<{ id: string; status: string }>() : Promise.resolve(null),
    ]);
    if (!employee) throw ApiError.badRequest("Colaborador não pertence à empresa selecionada.", "INVALID_MOVEMENT_EMPLOYEE");
    if (cycleId && !cycle) throw ApiError.badRequest("Competência inválida.", "INVALID_MOVEMENT_COMPETENCE");
    if (cycle?.status === "closed") throw ApiError.badRequest("A competência está fechada.", "COMPETENCE_CLOSED");
    const id = crypto.randomUUID(); const details = sanitizeMovementDetails(movementType, body.details);
    const movement = { id, companyId, employeeId, payrollCycleId: cycleId, cardId: cleanText(body.cardId, 120) || null, movementType, effectiveDate, title, status: "draft" };
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_employee_movements (id, workspace_id, company_id, employee_id, payroll_cycle_id, card_id, movement_type, effective_date, title, details_json, status, requested_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'draft', ?)`)
        .bind(id, workspace.id, companyId, employeeId, cycleId, movement.cardId, movementType, effectiveDate, title, JSON.stringify(details), user.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "movement.created", entityType: "employee_movement", entityId: id,
        after: movement, metadata: { detailKeys: Object.keys(details) }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ movement: { ...movement, details } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
