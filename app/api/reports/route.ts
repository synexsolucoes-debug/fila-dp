import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const companyAccess = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const url = new URL(request.url);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to")! : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const [cards, hrMetrics, employments, benefitMovements, pjClosings] = await Promise.all([
      d1.prepare(`SELECT c.id, c.title, c.process_type, c.priority, c.created_at, c.updated_at, c.sla_status, c.sla_escalation_level, c.archived, c.company_id,
      COALESCE(c.assignee_name, '') AS assignee_name, COALESCE(company.trade_name, company.legal_name, 'Sem empresa') AS company_name
      FROM fdp_cards c JOIN fdp_boards b ON b.id = c.board_id LEFT JOIN fdp_companies company ON company.id = c.company_id
      WHERE b.workspace_id = ? AND date(c.created_at) BETWEEN date(?) AND date(?)`).bind(workspace.id, from, to).all<Record<string, unknown>>(),
      d1.prepare(`SELECT m.period, m.headcount, m.admissions, m.terminations, m.payroll_cost, m.company_id, COALESCE(c.legal_name, 'Sem empresa') AS company_name
        FROM fdp_hr_metrics m LEFT JOIN fdp_companies c ON c.id = m.company_id
        WHERE m.workspace_id = ? AND m.period BETWEEN ? AND ? ORDER BY m.period`).bind(workspace.id, from.slice(0, 7), to.slice(0, 7)).all<Record<string, unknown>>(),
      d1.prepare("SELECT company_id, regime, status FROM fdp_employments WHERE workspace_id = ?").bind(workspace.id).all<Record<string, unknown>>(),
      d1.prepare("SELECT company_id, period, amount, employee_discount, status FROM fdp_benefit_movements WHERE workspace_id = ? AND period BETWEEN ? AND ?").bind(workspace.id, from.slice(0, 7), to.slice(0, 7)).all<Record<string, unknown>>(),
      d1.prepare("SELECT company_id, period, net_amount, caju_excess, status FROM fdp_pj_closings WHERE workspace_id = ? AND period BETWEEN ? AND ?").bind(workspace.id, from.slice(0, 7), to.slice(0, 7)).all<Record<string, unknown>>(),
    ]);
    const visibleCards = companyAccess.unrestricted ? cards.results : cards.results.filter((card) => companyAccess.companyIds.has(String(card.company_id)));
    const metricRows = companyAccess.unrestricted ? hrMetrics.results : hrMetrics.results.filter((metric) => companyAccess.companyIds.has(String(metric.company_id)));
    const employmentRows = companyAccess.unrestricted ? employments.results : employments.results.filter((item) => companyAccess.companyIds.has(String(item.company_id)));
    const benefitRows = companyAccess.unrestricted ? benefitMovements.results : benefitMovements.results.filter((item) => companyAccess.companyIds.has(String(item.company_id)));
    const pjRows = companyAccess.unrestricted ? pjClosings.results : pjClosings.results.filter((item) => companyAccess.companyIds.has(String(item.company_id)));
    const activity = await d1.prepare(`SELECT ae.event_type, ae.actor_email, ae.created_at, c.company_id FROM fdp_activity_events ae
      JOIN fdp_cards c ON c.id = ae.card_id WHERE ae.workspace_id = ? AND date(ae.created_at) BETWEEN date(?) AND date(?)`).bind(workspace.id, from, to).all<Record<string, unknown>>();
    const visibleActivity = companyAccess.unrestricted ? activity.results : activity.results.filter((item) => companyAccess.companyIds.has(String(item.company_id)));
    const byProcess: Record<string, number> = {};
    const byMember: Record<string, number> = {};
    let completed = 0;
    let totalHours = 0;
    for (const card of visibleCards) {
      const process = String(card.process_type ?? "OUTROS"); byProcess[process] = (byProcess[process] ?? 0) + 1;
      const member = String(card.assignee_name ?? "Sem responsável"); byMember[member] = (byMember[member] ?? 0) + 1;
      if (String(card.sla_status) === "completed" || Boolean(card.archived)) { completed += 1; totalHours += Math.max(0, (new Date(String(card.updated_at)).getTime() - new Date(String(card.created_at)).getTime()) / 3600000); }
    }
    const admissions = metricRows.reduce((sum, row) => sum + Number(row.admissions ?? 0), 0);
    const terminations = metricRows.reduce((sum, row) => sum + Number(row.terminations ?? 0), 0);
    const headcountTotal = metricRows.reduce((sum, row) => sum + Number(row.headcount ?? 0), 0);
    const payrollCostTotal = metricRows.reduce((sum, row) => sum + Number(row.payroll_cost ?? 0), 0);
    const averageHeadcount = metricRows.length ? headcountTotal / metricRows.length : 0;
    const turnoverRate = averageHeadcount ? Math.round((((admissions + terminations) / 2) / averageHeadcount) * 10000) / 100 : 0;
    const activeClt = employmentRows.filter((row) => String(row.status) === "active" && String(row.regime) === "clt").length;
    const activePj = employmentRows.filter((row) => String(row.status) === "active" && String(row.regime) === "pj").length;
    const canViewFinancial = workspace.role === "admin" || workspace.role === "member";
    const benefitsCostTotal = canViewFinancial ? Math.round(benefitRows.filter((row) => String(row.status) !== "cancelled").reduce((sum, row) => sum + Math.max(0, Number(row.amount ?? 0) - Number(row.employee_discount ?? 0)), 0) * 100) / 100 : 0;
    const pjNetTotal = canViewFinancial ? Math.round(pjRows.reduce((sum, row) => sum + Number(row.net_amount ?? 0), 0) * 100) / 100 : 0;
    const pjCajuExcessTotal = canViewFinancial ? Math.round(pjRows.reduce((sum, row) => sum + Number(row.caju_excess ?? 0), 0) * 100) / 100 : 0;
    const pjPending = pjRows.filter((row) => !["approved", "paid"].includes(String(row.status))).length;
    const payrollByCompany = metricRows.reduce<Record<string, number>>((accumulator, row) => {
      const key = String(row.company_name ?? "Sem empresa");
      accumulator[key] = Math.round(((accumulator[key] ?? 0) + Number(row.payroll_cost ?? 0)) * 100) / 100;
      return accumulator;
    }, {});
    const slaStatus = { safe: 0, warning: 0, overdue: 0, paused: 0, completed: 0 };
    const slaByCompany: Record<string, { total: number; warning: number; overdue: number }> = {};
    const slaByProcess: Record<string, { total: number; warning: number; overdue: number }> = {};
    let escalated = 0;
    for (const card of visibleCards) {
      const status = String(card.sla_status) as keyof typeof slaStatus;
      if (status in slaStatus) slaStatus[status] += 1;
      if (Number(card.sla_escalation_level ?? 0) > 0) escalated += 1;
      const company = String(card.company_name ?? "Sem empresa");
      const process = String(card.process_type ?? "OUTROS");
      const companySummary = slaByCompany[company] ??= { total: 0, warning: 0, overdue: 0 };
      const processSummary = slaByProcess[process] ??= { total: 0, warning: 0, overdue: 0 };
      companySummary.total += 1;
      processSummary.total += 1;
      if (status === "warning" || status === "overdue") {
        companySummary[status] += 1;
        processSummary[status] += 1;
      }
    }
    const slaMeasured = visibleCards.length - slaStatus.paused;
    const slaComplianceRate = slaMeasured ? Math.round(((slaStatus.safe + slaStatus.completed) / slaMeasured) * 10000) / 100 : 100;
    return Response.json({ from, to, total: visibleCards.length, completed, completionRate: visibleCards.length ? Math.round((completed / visibleCards.length) * 100) : 100, averageCompletionHours: completed ? Math.round((totalHours / completed) * 10) / 10 : 0, byProcess, byMember, activityCount: visibleActivity.length, activityByType: visibleActivity.reduce<Record<string, number>>((accumulator, item) => { const key = String(item.event_type); accumulator[key] = (accumulator[key] ?? 0) + 1; return accumulator; }, {}), sla: { ...slaStatus, escalated, complianceRate: slaComplianceRate, byCompany: slaByCompany, byProcess: slaByProcess }, hrMetrics: { periods: metricRows.length, admissions, terminations, averageHeadcount: Math.round(averageHeadcount * 10) / 10, payrollCostTotal: Math.round(payrollCostTotal * 100) / 100, turnoverRate, payrollByCompany, activeClt, activePj, benefitsCostTotal, pjNetTotal, pjCajuExcessTotal, pjPending } });
  } catch (error) { return apiError(error); }
}
