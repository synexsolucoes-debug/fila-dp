import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace.role, "pending_items.read");
    const url = new URL(request.url); const companyId = cleanText(url.searchParams.get("companyId"), 120); const cycleId = cleanText(url.searchParams.get("competenceId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED"); await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const result = await d1.prepare(`SELECT * FROM fdp_operational_pending_items WHERE workspace_id = ? AND company_id = ? ${cycleId ? "AND payroll_cycle_id = ?" : ""} ORDER BY blocking DESC, due_date, created_at`)
      .bind(workspace.id, companyId, ...(cycleId ? [cycleId] : [])).all(); return Response.json({ pendingItems: result.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace.role, "pending_items.manage");
    const companyId = cleanText(body.companyId, 120); const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120); const title = cleanText(body.title, 180);
    const sourceType = ["movement", "approval", "obligation", "cycle", "card"].includes(String(body.sourceType)) ? String(body.sourceType) : "cycle"; const sourceId = cleanText(body.sourceId, 120) || cycleId;
    if (!companyId || !cycleId || !title || !sourceId) throw ApiError.badRequest("Empresa, competência e título são obrigatórios.", "PENDING_ITEM_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId); if (!await d1.prepare("SELECT id FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND id = ?").bind(workspace.id, companyId, cycleId).first()) throw ApiError.badRequest("Competência inválida.", "INVALID_PENDING_COMPETENCE");
    const idempotencyKey = cleanText(body.idempotencyKey, 200) || `${sourceType}:${sourceId}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`;
    const existing = await d1.prepare("SELECT * FROM fdp_operational_pending_items WHERE workspace_id = ? AND idempotency_key = ?").bind(workspace.id, idempotencyKey).first<Record<string, unknown>>();
    if (existing) return Response.json({ pendingItem: existing, idempotent: true });
    const id = crypto.randomUUID(); const item = { id, companyId, payrollCycleId: cycleId, sourceType, sourceId, severity: ["info", "warning", "critical"].includes(String(body.severity)) ? String(body.severity) : "warning", blocking: body.blocking === true, title, dueDate: optionalDate(body.dueDate), status: "open", ownerUserId: cleanText(body.ownerUserId, 120) || null, idempotencyKey };
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_operational_pending_items (id, workspace_id, company_id, payroll_cycle_id, source_type, source_id, severity, blocking, title, due_date, status, owner_user_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).bind(id, workspace.id, companyId, cycleId, sourceType, sourceId, item.severity, item.blocking ? 1 : 0, title, item.dueDate, item.ownerUserId, idempotencyKey),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "pending_item.created", entityType: "operational_pending_item", entityId: id, after: item, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ pendingItem: item, idempotent: false }, { status: 201 });
  } catch (error) { return apiError(error); }
}
