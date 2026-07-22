import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

function metricNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const from = /^\d{4}-\d{2}$/.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : "0000-01";
    const to = /^\d{4}-\d{2}$/.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to")! : "9999-12";
    const result = await d1.prepare(`SELECT id, company_id, period, headcount, admissions, terminations, payroll_cost, source, external_id, notes
      FROM fdp_hr_metrics WHERE workspace_id = ? AND period BETWEEN ? AND ? ORDER BY period DESC`).bind(workspace.id, from, to).all();
    return Response.json({ metrics: result.results });
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
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const company = await d1.prepare("SELECT id FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(companyId, workspace.id).first<{ id: string }>();
    if (!company) return Response.json({ error: "Empresa não encontrada neste workspace." }, { status: 404 });
    const id = crypto.randomUUID();
    await d1.prepare(`INSERT INTO fdp_hr_metrics
      (id, workspace_id, company_id, period, headcount, admissions, terminations, payroll_cost, source, external_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, company_id, period) DO UPDATE SET
        headcount = excluded.headcount, admissions = excluded.admissions, terminations = excluded.terminations,
        payroll_cost = excluded.payroll_cost, source = excluded.source, external_id = excluded.external_id,
        notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
      .bind(id, workspace.id, companyId, period, Math.round(metricNumber(body.headcount)), Math.round(metricNumber(body.admissions)), Math.round(metricNumber(body.terminations)), metricNumber(body.payrollCost), text(body.source, 30) || "manual", text(body.externalId, 120), text(body.notes, 500))
      .run();
    await recordActivity(workspace.id, null, auth.user.email, "hr_metric.saved", { companyId, period, source: text(body.source, 30) || "manual" });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
