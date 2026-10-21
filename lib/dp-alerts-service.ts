/**
 * DP Operacional, Fase 4 — grava, atualiza e encerra os alertas do dia.
 *
 * A regra está em `lib/dp-alerts.ts`. Cada alerta tem uma chave estável (tipo
 * + colaborador/empresa + marco): o job diário atualiza o mesmo alerta em vez
 * de criar outro, encerra o que deixou de valer (efetivado, férias lançadas,
 * cadastro corrigido) e nunca reescreve um alerta já respondido pelo gestor.
 * O responsável é quem responde pela empresa na carteira (`responsavelPara`).
 */
import type { getD1 } from "../db/index.ts";
import { computeAlerts, type AlertCompany, type AlertEmployee } from "./dp-alerts.ts";
import { sankhyaEmployeeCode } from "./payroll-movements.ts";
import { responsavelPara } from "./portfolio-assignment.ts";

type Database = ReturnType<typeof getD1>;
type Row = Record<string, unknown>;

export async function loadAlertInputs(d1: Database, workspaceId: string) {
  const [employees, companies] = await Promise.all([
    d1.prepare(`SELECT e.id, e.full_name, e.social_name, e.company_id, e.admission_date::text AS admission_date, e.employment_status,
        e.employment_type, e.cpf_last4, e.external_id, e.registration_number,
        (SELECT COUNT(*)::int FROM fdp_employee_movements m
          WHERE m.workspace_id = e.workspace_id AND m.employee_id = e.id AND m.movement_type = 'vacation'
            AND m.status IN ('approved', 'applied')) AS vacations_taken,
        COALESCE(NULLIF(manager.email, ''), manager_user.email, '') AS manager_email
      FROM fdp_employees e
      LEFT JOIN fdp_employees manager ON manager.workspace_id = e.workspace_id AND manager.id = e.manager_employee_id
      LEFT JOIN fdp_workspace_members manager_member ON manager_member.workspace_id = e.workspace_id AND manager_member.employee_id = e.manager_employee_id
      LEFT JOIN fdp_users manager_user ON manager_user.id = manager_member.user_id
      WHERE e.workspace_id = ? AND e.employment_status <> 'terminated'`)
      .bind(workspaceId).all<Row>(),
    d1.prepare(`SELECT id, COALESCE(NULLIF(trade_name, ''), legal_name) AS name, tax_id, external_code, dp_status, status
      FROM fdp_companies WHERE workspace_id = ?`).bind(workspaceId).all<Row>(),
  ]);
  return {
    employees: employees.results.map((row): AlertEmployee => ({
      id: String(row.id),
      name: String(row.social_name || row.full_name || ""),
      companyId: String(row.company_id),
      admissionDate: String(row.admission_date).slice(0, 10),
      employmentStatus: String(row.employment_status ?? "active"),
      employmentType: String(row.employment_type ?? "clt"),
      cpfLast4: String(row.cpf_last4 ?? ""),
      sankhyaCode: sankhyaEmployeeCode({ externalId: String(row.external_id ?? ""), registrationNumber: String(row.registration_number ?? "") }),
      vacationsTaken: Number(row.vacations_taken ?? 0),
      managerEmail: String(row.manager_email ?? "").trim().toLowerCase(),
    })),
    companies: companies.results.map((row): AlertCompany => ({
      id: String(row.id), name: String(row.name ?? ""), taxId: String(row.tax_id ?? ""), code: String(row.external_code ?? ""),
      dpStatus: String(row.dp_status ?? "interno"), status: String(row.status ?? "active"),
    })),
  };
}

export async function refreshDpAlerts(d1: Database, input: { workspaceId: string; today: string }) {
  const { employees, companies } = await loadAlertInputs(d1, input.workspaceId);
  const expected = computeAlerts({ employees, companies, today: input.today });
  const responsible = new Map<string, string | null>();
  for (const companyId of new Set(expected.map((alert) => alert.companyId).filter((id): id is string => Boolean(id)))) {
    responsible.set(companyId, (await responsavelPara(d1, input.workspaceId, companyId, input.today)).userId);
  }
  const statements: D1PreparedStatement[] = expected.map((alert) => d1.prepare(`INSERT INTO fdp_dp_alerts
      (id, workspace_id, alert_key, alert_type, company_id, employee_id, due_date, severity, title, detail, assigned_user_id, manager_email)
      VALUES (?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, alert_key) DO UPDATE SET
        due_date = EXCLUDED.due_date, severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail,
        assigned_user_id = EXCLUDED.assigned_user_id, manager_email = EXCLUDED.manager_email, company_id = EXCLUDED.company_id,
        status = CASE WHEN fdp_dp_alerts.status = 'resolved' THEN 'open' ELSE fdp_dp_alerts.status END,
        resolved_at = CASE WHEN fdp_dp_alerts.status = 'resolved' THEN NULL ELSE fdp_dp_alerts.resolved_at END,
        updated_at = now()
      WHERE fdp_dp_alerts.status <> 'answered'`)
    .bind(crypto.randomUUID(), input.workspaceId, alert.key, alert.type, alert.companyId, alert.employeeId, alert.dueDate,
      alert.severity, alert.title.slice(0, 300), alert.detail.slice(0, 1000),
      alert.companyId ? responsible.get(alert.companyId) ?? null : null, alert.managerEmail.slice(0, 200)));
  // O que deixou de valer é encerrado; o respondido fica como registro.
  const keys = expected.map((alert) => alert.key);
  statements.push(d1.prepare(`UPDATE fdp_dp_alerts SET status = 'resolved', resolved_at = now(), updated_at = now()
    WHERE workspace_id = ? AND status = 'open' AND NOT (alert_key = ANY(?::text[]))`)
    .bind(input.workspaceId, `{${keys.map((key) => `"${key.replace(/["\\]/gu, "")}"`).join(",")}}`));
  for (let index = 0; index < statements.length; index += 200) await d1.batch(statements.slice(index, index + 200));
  const open = await d1.prepare("SELECT COUNT(*)::int AS total FROM fdp_dp_alerts WHERE workspace_id = ? AND status = 'open'")
    .bind(input.workspaceId).first<{ total: number }>();
  return { expected: expected.length, open: Number(open?.total ?? 0) };
}
