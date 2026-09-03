import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { moneyValue } from "@/lib/fila-dp-money";

const regimes = new Set(["clt", "pj", "intern", "temporary"]);
const statuses = new Set(["active", "inactive", "on_leave"]);

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member", "observer"]);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const url = new URL(request.url);
    const query = text(url.searchParams.get("q"), 120).toLowerCase();
    const regime = text(url.searchParams.get("regime"), 20);
    const result = await d1.prepare(`SELECT e.id, e.person_id, e.company_id, e.employee_code, e.regime, e.job_title, e.department, e.cost_center,
      e.manager_name, e.start_date, e.end_date, e.monthly_value, e.status, e.source, e.external_id,
      p.full_name, p.preferred_name, p.email, p.phone
      FROM fdp_employments e JOIN fdp_people p ON p.id = e.person_id
      WHERE e.workspace_id = ? ORDER BY p.full_name LIMIT 1000`).bind(workspace.id).all<Record<string, unknown>>();
    const employments = result.results.filter((row) => {
      if (!access.unrestricted && !access.companyIds.has(String(row.company_id))) return false;
      if (regime && regime !== String(row.regime)) return false;
      if (!query) return true;
      return [row.full_name, row.preferred_name, row.email, row.employee_code, row.job_title, row.department].some((value) => String(value ?? "").toLowerCase().includes(query));
    }).map((row) => ({
      ...row,
      email: workspace.role === "guest" ? "" : row.email,
      phone: workspace.role === "guest" ? "" : row.phone,
      monthly_value: workspace.role === "admin" || workspace.role === "member" ? row.monthly_value : 0,
    }));
    return Response.json({ employments });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const fullName = text(body.fullName, 180);
    const companyId = text(body.companyId, 120);
    const regime = regimes.has(String(body.regime)) ? String(body.regime) : "clt";
    if (!fullName || !companyId) return Response.json({ error: "Informe nome e empresa do vínculo." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const company = await d1.prepare("SELECT id FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(companyId, workspace.id).first();
    if (!company) return Response.json({ error: "Empresa não encontrada neste grupo." }, { status: 404 });
    const employeeCode = text(body.employeeCode, 80);
    if (employeeCode) {
      const duplicate = await d1.prepare("SELECT id FROM fdp_employments WHERE workspace_id = ? AND company_id = ? AND employee_code = ?").bind(workspace.id, companyId, employeeCode).first();
      if (duplicate) return Response.json({ error: "Já existe um vínculo com esta matrícula nesta empresa." }, { status: 409 });
    }
    const email = text(body.email, 180).toLowerCase();
    const suppliedPersonId = text(body.personId, 120);
    const existingPerson = suppliedPersonId
      ? await d1.prepare("SELECT id FROM fdp_people WHERE id = ? AND workspace_id = ?").bind(suppliedPersonId, workspace.id).first<{ id: string }>()
      : email
        ? await d1.prepare("SELECT id FROM fdp_people WHERE workspace_id = ? AND LOWER(email) = ? ORDER BY created_at LIMIT 1").bind(workspace.id, email).first<{ id: string }>()
        : null;
    const personId = existingPerson?.id || crypto.randomUUID();
    if (!existingPerson) {
      await d1.prepare("INSERT INTO fdp_people (id, workspace_id, full_name, preferred_name, email, phone, status) VALUES (?, ?, ?, ?, ?, ?, 'active')")
        .bind(personId, workspace.id, fullName, text(body.preferredName, 120), email, text(body.phone, 40)).run();
    }
    const employmentId = crypto.randomUUID();
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate ?? "")) ? String(body.startDate) : null;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.endDate ?? "")) ? String(body.endDate) : null;
    const status = statuses.has(String(body.status)) ? String(body.status) : "active";
    await d1.prepare(`INSERT INTO fdp_employments
      (id, workspace_id, person_id, company_id, employee_code, regime, job_title, department, cost_center, manager_name, start_date, end_date, monthly_value, status, source, external_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(employmentId, workspace.id, personId, companyId, employeeCode, regime, text(body.jobTitle, 140), text(body.department, 140), text(body.costCenter, 100), text(body.managerName, 140), startDate, endDate, moneyValue(body.monthlyValue), status, text(body.source, 30) || "manual", text(body.externalId, 120)).run();
    await recordActivity(workspace.id, null, auth.user.email, "employment.created", { employmentId, personId, companyId, regime });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
