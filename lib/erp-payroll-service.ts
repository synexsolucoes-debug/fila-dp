import { ApiError } from "./api-errors.ts";
import { requireCompanyAccess } from "./fila-dp-db";
import type { WorkspaceRole } from "./fila-dp-types";
import { remunerationFromRow, type Remuneration } from "./remuneration.ts";

/**
 * ERP DP: as leituras do cálculo de folha (o colaborador, a remuneração com
 * vigência e o contrato) e a tradução dos erros das regras puras para a API.
 */

const day = (value: unknown) => value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : null;

export type PayrollEmployee = {
  id: string;
  fullName: string;
  registrationNumber: string;
  companyId: string;
  admissionDate: string;
  terminationDate: string | null;
  employmentStatus: string;
  employmentType: string;
};

export async function payrollEmployee(
  d1: SqlDatabase, workspaceId: string, userId: string, role: WorkspaceRole, employeeId: string,
): Promise<PayrollEmployee> {
  const row = await d1.prepare(`SELECT id, full_name, registration_number, company_id, admission_date, termination_date, employment_status, employment_type
      FROM fdp_employees WHERE workspace_id = ? AND id = ?`).bind(workspaceId, employeeId).first<Record<string, unknown>>();
  if (!row) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
  await requireCompanyAccess(d1, workspaceId, userId, role, String(row.company_id));
  return {
    id: String(row.id),
    fullName: String(row.full_name ?? ""),
    registrationNumber: String(row.registration_number ?? ""),
    companyId: String(row.company_id),
    admissionDate: day(row.admission_date) ?? "",
    terminationDate: day(row.termination_date),
    employmentStatus: String(row.employment_status ?? "active"),
    employmentType: String(row.employment_type ?? "clt"),
  };
}

export async function remunerationRecords(d1: SqlDatabase, workspaceId: string, employeeId: string): Promise<Remuneration[]> {
  const rows = await d1.prepare(`SELECT * FROM fdp_employee_remuneration WHERE workspace_id = ? AND employee_id = ? ORDER BY valid_from DESC`)
    .bind(workspaceId, employeeId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(remunerationFromRow);
}

export async function contractEndOf(d1: SqlDatabase, workspaceId: string, employeeId: string) {
  const row = await d1.prepare("SELECT contract_end FROM fdp_employee_contract_terms WHERE workspace_id = ? AND employee_id = ?")
    .bind(workspaceId, employeeId).first<Record<string, unknown>>();
  return day(row?.contract_end);
}

/**
 * As regras puras lançam `Error` com `code` (elas também rodam no navegador e
 * não podem puxar o `ApiError` do servidor). Aqui viram 400 com o mesmo código.
 */
export function asBadRequest<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && !(error instanceof ApiError)) throw ApiError.badRequest((error as Error).message, code);
    throw error;
  }
}
