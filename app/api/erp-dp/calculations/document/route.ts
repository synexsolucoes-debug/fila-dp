import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { calculate } from "@/lib/erp-calculation-service";
import { addDays, currentVacationPeriodStart, terminationKindLabels, type TerminationKind } from "@/lib/payroll-calc";
import { terminationPdf, vacationPdf } from "@/lib/payroll-documents-pdf";
import { documentCompany, documentEmployees, pdfResponse } from "@/lib/payroll-documents-service";

/**
 * Documentos do cálculo de férias (aviso e recibo) e de rescisão
 * (demonstrativo de verbas e termo de quitação), em PDF. Recebe o mesmo
 * corpo de `POST /api/erp-dp/calculations` e refaz a conta — o documento
 * nunca diverge do número da tela.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.type !== "vacation" && body.type !== "termination") throw ApiError.badRequest("Documento só para férias e rescisão.", "DOCUMENT_TYPE_INVALID");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    const calculation = await calculate(d1, workspace, user.id, body);
    const company = await documentCompany(d1, workspace.id, calculation.employee.companyId);
    const person = (await documentEmployees(d1, workspace.id, [calculation.employee.id])).get(calculation.employee.id);
    if (!person) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
    const { result } = calculation;
    let pdf: Uint8Array;
    let filename: string;
    if (calculation.type === "vacation") {
      const start = calculation.referenceDate;
      const days = (calculation.vacation?.entitledDays ?? 30) - (calculation.vacation?.soldDays ?? 0);
      // O período aquisitivo que estas férias pagam é o último completo antes do início.
      const currentStart = currentVacationPeriodStart(calculation.employee.admissionDate, start);
      const acquisitiveEnd = addDays(currentStart, -1);
      if (acquisitiveEnd < calculation.employee.admissionDate) {
        throw ApiError.badRequest("Ainda não há período aquisitivo completo na data de início: férias exigem 12 meses de vínculo (CLT art. 130).", "VACATION_NOT_ACQUIRED");
      }
      const acquisitiveStart = currentVacationPeriodStart(calculation.employee.admissionDate, acquisitiveEnd);
      pdf = vacationPdf({
        company, employee: person, acquisitiveStart, acquisitiveEnd, start, end: addDays(start, days - 1), returnDate: addDays(start, days),
        restDays: days, soldDays: calculation.vacation?.soldDays ?? 0, paymentDue: addDays(start, -2),
        lines: result.lines, earningsCents: result.earnings, deductionsCents: result.deductions,
      });
      filename = `ferias-${person.registrationNumber}-${start}.pdf`;
    } else {
      const termination = result as typeof result & { projectedEnd: string; noticeDays: number };
      pdf = terminationPdf({
        company, employee: person, kindLabel: terminationKindLabels[calculation.kind as TerminationKind] ?? "Rescisão",
        terminationDate: calculation.referenceDate, projectedEnd: termination.projectedEnd, noticeDays: termination.noticeDays,
        paymentDue: addDays(calculation.referenceDate, 10), lines: result.lines, earningsCents: result.earnings,
        deductionsCents: result.deductions, notes: result.notes,
      });
      filename = `rescisao-${person.registrationNumber}-${calculation.referenceDate}.pdf`;
    }
    await d1.batch([prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `payroll.document.${calculation.type}`, entityType: "employee", entityId: calculation.employee.id,
      before: null, after: { referenceDate: calculation.referenceDate, net: result.net },
      metadata: { scope: "company", companyId: calculation.employee.companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
    })]);
    return pdfResponse(pdf, filename);
  } catch (error) { return apiError(error); }
}
