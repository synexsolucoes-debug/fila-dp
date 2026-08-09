import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace.role, "competences.manage");
    const companyId = cleanText(body.companyId, 120); const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120); const title = cleanText(body.title, 180);
    const phase = body.phase === "post_closing" ? "post_closing" : "pre_closing"; if (!companyId || !cycleId || !title) throw ApiError.badRequest("Empresa, competência e título são obrigatórios.", "CLOSING_ITEM_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId); if (!await d1.prepare("SELECT id FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND id = ?").bind(workspace.id, companyId, cycleId).first()) throw ApiError.badRequest("Competência inválida.", "INVALID_CLOSING_COMPETENCE");
    const id = crypto.randomUUID(); const item = { id, companyId, payrollCycleId: cycleId, phase, category: cleanText(body.category, 60) || "general", title, status: "pending", ownerUserId: cleanText(body.ownerUserId, 120) || null, dueDate: optionalDate(body.dueDate), notes: cleanText(body.notes, 1000) };
    const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) + 1000 AS value FROM fdp_payroll_cycle_items WHERE workspace_id = ? AND payroll_cycle_id = ? AND phase = ?").bind(workspace.id, cycleId, phase).first<{ value: number }>();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_payroll_cycle_items (id, workspace_id, company_id, payroll_cycle_id, phase, category, title, status, owner_user_id, due_date, notes, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).bind(id, workspace.id, companyId, cycleId, phase, item.category, title, item.ownerUserId, item.dueDate, item.notes, Number(position?.value ?? 1000)),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "closing_item.created", entityType: "payroll_cycle_item", entityId: id, after: item, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ item }, { status: 201 });
  } catch (error) { return apiError(error); }
}
