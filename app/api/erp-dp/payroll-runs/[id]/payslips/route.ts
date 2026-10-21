import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { runFromRow, runResults } from "@/lib/payroll-run-service";
import { payslipPdf } from "@/lib/payroll-documents-pdf";
import { documentCompany, documentEmployees, pdfResponse } from "@/lib/payroll-documents-service";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Holerites da folha gravada, em PDF (duas vias por página). Com
 * `employeeId`, o de uma pessoa; sem, o da folha inteira. Fica na auditoria
 * quem baixou: é documento com salário.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const employeeId = new URL(request.url).searchParams.get("employeeId") ?? "";
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    const row = await d1.prepare("SELECT * FROM fdp_payroll_runs WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!row) throw ApiError.notFound("Folha não encontrada.", "PAYROLL_RUN_NOT_FOUND");
    const run = runFromRow(row);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, run.companyId);
    const results = (await runResults(d1, workspace.id, run.id)).filter((result) => !employeeId || result.employeeId === employeeId);
    if (!results.length) throw ApiError.notFound("Nenhum resultado para gerar o holerite.", "PAYSLIP_EMPTY");
    const company = await documentCompany(d1, workspace.id, run.companyId);
    const people = await documentEmployees(d1, workspace.id, results.map((result) => result.employeeId));
    const pdf = payslipPdf(results.map((result) => ({
      company, employee: people.get(result.employeeId) ?? { name: result.name, registrationNumber: result.registrationNumber, position: "", department: "", admissionDate: "", cpfLast4: "" },
      competence: run.competence, salaryCents: result.salaryCents, lines: result.lines,
      earningsCents: result.earningsCents, deductionsCents: result.deductionsCents, fgtsCents: result.fgtsCents,
    })), `Holerites ${run.competence}`);
    await d1.batch([prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "payroll.payslips.downloaded", entityType: "payroll_run", entityId: run.id,
      before: null, after: { competence: run.competence, employees: results.length, run: run.status },
      metadata: { scope: "company", companyId: run.companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
    })]);
    const suffix = employeeId ? `-${results[0].registrationNumber}` : "";
    return pdfResponse(pdf, `holerite-${run.competence}${suffix}.pdf`);
  } catch (error) { return apiError(error); }
}
