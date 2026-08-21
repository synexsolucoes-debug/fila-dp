import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { readPayrollPdf } from "@/lib/payroll-pdf";

const digits = (value: string) => value.replace(/\D/gu, "");

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const form = await request.formData();
    const file = form.get("file");
    const companyId = text(form.get("companyId"), 120);
    const action = form.get("action") === "import" ? "import" : "preview";
    if (!(file instanceof File) || !companyId) throw ApiError.badRequest("Selecione a empresa e o PDF da folha.", "PAYROLL_PDF_REQUIRED");
    if (!file.name.toLowerCase().endsWith(".pdf")) throw ApiError.badRequest("Envie um arquivo .pdf.", "PAYROLL_PDF_TYPE");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "hr.write");
    const company = await d1.prepare("SELECT id, legal_name, trade_name, tax_id FROM fdp_companies WHERE id = ? AND workspace_id = ?")
      .bind(companyId, workspace.id).first<Record<string, unknown>>();
    if (!company) throw ApiError.notFound("Empresa não encontrada neste grupo.", "COMPANY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const parsed = await readPayrollPdf(await file.arrayBuffer());
    const registeredTaxId = digits(String(company.tax_id ?? ""));
    if (!registeredTaxId) throw new ApiError(409, "PAYROLL_COMPANY_TAX_ID_REQUIRED", "Cadastre o CNPJ da empresa antes de importar a folha.");
    if (registeredTaxId && registeredTaxId !== digits(parsed.taxId)) {
      throw new ApiError(409, "PAYROLL_COMPANY_MISMATCH", `O PDF pertence ao CNPJ ${parsed.taxId}, diferente da empresa selecionada.`);
    }
    const current = await d1.prepare(`SELECT admissions, terminations, voluntary_terminations, involuntary_terminations,
      leaves_count, benefits_cost, provisions_cost, other_costs FROM fdp_hr_metrics
      WHERE workspace_id = ? AND company_id = ? AND period = ?`)
      .bind(workspace.id, companyId, parsed.period).first<Record<string, unknown>>();
    const detailedWithoutMovementTotals = parsed.model === "dominio_analytical";
    const admissions = detailedWithoutMovementTotals ? Number(current?.admissions ?? 0) : parsed.admissions;
    const terminations = detailedWithoutMovementTotals ? Number(current?.terminations ?? 0) : parsed.terminations;
    const leavesCount = detailedWithoutMovementTotals ? Number(current?.leaves_count ?? 0) : parsed.leavesCount;
    const voluntaryTerminations = Number(current?.voluntary_terminations ?? 0);
    const involuntaryTerminations = Number(current?.involuntary_terminations ?? 0);
    const benefitsCost = Number(current?.benefits_cost ?? 0);
    const provisionsCost = Number(current?.provisions_cost ?? 0);
    const otherCosts = Number(current?.other_costs ?? 0);
    const payrollCost = parsed.payrollCost + benefitsCost + provisionsCost + otherCosts;
    const preservedComplementaryCosts = benefitsCost + provisionsCost + otherCosts;
    const warnings = preservedComplementaryCosts > 0
      ? [...parsed.warnings, `Foram preservados R$ ${preservedComplementaryCosts.toFixed(2)} de benefícios, provisões e outros custos já registrados.`]
      : parsed.warnings;
    if (action === "preview") return Response.json({ preview: { ...parsed, payrollCost, preservedComplementaryCosts, warnings },
      fileName: file.name, targetCompanyName: String(company.trade_name || company.legal_name) });

    const id = crypto.randomUUID();
    const notes = `${parsed.modelLabel}; arquivo ${file.name}; valores importados do documento, sem recálculo tributário.`.slice(0, 500);
    await d1.prepare(`INSERT INTO fdp_hr_metrics
      (id, workspace_id, company_id, period, headcount, headcount_start, headcount_end, leaves_count, admissions, terminations,
       voluntary_terminations, involuntary_terminations, base_salary, variable_pay, overtime_pay, additional_pay, vacation_pay,
       thirteenth_pay, termination_pay, gross_payroll, employee_inss, employee_irrf, employee_other_deductions, net_pay,
       employer_inss, rat_contribution, third_party_contributions, fgts, fgts_penalty, employer_charges, benefits_cost,
       provisions_cost, other_costs, payroll_cost, source, external_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pdf_import', ?, ?)
      ON CONFLICT(workspace_id, company_id, period) DO UPDATE SET
       headcount = excluded.headcount, headcount_start = excluded.headcount_start, headcount_end = excluded.headcount_end,
       leaves_count = excluded.leaves_count, admissions = excluded.admissions, terminations = excluded.terminations,
       voluntary_terminations = excluded.voluntary_terminations, involuntary_terminations = excluded.involuntary_terminations,
       base_salary = excluded.base_salary, variable_pay = 0,
       overtime_pay = 0, additional_pay = excluded.additional_pay, vacation_pay = 0, thirteenth_pay = 0, termination_pay = 0,
       gross_payroll = excluded.gross_payroll, employee_inss = excluded.employee_inss, employee_irrf = excluded.employee_irrf,
       employee_other_deductions = excluded.employee_other_deductions, net_pay = excluded.net_pay,
       employer_inss = excluded.employer_inss, rat_contribution = excluded.rat_contribution,
       third_party_contributions = excluded.third_party_contributions, fgts = excluded.fgts, fgts_penalty = excluded.fgts_penalty,
       employer_charges = excluded.employer_charges, benefits_cost = excluded.benefits_cost,
       provisions_cost = excluded.provisions_cost, other_costs = excluded.other_costs,
       payroll_cost = excluded.payroll_cost, source = excluded.source, external_id = excluded.external_id,
       notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
      .bind(id, workspace.id, companyId, parsed.period, parsed.headcount, parsed.headcount, parsed.headcount, leavesCount,
        admissions, terminations, voluntaryTerminations, involuntaryTerminations, parsed.baseSalary, parsed.additionalPay, parsed.grossPayroll, parsed.employeeInss,
        parsed.employeeIrrf, parsed.employeeOtherDeductions, parsed.netPay, parsed.employerInss, parsed.ratContribution,
        parsed.thirdPartyContributions, parsed.fgts, parsed.fgtsPenalty, parsed.employerCharges, benefitsCost, provisionsCost, otherCosts, payrollCost,
        `pdf:${digits(parsed.taxId)}:${parsed.period}`, notes).run();
    await recordActivity(workspace.id, null, auth.user.email, "hr_metric.pdf_imported", {
      companyId, period: parsed.period, model: parsed.model, fileName: file.name, totalPages: parsed.totalPages,
    });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error instanceof Error && !(error instanceof ApiError) ? ApiError.badRequest(error.message, "PAYROLL_PDF_INVALID") : error);
  }
}
