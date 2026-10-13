import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";
import { historyRecordFromRow, previousDay, todayInBrazil } from "@/lib/employee-history";
import { expectedEsocialEvents, lastDayOfCompetence } from "@/lib/erp-dp";
import { companyScopeClause } from "@/lib/erp-dp-service";

/**
 * ERP DP — eventos do eSocial esperados na competência (docs/engenharia-reversa-sap-hcm.md §8.2).
 *
 * Lista de conferência derivada do Histórico funcional: o que mudou no mês e
 * qual evento não periódico o sistema de folha precisa ter transmitido.
 * O Vinculato ainda não gera nem transmite eSocial — confere. A conferência
 * de cada evento é gravada por `POST /api/erp-dp/esocial/checks`.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const url = new URL(request.url);
    const competence = url.searchParams.get("competence") ? validCompetence(url.searchParams.get("competence")) : todayInBrazil().slice(0, 7);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, companyId, "e.company_id");
    if (!scope) return Response.json({ competence, events: [], summary: { total: 0, transmitted: 0, notApplicable: 0, pending: 0 } });

    // Um mês antes do início entra para saber de onde a situação veio
    // (afastado → ativo é término de afastamento, não admissão).
    const start = previousDay(`${competence}-01`);
    const end = lastDayOfCompetence(competence);
    const rows = await d1.prepare(`SELECT h.*, e.full_name, e.social_name, e.registration_number, e.company_id AS employee_company_id
      FROM fdp_employee_history_records h
      JOIN fdp_employees e ON e.workspace_id = h.workspace_id AND e.id = h.employee_id
      WHERE h.workspace_id = ? AND ${scope.clause} AND h.valid_to >= ?::date AND h.valid_from <= (?::date + 1)`)
      .bind(workspace.id, ...scope.values, start, end).all<Record<string, unknown>>();
    const people = new Map(rows.results.map((row) => [String(row.employee_id), {
      name: String(row.social_name || row.full_name), registrationNumber: String(row.registration_number),
    }]));
    const expected = expectedEsocialEvents(rows.results.map((row) => ({ ...historyRecordFromRow(row), employeeId: String(row.employee_id) })), competence);

    /* Conferência (ERP DP, passo 3): o que alguém já confirmou sobre cada
       evento — transmitido com recibo, ou não se aplica com motivo. */
    const recordIds = [...new Set(expected.map((event) => event.recordId))];
    const checks = recordIds.length
      ? (await d1.prepare(`SELECT history_record_id, event_code, event_date, status, receipt, notes, checked_at
          FROM fdp_esocial_event_checks WHERE workspace_id = ? AND history_record_id IN (${recordIds.map(() => "?").join(", ")})`)
        .bind(workspace.id, ...recordIds).all<Record<string, unknown>>()).results
      : [];
    const checkKey = (recordId: string, event: string, date: string) => `${recordId}|${event}|${date}`;
    const checkMap = new Map(checks.map((row) => [checkKey(String(row.history_record_id), String(row.event_code),
      String(row.event_date instanceof Date ? row.event_date.toISOString() : row.event_date).slice(0, 10)), row]));
    const events = expected.map((event) => {
      const check = checkMap.get(checkKey(event.recordId, event.event, event.date));
      return {
        ...event,
        employeeName: people.get(event.employeeId)?.name ?? "",
        registrationNumber: people.get(event.employeeId)?.registrationNumber ?? "",
        check: check ? { status: String(check.status), receipt: String(check.receipt), notes: String(check.notes), checkedAt: String(check.checked_at) } : null,
      };
    });
    const summary = {
      total: events.length,
      transmitted: events.filter((event) => event.check?.status === "transmitted").length,
      notApplicable: events.filter((event) => event.check?.status === "not_applicable").length,
      pending: events.filter((event) => !event.check).length,
    };
    return Response.json({ competence, events, summary });
  } catch (error) { return apiError(error); }
}
