import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { calculatePjClosing, calculatePjContractAmount } from "@/lib/fila-dp-money";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const period = /^\d{4}-\d{2}$/.test(new URL(request.url).searchParams.get("period") ?? "") ? new URL(request.url).searchParams.get("period")! : "9999-12";
    const result = await d1.prepare("SELECT id, employment_id, company_id, period, contract_amount, variable_amount, reimbursement_amount, deductions_amount, invoice_limit, invoice_amount, caju_excess, net_amount, status, notes FROM fdp_pj_closings WHERE workspace_id = ? AND period <= ? ORDER BY period DESC, created_at DESC LIMIT 1000").bind(workspace.id, period).all<Record<string, unknown>>();
    return Response.json({ closings: result.results.filter((row) => access.unrestricted || access.companyIds.has(String(row.company_id))) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const employmentId = text(body.employmentId, 120);
    const period = text(body.period, 7);
    if (!employmentId || !/^\d{4}-\d{2}$/.test(period)) return Response.json({ error: "Informe o vínculo PJ e a competência AAAA-MM." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const employment = await d1.prepare("SELECT id, company_id, regime, monthly_value, start_date FROM fdp_employments WHERE id = ? AND workspace_id = ?").bind(employmentId, workspace.id).first<{ id: string; company_id: string; regime: string; monthly_value: number; start_date: string | null }>();
    if (!employment || employment.regime !== "pj") return Response.json({ error: "Selecione um vínculo ativo do tipo PJ." }, { status: 400 });
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(employment.company_id));
    const calculatedContractAmount = calculatePjContractAmount(employment.monthly_value, employment.start_date, period);
    const values = calculatePjClosing({
      contractAmount: calculatedContractAmount,
      variableAmount: body.variableAmount,
      reimbursementAmount: body.reimbursementAmount,
      deductionsAmount: body.deductionsAmount,
      invoiceLimit: body.invoiceLimit,
      invoiceAmount: body.invoiceAmount,
    });
    const requestedStatus = ["draft", "review", "approved", "paid"].includes(String(body.status)) ? String(body.status) : "draft";
    const status = values.invoiceDivergent ? "blocked" : requestedStatus;
    const id = crypto.randomUUID();
    await d1.prepare(`INSERT INTO fdp_pj_closings
      (id, workspace_id, employment_id, company_id, period, contract_amount, variable_amount, reimbursement_amount, deductions_amount, invoice_limit, invoice_amount, caju_excess, net_amount, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(employment_id, period) DO UPDATE SET contract_amount = excluded.contract_amount, variable_amount = excluded.variable_amount,
        reimbursement_amount = excluded.reimbursement_amount, deductions_amount = excluded.deductions_amount, invoice_limit = excluded.invoice_limit,
        invoice_amount = excluded.invoice_amount, caju_excess = excluded.caju_excess, net_amount = excluded.net_amount,
        status = excluded.status, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
      .bind(id, workspace.id, employmentId, employment.company_id, period, values.contractAmount, values.variableAmount, values.reimbursementAmount, values.deductionsAmount, values.invoiceLimit, values.invoiceAmount, values.cajuExcess, values.netAmount, status, text(body.notes, 500)).run();
    await recordActivity(workspace.id, null, auth.user.email, "pj_closing.saved", { employmentId, period, status, netAmount: values.netAmount, expectedInvoiceAmount: values.expectedInvoiceAmount });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
