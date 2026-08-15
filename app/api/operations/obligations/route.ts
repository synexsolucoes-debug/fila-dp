import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { enumOr, obligationTypes, validEvidenceUrl, validRequiredDate } from "@/lib/operations";

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "obligations.read");
    const url = new URL(request.url); const companyId = cleanText(url.searchParams.get("companyId"), 120); const cycleId = cleanText(url.searchParams.get("competenceId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED"); await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const result = await d1.prepare(`SELECT * FROM fdp_compliance_obligations WHERE workspace_id = ? AND company_id = ? ${cycleId ? "AND payroll_cycle_id = ?" : ""} ORDER BY due_date, title`)
      .bind(workspace.id, companyId, ...(cycleId ? [cycleId] : [])).all(); return Response.json({ obligations: result.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "obligations.manage");
    const companyId = cleanText(body.companyId, 120); const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120); const title = cleanText(body.title, 180); const dueDate = validRequiredDate(body.dueDate);
    if (!companyId || !cycleId || !title) throw ApiError.badRequest("Empresa, competência, título e prazo são obrigatórios.", "OBLIGATION_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    if (!await d1.prepare("SELECT id FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND id = ?").bind(workspace.id, companyId, cycleId).first()) throw ApiError.badRequest("Competência inválida.", "INVALID_OBLIGATION_COMPETENCE");
    const id = crypto.randomUUID(); const recurrenceKey = cleanText(body.recurrenceKey, 180); const obligation = { id, companyId, payrollCycleId: cycleId, obligationType: enumOr(body.obligationType, obligationTypes, "other"), title, dueDate, status: "open", ownerUserId: cleanText(body.ownerUserId, 120) || null, cardId: cleanText(body.cardId, 120) || null, notes: cleanText(body.notes, 1000), recurrenceKey,
      protocol: cleanText(body.protocol, 120), evidenceUrl: validEvidenceUrl(body.evidenceUrl) };
    if (recurrenceKey && await d1.prepare("SELECT id FROM fdp_compliance_obligations WHERE workspace_id = ? AND recurrence_key = ?").bind(workspace.id, recurrenceKey).first()) throw new ApiError(409, "OBLIGATION_IDEMPOTENCY_CONFLICT", "Esta obrigação já foi gerada.");
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_compliance_obligations (id, workspace_id, company_id, payroll_cycle_id, card_id, obligation_type, title, due_date, status, owner_user_id, recurrence_key, notes, protocol, evidence_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`).bind(id, workspace.id, companyId, cycleId, obligation.cardId, obligation.obligationType, title, dueDate, obligation.ownerUserId, recurrenceKey, obligation.notes, obligation.protocol, obligation.evidenceUrl),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "obligation.created", entityType: "compliance_obligation", entityId: id, after: obligation, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ obligation }, { status: 201 });
  } catch (error) { return apiError(error); }
}
