import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { contractDeadlines, contractTermsFromRow, parseContractTermsInput } from "@/lib/contract-terms";

type RouteContext = { params: Promise<{ id: string }> };

async function employeeOf(d1: SqlDatabase, workspaceId: string, id: string) {
  const employee = await d1.prepare("SELECT id, company_id, admission_date FROM fdp_employees WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, id).first<Record<string, unknown>>();
  if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
  return {
    companyId: String(employee.company_id),
    admissionDate: String(employee.admission_date instanceof Date ? employee.admission_date.toISOString() : employee.admission_date).slice(0, 10),
  };
}

/**
 * Elementos contratuais do colaborador (ERP DP, passo 3 — IT0016 + IT0019 do
 * SAP): tipo de contrato, fim da experiência ou do prazo determinado e aviso
 * prévio, com os prazos que o DP precisa decidir. Só datas.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const employee = await employeeOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, employee.companyId);
    const row = await d1.prepare("SELECT * FROM fdp_employee_contract_terms WHERE workspace_id = ? AND employee_id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    const terms = row ? contractTermsFromRow(row) : null;
    return Response.json({ admissionDate: employee.admissionDate, terms, deadlines: terms ? contractDeadlines(terms) : [] });
  } catch (error) { return apiError(error); }
}

/** Grava o contrato vigente inteiro: um registro por colaborador, com trilha na auditoria. */
export async function PUT(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.manage");
    const employee = await employeeOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, employee.companyId);
    const input = parseContractTermsInput(body, employee.admissionDate);
    const before = await d1.prepare("SELECT * FROM fdp_employee_contract_terms WHERE workspace_id = ? AND employee_id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_employee_contract_terms
          (id, workspace_id, employee_id, contract_kind, experience_first_end, contract_end, notice_kind, notice_start, notice_days, notice_end, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?::date, ?::date, ?, ?::date, ?, ?::date, ?, ?, ?)
        ON CONFLICT (workspace_id, employee_id) DO UPDATE SET contract_kind = EXCLUDED.contract_kind,
          experience_first_end = EXCLUDED.experience_first_end, contract_end = EXCLUDED.contract_end,
          notice_kind = EXCLUDED.notice_kind, notice_start = EXCLUDED.notice_start, notice_days = EXCLUDED.notice_days,
          notice_end = EXCLUDED.notice_end, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`)
        .bind(crypto.randomUUID(), workspace.id, id, input.contractKind, input.experienceFirstEnd, input.contractEnd,
          input.noticeKind, input.noticeStart, input.noticeDays, input.noticeEnd, input.notes, user.id, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "employee.contract_terms.updated", entityType: "employee", entityId: id,
        before: before ? contractTermsFromRow(before) : null,
        after: input,
        metadata: { scope: "company", companyId: employee.companyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ terms: input, deadlines: contractDeadlines(input) });
  } catch (error) { return apiError(error); }
}
