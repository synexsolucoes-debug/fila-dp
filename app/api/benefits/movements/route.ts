import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { moneyValue } from "@/lib/fila-dp-money";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const period = /^\d{4}-\d{2}$/.test(new URL(request.url).searchParams.get("period") ?? "") ? new URL(request.url).searchParams.get("period")! : "9999-12";
    const result = await d1.prepare("SELECT id, policy_id, employment_id, company_id, period, amount, employee_discount, status, notes FROM fdp_benefit_movements WHERE workspace_id = ? AND period <= ? ORDER BY period DESC, created_at DESC LIMIT 1000").bind(workspace.id, period).all<Record<string, unknown>>();
    return Response.json({ movements: result.results.filter((row) => access.unrestricted || access.companyIds.has(String(row.company_id))) });
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
    const policyId = text(body.policyId, 120);
    const period = text(body.period, 7);
    if (!employmentId || !policyId || !/^\d{4}-\d{2}$/.test(period)) return Response.json({ error: "Informe vínculo, política e competência AAAA-MM." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const employment = await d1.prepare("SELECT id, company_id, regime FROM fdp_employments WHERE id = ? AND workspace_id = ?").bind(employmentId, workspace.id).first<{ id: string; company_id: string; regime: string }>();
    const policy = await d1.prepare("SELECT id, company_id, eligible_regime, monthly_value, employee_discount FROM fdp_benefit_policies WHERE id = ? AND workspace_id = ? AND active = 1").bind(policyId, workspace.id).first<{ id: string; company_id: string; eligible_regime: string; monthly_value: number; employee_discount: number }>();
    if (!employment || !policy || String(employment.company_id) !== String(policy.company_id)) return Response.json({ error: "Vínculo e política precisam pertencer à mesma empresa." }, { status: 400 });
    if (policy.eligible_regime !== "all" && policy.eligible_regime !== employment.regime) return Response.json({ error: "Este vínculo não é elegível para a política selecionada." }, { status: 409 });
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(employment.company_id));
    const id = crypto.randomUUID();
    const amount = body.amount === undefined || body.amount === "" ? Number(policy.monthly_value) : moneyValue(body.amount);
    const employeeDiscount = body.employeeDiscount === undefined || body.employeeDiscount === "" ? Number(policy.employee_discount) : moneyValue(body.employeeDiscount);
    await d1.prepare(`INSERT INTO fdp_benefit_movements (id, workspace_id, policy_id, employment_id, company_id, period, amount, employee_discount, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(employment_id, policy_id, period) DO UPDATE SET amount = excluded.amount, employee_discount = excluded.employee_discount,
        status = excluded.status, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
      .bind(id, workspace.id, policyId, employmentId, employment.company_id, period, amount, employeeDiscount, ["approved", "exported", "cancelled"].includes(String(body.status)) ? String(body.status) : "calculated", text(body.notes, 500)).run();
    await recordActivity(workspace.id, null, auth.user.email, "benefit_movement.saved", { employmentId, policyId, period, amount });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
