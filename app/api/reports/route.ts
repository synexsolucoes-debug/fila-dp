import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to")! : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const [cards, hrMetrics] = await Promise.all([
      d1.prepare(`SELECT c.id, c.title, c.process_type, c.priority, c.created_at, c.updated_at, c.sla_status, c.archived,
      COALESCE(c.assignee_name, '') AS assignee_name
      FROM fdp_cards c JOIN fdp_boards b ON b.id = c.board_id
      WHERE b.workspace_id = ? AND date(c.created_at) BETWEEN date(?) AND date(?)`).bind(workspace.id, from, to).all<Record<string, unknown>>(),
      d1.prepare(`SELECT m.period, m.headcount, m.admissions, m.terminations, m.payroll_cost, m.company_id, COALESCE(c.legal_name, 'Sem empresa') AS company_name
        FROM fdp_hr_metrics m LEFT JOIN fdp_companies c ON c.id = m.company_id
        WHERE m.workspace_id = ? AND m.period BETWEEN ? AND ? ORDER BY m.period`).bind(workspace.id, from.slice(0, 7), to.slice(0, 7)).all<Record<string, unknown>>(),
    ]);
    const activity = await d1.prepare(`SELECT ae.event_type, ae.actor_email, ae.created_at FROM fdp_activity_events ae WHERE ae.workspace_id = ? AND date(ae.created_at) BETWEEN date(?) AND date(?)`).bind(workspace.id, from, to).all<Record<string, unknown>>();
    const byProcess: Record<string, number> = {};
    const byMember: Record<string, number> = {};
    let completed = 0;
    let totalHours = 0;
    for (const card of cards.results) {
      const process = String(card.process_type ?? "OUTROS"); byProcess[process] = (byProcess[process] ?? 0) + 1;
      const member = String(card.assignee_name ?? "Sem responsável"); byMember[member] = (byMember[member] ?? 0) + 1;
      if (String(card.sla_status) === "completed" || Boolean(card.archived)) { completed += 1; totalHours += Math.max(0, (new Date(String(card.updated_at)).getTime() - new Date(String(card.created_at)).getTime()) / 3600000); }
    }
    const metricRows = hrMetrics.results;
    const admissions = metricRows.reduce((sum, row) => sum + Number(row.admissions ?? 0), 0);
    const terminations = metricRows.reduce((sum, row) => sum + Number(row.terminations ?? 0), 0);
    const headcountTotal = metricRows.reduce((sum, row) => sum + Number(row.headcount ?? 0), 0);
    const payrollCostTotal = metricRows.reduce((sum, row) => sum + Number(row.payroll_cost ?? 0), 0);
    const averageHeadcount = metricRows.length ? headcountTotal / metricRows.length : 0;
    const turnoverRate = averageHeadcount ? Math.round((((admissions + terminations) / 2) / averageHeadcount) * 10000) / 100 : 0;
    const payrollByCompany = metricRows.reduce<Record<string, number>>((accumulator, row) => {
      const key = String(row.company_name ?? "Sem empresa");
      accumulator[key] = Math.round(((accumulator[key] ?? 0) + Number(row.payroll_cost ?? 0)) * 100) / 100;
      return accumulator;
    }, {});
    return Response.json({ from, to, total: cards.results.length, completed, completionRate: cards.results.length ? Math.round((completed / cards.results.length) * 100) : 100, averageCompletionHours: completed ? Math.round((totalHours / completed) * 10) / 10 : 0, byProcess, byMember, activityCount: activity.results.length, activityByType: activity.results.reduce<Record<string, number>>((accumulator, item) => { const key = String(item.event_type); accumulator[key] = (accumulator[key] ?? 0) + 1; return accumulator; }, {}), hrMetrics: { periods: metricRows.length, admissions, terminations, averageHeadcount: Math.round(averageHeadcount * 10) / 10, payrollCostTotal: Math.round(payrollCostTotal * 100) / 100, turnoverRate, payrollByCompany } });
  } catch (error) { return apiError(error); }
}
