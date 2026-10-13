import { ApiError } from "./api-errors.ts";
import type { DocumentCompany, DocumentEmployee } from "./payroll-documents-pdf.ts";

/**
 * Quem aparece nos documentos da folha: a empresa (razão social, CNPJ e
 * cidade) e o colaborador (matrícula, nome, cargo, departamento, admissão e
 * só os 4 últimos dígitos do CPF — o Vinculato não guarda o CPF inteiro).
 */

const day = (value: unknown) => value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : "";

export async function documentCompany(d1: SqlDatabase, workspaceId: string, companyId: string): Promise<DocumentCompany> {
  const row = await d1.prepare("SELECT legal_name, tax_id, city, state FROM fdp_companies WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, companyId).first<Record<string, unknown>>();
  if (!row) throw ApiError.notFound("Empresa não encontrada.", "COMPANY_NOT_FOUND");
  return { legalName: String(row.legal_name ?? ""), taxId: String(row.tax_id ?? ""), city: String(row.city ?? ""), state: String(row.state ?? "") };
}

export async function documentEmployees(d1: SqlDatabase, workspaceId: string, employeeIds: readonly string[]) {
  const map = new Map<string, DocumentEmployee & { companyId: string }>();
  if (!employeeIds.length) return map;
  const rows = await d1.prepare(`SELECT e.id, e.company_id, e.full_name, e.social_name, e.registration_number, e.admission_date, e.cpf_last4,
        p.name AS position_name, d.name AS department_name
      FROM fdp_employees e
      LEFT JOIN fdp_positions p ON p.workspace_id = e.workspace_id AND p.id = e.position_id
      LEFT JOIN fdp_departments d ON d.workspace_id = e.workspace_id AND d.id = e.department_id
      WHERE e.workspace_id = ? AND e.id IN (${employeeIds.map(() => "?").join(", ")})`)
    .bind(workspaceId, ...employeeIds).all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    map.set(String(row.id), {
      companyId: String(row.company_id),
      name: String(row.social_name || row.full_name || ""),
      registrationNumber: String(row.registration_number ?? ""),
      position: String(row.position_name ?? ""),
      department: String(row.department_name ?? ""),
      admissionDate: day(row.admission_date),
      cpfLast4: String(row.cpf_last4 ?? ""),
    });
  }
  return map;
}

export function pdfResponse(pdf: Uint8Array, filename: string) {
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]+/gu, "-")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
