import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { moneyValue } from "@/lib/fila-dp-money";

const regimes = new Set(["all", "clt", "pj", "intern", "temporary"]);

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const result = await d1.prepare("SELECT id, company_id, name, benefit_type, eligible_regime, monthly_value, employee_discount, channel, effective_from, effective_to, active FROM fdp_benefit_policies WHERE workspace_id = ? ORDER BY active DESC, name").bind(workspace.id).all<Record<string, unknown>>();
    return Response.json({ policies: result.results.filter((row) => access.unrestricted || access.companyIds.has(String(row.company_id))) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const companyId = text(body.companyId, 120);
    const name = text(body.name, 160);
    const benefitType = text(body.benefitType, 60);
    if (!companyId || !name || !benefitType) return Response.json({ error: "Informe empresa, nome e tipo do benefício." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const id = crypto.randomUUID();
    const effectiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(body.effectiveFrom ?? "")) ? String(body.effectiveFrom) : null;
    const effectiveTo = /^\d{4}-\d{2}-\d{2}$/.test(String(body.effectiveTo ?? "")) ? String(body.effectiveTo) : null;
    await d1.prepare(`INSERT INTO fdp_benefit_policies
      (id, workspace_id, company_id, name, benefit_type, eligible_regime, monthly_value, employee_discount, channel, effective_from, effective_to, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .bind(id, workspace.id, companyId, name, benefitType, regimes.has(String(body.eligibleRegime)) ? String(body.eligibleRegime) : "all", moneyValue(body.monthlyValue), moneyValue(body.employeeDiscount), text(body.channel, 40) || "payroll", effectiveFrom, effectiveTo).run();
    await recordActivity(workspace.id, null, auth.user.email, "benefit_policy.created", { policyId: id, companyId, benefitType });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
