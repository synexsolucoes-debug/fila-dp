import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";

function metricNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "hr.read");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const url = new URL(request.url);
    const from = /^\d{4}-\d{2}$/.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : "0000-01";
    const to = /^\d{4}-\d{2}$/.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to")! : "9999-12";
    const result = await d1.prepare(`SELECT id, company_id, period, headcount, headcount_start, headcount_end, leaves_count, admissions, terminations, voluntary_terminations, involuntary_terminations, base_salary, variable_pay, overtime_pay, additional_pay, vacation_pay, thirteenth_pay, termination_pay, gross_payroll, employee_inss, employee_irrf, employee_other_deductions, net_pay, employer_inss, rat_contribution, third_party_contributions, fgts, fgts_penalty, employer_charges, benefits_cost, provisions_cost, other_costs, payroll_cost, source, external_id, notes
      FROM fdp_hr_metrics WHERE workspace_id = ? AND period BETWEEN ? AND ? ORDER BY period DESC`).bind(workspace.id, from, to).all();
    return Response.json({ metrics: result.results.filter((metric) => access.unrestricted || access.companyIds.has(String(metric.company_id))) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const period = text(body.period, 7);
    const companyId = text(body.companyId, 120);
    if (!/^\d{4}-\d{2}$/.test(period) || !companyId) return Response.json({ error: "Informe empresa e competência no formato AAAA-MM." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "hr.write");
    const company = await d1.prepare("SELECT id FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(companyId, workspace.id).first<{ id: string }>();
    if (!company) return Response.json({ error: "Empresa não encontrada neste workspace." }, { status: 404 });
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const id = crypto.randomUUID();
    const headcountStart = Math.round(metricNumber(body.headcountStart ?? body.headcount));
    const headcountEnd = Math.round(metricNumber(body.headcountEnd ?? body.headcount));
    const headcount = Math.round((headcountStart + headcountEnd) / 2);
    const leavesCount = Math.round(metricNumber(body.leavesCount));
    const admissions = Math.round(metricNumber(body.admissions));
    const voluntaryTerminations = Math.round(metricNumber(body.voluntaryTerminations));
    const involuntaryTerminations = Math.round(metricNumber(body.involuntaryTerminations));
    const detailedTerminations = voluntaryTerminations + involuntaryTerminations;
    const terminations = detailedTerminations > 0 ? detailedTerminations : Math.round(metricNumber(body.terminations));
    const baseSalary = metricNumber(body.baseSalary);
    const variablePay = metricNumber(body.variablePay);
    const overtimePay = metricNumber(body.overtimePay);
    const additionalPay = metricNumber(body.additionalPay);
    const vacationPay = metricNumber(body.vacationPay);
    const thirteenthPay = metricNumber(body.thirteenthPay);
    const terminationPay = metricNumber(body.terminationPay);
    const calculatedGrossPayroll = baseSalary + variablePay + overtimePay + additionalPay + vacationPay + thirteenthPay + terminationPay;
    const grossPayroll = calculatedGrossPayroll > 0 ? calculatedGrossPayroll : metricNumber(body.grossPayroll);
    const employeeInss = metricNumber(body.employeeInss);
    const employeeIrrf = metricNumber(body.employeeIrrf);
    const employeeOtherDeductions = metricNumber(body.employeeOtherDeductions);
    const netPay = Math.max(0, grossPayroll - employeeInss - employeeIrrf - employeeOtherDeductions);
    const employerInss = metricNumber(body.employerInss);
    const ratContribution = metricNumber(body.ratContribution);
    const thirdPartyContributions = metricNumber(body.thirdPartyContributions);
    const fgts = metricNumber(body.fgts);
    const fgtsPenalty = metricNumber(body.fgtsPenalty);
    const calculatedEmployerCharges = employerInss + ratContribution + thirdPartyContributions + fgts + fgtsPenalty;
    const employerCharges = calculatedEmployerCharges > 0 ? calculatedEmployerCharges : metricNumber(body.employerCharges);
    const benefitsCost = metricNumber(body.benefitsCost);
    const provisionsCost = metricNumber(body.provisionsCost);
    const otherCosts = metricNumber(body.otherCosts);
    const detailedTotal = grossPayroll + employerCharges + benefitsCost + provisionsCost + otherCosts;
    const payrollCost = detailedTotal > 0 ? detailedTotal : metricNumber(body.payrollCost);
    await d1.prepare(`INSERT INTO fdp_hr_metrics
      (id, workspace_id, company_id, period, headcount, headcount_start, headcount_end, leaves_count, admissions, terminations, voluntary_terminations, involuntary_terminations, base_salary, variable_pay, overtime_pay, additional_pay, vacation_pay, thirteenth_pay, termination_pay, gross_payroll, employee_inss, employee_irrf, employee_other_deductions, net_pay, employer_inss, rat_contribution, third_party_contributions, fgts, fgts_penalty, employer_charges, benefits_cost, provisions_cost, other_costs, payroll_cost, source, external_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, company_id, period) DO UPDATE SET
        headcount = excluded.headcount, headcount_start = excluded.headcount_start, headcount_end = excluded.headcount_end,
        leaves_count = excluded.leaves_count, admissions = excluded.admissions, terminations = excluded.terminations,
        voluntary_terminations = excluded.voluntary_terminations, involuntary_terminations = excluded.involuntary_terminations,
        base_salary = excluded.base_salary, variable_pay = excluded.variable_pay, overtime_pay = excluded.overtime_pay,
        additional_pay = excluded.additional_pay, vacation_pay = excluded.vacation_pay, thirteenth_pay = excluded.thirteenth_pay,
        termination_pay = excluded.termination_pay, employee_inss = excluded.employee_inss, employee_irrf = excluded.employee_irrf,
        employee_other_deductions = excluded.employee_other_deductions, net_pay = excluded.net_pay,
        employer_inss = excluded.employer_inss, rat_contribution = excluded.rat_contribution,
        third_party_contributions = excluded.third_party_contributions, fgts = excluded.fgts, fgts_penalty = excluded.fgts_penalty,
        gross_payroll = excluded.gross_payroll, employer_charges = excluded.employer_charges,
        benefits_cost = excluded.benefits_cost, provisions_cost = excluded.provisions_cost, other_costs = excluded.other_costs,
        payroll_cost = excluded.payroll_cost, source = excluded.source, external_id = excluded.external_id,
        notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
      .bind(id, workspace.id, companyId, period, headcount, headcountStart, headcountEnd, leavesCount, admissions, terminations, voluntaryTerminations, involuntaryTerminations, baseSalary, variablePay, overtimePay, additionalPay, vacationPay, thirteenthPay, terminationPay, grossPayroll, employeeInss, employeeIrrf, employeeOtherDeductions, netPay, employerInss, ratContribution, thirdPartyContributions, fgts, fgtsPenalty, employerCharges, benefitsCost, provisionsCost, otherCosts, payrollCost, text(body.source, 30) || "manual", text(body.externalId, 120), text(body.notes, 500))
      .run();
    await recordActivity(workspace.id, null, auth.user.email, "hr_metric.saved", { companyId, period, source: text(body.source, 30) || "manual" });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
