import { ApiError } from "./api-errors.ts";
import { requireCompanyAccess } from "./fila-dp-db";
import type { WorkspaceRole } from "./fila-dp-types";
import { runFromRow, runResults } from "./payroll-run-service.ts";
import { companySettings } from "./payroll-settings-service.ts";

/** A folha com o que as obrigações precisam: resultados, empresa e configuração. */
export async function runForObligations(d1: SqlDatabase, workspace: { id: string; role: WorkspaceRole }, userId: string, runId: string) {
  const row = await d1.prepare("SELECT * FROM fdp_payroll_runs WHERE workspace_id = ? AND id = ?").bind(workspace.id, runId).first<Record<string, unknown>>();
  if (!row) throw ApiError.notFound("Folha não encontrada.", "PAYROLL_RUN_NOT_FOUND");
  const run = runFromRow(row);
  await requireCompanyAccess(d1, workspace.id, userId, workspace.role, run.companyId);
  const results = await runResults(d1, workspace.id, run.id);
  const settings = await companySettings(d1, workspace.id, run.companyId);
  const company = await d1.prepare("SELECT legal_name, tax_id FROM fdp_companies WHERE workspace_id = ? AND id = ?")
    .bind(workspace.id, run.companyId).first<{ legal_name: string; tax_id: string }>();
  return { run, results, settings, company: { name: String(company?.legal_name ?? ""), taxId: String(company?.tax_id ?? "") } };
}
