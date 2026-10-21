/**
 * DP Operacional, Fase 5 — o painel da gestão e os números do relatório mensal.
 *
 * A gestão não tinha como ver a carga de cada analista sem perguntar: quantas
 * empresas, quantas pessoas, quanto está aberto e atrasado, quanto chegou fora
 * do prazo e de onde. Tudo aqui sai das tabelas que as fases anteriores já
 * preenchem — carteira, demandas (com o veredito de corte), ocorrências e
 * alertas —, sem número digitado.
 */
import type { getD1 } from "../db/index.ts";
import { addDays } from "./dp-calendar.ts";
import { areaReport, type AreaReportRow } from "./dp-cutoff.ts";

type Database = ReturnType<typeof getD1>;
type Row = Record<string, unknown>;

export type HolderLoad = {
  userId: string;
  name: string;
  companies: number;
  employeesClt: number;
  contractorsPj: number;
  openCards: number;
  overdueCards: number;
  alerts: number;
};

export type DpDashboard = {
  from: string;
  to: string;
  holders: HolderLoad[];
  byArea: AreaReportRow[];
  byType: AreaReportRow[];
  totals: { openCards: number; overdueCards: number; unassignedCards: number; alerts: number; occurrences: number };
};

const OPEN = "c.archived = 0 AND c.closed_at IS NULL AND c.sla_status <> 'completed'";

export async function loadDpDashboard(d1: Database, input: { workspaceId: string; from: string; to: string }): Promise<DpDashboard> {
  const end = addDays(input.to, 1);
  const [holders, cutoffCards, totals] = await Promise.all([
    d1.prepare(`SELECT u.id, u.name,
        COUNT(DISTINCT p.company_id)::int AS companies,
        (SELECT COUNT(*)::int FROM fdp_employees e WHERE e.workspace_id = ? AND e.employment_status <> 'terminated'
          AND e.company_id IN (SELECT p2.company_id FROM fdp_company_portfolio p2 WHERE p2.workspace_id = ? AND p2.holder_user_id = u.id AND p2.valid_to IS NULL)) AS employees_clt,
        (SELECT COUNT(*)::int FROM fdp_contractor_profiles cp WHERE cp.workspace_id = ? AND cp.status = 'active'
          AND cp.company_id IN (SELECT p2.company_id FROM fdp_company_portfolio p2 WHERE p2.workspace_id = ? AND p2.holder_user_id = u.id AND p2.valid_to IS NULL)) AS contractors_pj,
        (SELECT COUNT(*)::int FROM fdp_cards c JOIN fdp_card_assignees ca ON ca.workspace_id = c.workspace_id AND ca.card_id = c.id
          WHERE c.workspace_id = ? AND ca.user_id = u.id AND ${OPEN}) AS open_cards,
        (SELECT COUNT(*)::int FROM fdp_cards c JOIN fdp_card_assignees ca ON ca.workspace_id = c.workspace_id AND ca.card_id = c.id
          WHERE c.workspace_id = ? AND ca.user_id = u.id AND ${OPEN} AND c.due_at < now()) AS overdue_cards,
        (SELECT COUNT(*)::int FROM fdp_dp_alerts a WHERE a.workspace_id = ? AND a.assigned_user_id = u.id AND a.status = 'open') AS alerts
      FROM fdp_company_portfolio p JOIN fdp_users u ON u.id = p.holder_user_id
      WHERE p.workspace_id = ? AND p.valid_to IS NULL
      GROUP BY u.id, u.name ORDER BY u.name`)
      .bind(input.workspaceId, input.workspaceId, input.workspaceId, input.workspaceId, input.workspaceId, input.workspaceId, input.workspaceId, input.workspaceId)
      .all<Row>(),
    d1.prepare(`SELECT c.requester_area_label AS area, c.process_type, c.within_cutoff, (${OPEN}) AS open
      FROM fdp_cards c WHERE c.workspace_id = ? AND c.cutoff_rule_code <> '' AND c.created_at >= ?::date AND c.created_at < ?::date`)
      .bind(input.workspaceId, input.from, end).all<Row>(),
    d1.prepare(`SELECT
        (SELECT COUNT(*)::int FROM fdp_cards c WHERE c.workspace_id = ? AND ${OPEN}) AS open_cards,
        (SELECT COUNT(*)::int FROM fdp_cards c WHERE c.workspace_id = ? AND ${OPEN} AND c.due_at < now()) AS overdue_cards,
        (SELECT COUNT(*)::int FROM fdp_cards c WHERE c.workspace_id = ? AND ${OPEN}
          AND NOT EXISTS (SELECT 1 FROM fdp_card_assignees ca WHERE ca.workspace_id = c.workspace_id AND ca.card_id = c.id)) AS unassigned_cards,
        (SELECT COUNT(*)::int FROM fdp_dp_alerts a WHERE a.workspace_id = ? AND a.status = 'open') AS alerts,
        (SELECT COUNT(*)::int FROM fdp_dp_occurrences o WHERE o.workspace_id = ? AND o.occurred_on >= ?::date AND o.occurred_on < ?::date) AS occurrences`)
      .bind(input.workspaceId, input.workspaceId, input.workspaceId, input.workspaceId, input.workspaceId, input.from, end).first<Row>(),
  ]);
  const verdict = (value: unknown) => value === null || value === undefined ? null : value === true;
  return {
    from: input.from,
    to: input.to,
    holders: holders.results.map((row) => ({
      userId: String(row.id), name: String(row.name ?? ""), companies: Number(row.companies ?? 0),
      employeesClt: Number(row.employees_clt ?? 0), contractorsPj: Number(row.contractors_pj ?? 0),
      openCards: Number(row.open_cards ?? 0), overdueCards: Number(row.overdue_cards ?? 0), alerts: Number(row.alerts ?? 0),
    })),
    byArea: areaReport(cutoffCards.results.map((row) => ({ area: String(row.area ?? ""), open: row.open === true, within: verdict(row.within_cutoff) }))),
    byType: areaReport(cutoffCards.results.map((row) => ({ area: String(row.process_type ?? ""), open: row.open === true, within: verdict(row.within_cutoff) }))),
    totals: {
      openCards: Number(totals?.open_cards ?? 0), overdueCards: Number(totals?.overdue_cards ?? 0),
      unassignedCards: Number(totals?.unassigned_cards ?? 0), alerts: Number(totals?.alerts ?? 0), occurrences: Number(totals?.occurrences ?? 0),
    },
  };
}

export type MonthlyReportData = {
  workspaceName: string;
  period: string;
  delivered: number;
  deliveredLate: number;
  createdInPeriod: number;
  occurrencesByArea: Array<{ area: string; total: number; daysLate: number }>;
  outsideCutoff: AreaReportRow[];
  risks: Array<{ title: string; dueDate: string | null; severity: string }>;
  holders: HolderLoad[];
};

/** Os números do relatório mensal de uma competência (AAAA-MM). */
export async function loadMonthlyReportData(d1: Database, input: { workspaceId: string; period: string; today: string }): Promise<MonthlyReportData> {
  const from = `${input.period}-01`;
  const [year, month] = input.period.split("-").map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const to = addDays(nextMonth, -1);
  const [workspace, delivery, occurrences, risks, dashboard] = await Promise.all([
    d1.prepare("SELECT name FROM fdp_workspaces WHERE id = ?").bind(input.workspaceId).first<{ name: string }>(),
    d1.prepare(`SELECT
        COUNT(*) FILTER (WHERE c.closed_at >= ?::date AND c.closed_at < ?::date)::int AS delivered,
        COUNT(*) FILTER (WHERE c.closed_at >= ?::date AND c.closed_at < ?::date AND c.due_at IS NOT NULL AND c.closed_at > c.due_at)::int AS delivered_late,
        COUNT(*) FILTER (WHERE c.created_at >= ?::date AND c.created_at < ?::date)::int AS created
      FROM fdp_cards c WHERE c.workspace_id = ?`)
      .bind(from, nextMonth, from, nextMonth, from, nextMonth, input.workspaceId).first<Row>(),
    d1.prepare(`SELECT COALESCE(NULLIF(o.area, ''), 'Sem área') AS area, COUNT(*)::int AS total, COALESCE(SUM(o.days_late), 0)::int AS days_late
      FROM fdp_dp_occurrences o WHERE o.workspace_id = ? AND o.occurred_on >= ?::date AND o.occurred_on < ?::date
      GROUP BY 1 ORDER BY total DESC, area LIMIT 20`)
      .bind(input.workspaceId, from, nextMonth).all<Row>(),
    d1.prepare(`SELECT a.title, a.due_date::text AS due_date, a.severity FROM fdp_dp_alerts a
      WHERE a.workspace_id = ? AND a.status = 'open' AND a.alert_type IN ('experience_45', 'experience_90', 'vacation_deadline')
        AND a.due_date <= ?::date + 30
      ORDER BY a.due_date LIMIT 40`)
      .bind(input.workspaceId, input.today).all<Row>(),
    loadDpDashboard(d1, { workspaceId: input.workspaceId, from, to }),
  ]);
  return {
    workspaceName: String(workspace?.name ?? ""),
    period: input.period,
    delivered: Number(delivery?.delivered ?? 0),
    deliveredLate: Number(delivery?.delivered_late ?? 0),
    createdInPeriod: Number(delivery?.created ?? 0),
    occurrencesByArea: occurrences.results.map((row) => ({ area: String(row.area), total: Number(row.total), daysLate: Number(row.days_late) })),
    outsideCutoff: dashboard.byArea,
    risks: risks.results.map((row) => ({ title: String(row.title), dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null, severity: String(row.severity) })),
    holders: dashboard.holders,
  };
}
