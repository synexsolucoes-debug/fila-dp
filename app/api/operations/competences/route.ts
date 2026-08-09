import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";

const defaultItems = [
  ["pre_closing", "inputs", "Conferir movimentações da competência"],
  ["pre_closing", "approvals", "Validar aprovações pendentes"],
  ["pre_closing", "payroll", "Conferir prévia da folha"],
  ["post_closing", "reconciliation", "Conciliar pagamentos e encargos"],
  ["post_closing", "reporting", "Arquivar relatórios e evidências"],
  ["post_closing", "review", "Revisar variações da competência"],
] as const;

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "competences.read");
    const companyId = cleanText(new URL(request.url).searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const result = await d1.prepare("SELECT * FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? ORDER BY competence DESC LIMIT 60").bind(workspace.id, companyId).all();
    return Response.json({ competences: result.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "competences.manage");
    const companyId = cleanText(body.companyId, 120);
    const competence = validCompetence(body.competence);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    if (await d1.prepare("SELECT id FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND competence = ?").bind(workspace.id, companyId, competence).first()) {
      throw new ApiError(409, "COMPETENCE_CONFLICT", "Esta competência já existe para a empresa.");
    }
    const id = crypto.randomUUID();
    const cycle = { id, companyId, competence, status: "open", preClosingDueDate: optionalDate(body.preClosingDueDate), paymentDate: optionalDate(body.paymentDate), postClosingDueDate: optionalDate(body.postClosingDueDate), notes: cleanText(body.notes, 1000) };
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, pre_closing_due_date, payment_date, post_closing_due_date, notes, created_by)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`).bind(id, workspace.id, companyId, competence, cycle.preClosingDueDate, cycle.paymentDate, cycle.postClosingDueDate, cycle.notes, user.id),
      ...defaultItems.map(([phase, category, title], index) => d1.prepare(`INSERT INTO fdp_payroll_cycle_items
        (id, workspace_id, company_id, payroll_cycle_id, phase, category, title, status, position) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .bind(crypto.randomUUID(), workspace.id, companyId, id, phase, category, title, (index + 1) * 1000)),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "competence.created", entityType: "payroll_cycle", entityId: id, after: cycle, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ competence: cycle }, { status: 201 });
  } catch (error) { return apiError(error); }
}
