import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { alertTypeLabels, severityLabels, summarizeAlerts, type AlertSeverity, type AlertType } from "@/lib/dp-alerts";

/**
 * Alertas do DP com a contagem por tipo e por titular (o "dashboard da
 * Central"). Cada alerta leva à ficha do colaborador.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar os alertas do DP");
    const status = new URL(request.url).searchParams.get("situacao") === "respondidos" ? "answered" : "open";
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const rows = await d1.prepare(`SELECT a.id, a.alert_type, a.severity, a.title, a.detail, a.due_date::text AS due_date, a.employee_id,
        a.company_id, a.status, a.decision, a.decision_note, a.decision_source, a.decided_at, a.manager_email,
        u.name AS assigned_name, COALESCE(NULLIF(co.trade_name, ''), co.legal_name, '') AS company_name
      FROM fdp_dp_alerts a
      LEFT JOIN fdp_users u ON u.id = a.assigned_user_id
      LEFT JOIN fdp_companies co ON co.workspace_id = a.workspace_id AND co.id = a.company_id
      WHERE a.workspace_id = ? AND a.status = ?
        AND (? OR a.company_id IN (SELECT mca.company_id FROM fdp_member_company_access mca WHERE mca.workspace_id = a.workspace_id AND mca.user_id = ?))
      ORDER BY CASE a.severity WHEN 'overdue' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, a.due_date NULLS LAST, a.title
      LIMIT 1000`)
      .bind(workspace.id, status, access.unrestricted, user.id).all<Record<string, unknown>>();
    const alerts = rows.results.map((row) => ({
      id: String(row.id), type: String(row.alert_type), typeLabel: alertTypeLabels[row.alert_type as AlertType] ?? String(row.alert_type),
      severity: String(row.severity), severityLabel: severityLabels[row.severity as AlertSeverity] ?? String(row.severity),
      title: String(row.title), detail: String(row.detail ?? ""), dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
      employeeId: row.employee_id ? String(row.employee_id) : null, companyName: String(row.company_name ?? ""),
      assignedName: row.assigned_name ? String(row.assigned_name) : null, managerEmail: String(row.manager_email ?? ""),
      decision: row.decision ? String(row.decision) : null, decisionNote: String(row.decision_note ?? ""),
      decisionSource: row.decision_source ? String(row.decision_source) : null,
      decidedAt: row.decided_at ? new Date(String(row.decided_at)).toISOString() : null,
    }));
    return Response.json({ status, alerts, ...summarizeAlerts(alerts) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
