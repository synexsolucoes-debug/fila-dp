import { apiError } from "@/lib/fila-dp-api";
import { prepareAuditEvent } from "@/lib/fila-dp-db";
import { ApiError } from "@/lib/api-errors";
import { assertEmployeePortalLinkUsable, resolveEmployeePortal } from "@/lib/employee-portal";
import { runFromRow, runResults } from "@/lib/payroll-run-service";
import { payslipPdf } from "@/lib/payroll-documents-pdf";
import { documentCompany, documentEmployees, pdfResponse } from "@/lib/payroll-documents-service";

type Params = { params: Promise<{ token: string }> };

/** O holerite de uma folha fechada, só da própria pessoa do link. */
export async function GET(request: Request, { params }: Params) {
  try {
    const { token } = await params;
    const runId = new URL(request.url).searchParams.get("runId") ?? "";
    const { d1, link } = await resolveEmployeePortal(token, request);
    assertEmployeePortalLinkUsable(link);
    const row = await d1.prepare("SELECT * FROM fdp_payroll_runs WHERE workspace_id = ? AND id = ? AND status = 'closed'")
      .bind(link.workspace_id, runId).first<Record<string, unknown>>();
    if (!row) throw ApiError.notFound("Holerite não encontrado.", "PORTAL_PAYSLIP_NOT_FOUND");
    const run = runFromRow(row);
    const result = (await runResults(d1, link.workspace_id, run.id)).find((item) => item.employeeId === link.employee_id);
    if (!result) throw ApiError.notFound("Holerite não encontrado.", "PORTAL_PAYSLIP_NOT_FOUND");
    const company = await documentCompany(d1, link.workspace_id, run.companyId);
    const person = (await documentEmployees(d1, link.workspace_id, [link.employee_id])).get(link.employee_id);
    const pdf = payslipPdf([{
      company, employee: person ?? { name: result.name, registrationNumber: result.registrationNumber, position: "", department: "", admissionDate: "", cpfLast4: "" },
      competence: run.competence, salaryCents: result.salaryCents, lines: result.lines,
      earningsCents: result.earningsCents, deductionsCents: result.deductionsCents, fgtsCents: result.fgtsCents,
    }], `Holerite ${run.competence}`);
    await d1.batch([prepareAuditEvent({
      workspaceId: link.workspace_id, actorType: "system", actorEmail: link.employee_name,
      action: "payroll.payslips.downloaded", entityType: "payroll_run", entityId: run.id,
      after: { competence: run.competence, employees: 1 }, metadata: { via: "employee_portal", portalLinkId: link.id, scope: "company", companyId: run.companyId },
      requestId: request.headers.get("x-fila-dp-request-id"),
    })]);
    return pdfResponse(pdf, `holerite-${run.competence}-${result.registrationNumber}.pdf`);
  } catch (error) { return apiError(error); }
}
