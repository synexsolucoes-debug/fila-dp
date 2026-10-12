import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText, optionalDate } from "@/lib/registrations";
import { historyRecordFromRow, todayInBrazil, type EmploymentStatus } from "@/lib/employee-history";
import { headcountAt, summarizeHeadcount, type HeadcountEmployee } from "@/lib/erp-dp";
import { companyScopeClause } from "@/lib/erp-dp-service";

/**
 * ERP DP — quadro de pessoal numa data-base (docs/engenharia-reversa-sap-hcm.md §11.3).
 *
 * O "dia-chave" da base lógica PNP do SAP: quem tinha vínculo na data, em
 * que situação, onde e em qual jornada. Lê o Histórico funcional (§4.27) e,
 * para quem ainda não tem histórico, o cadastro de hoje — marcado como
 * aproximação, para a tela não apresentar estimativa como fato.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const url = new URL(request.url);
    const at = optionalDate(url.searchParams.get("at")) ?? todayInBrazil();
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, companyId, "e.company_id");
    if (!scope) return Response.json({ at, rows: [], summary: summarizeHeadcount([]), names: {} });

    const employees = await d1.prepare(`SELECT e.id, e.full_name, e.social_name, e.registration_number, e.admission_date, e.termination_date,
        e.employment_status, e.company_id, e.establishment_id, e.department_id, e.position_id, e.cost_center_id, e.work_schedule_id
      FROM fdp_employees e WHERE e.workspace_id = ? AND ${scope.clause} AND e.admission_date <= ?::date
      ORDER BY e.full_name LIMIT 5000`).bind(workspace.id, ...scope.values, at).all<Record<string, unknown>>();
    const records = await d1.prepare(`SELECT h.* FROM fdp_employee_history_records h
      JOIN fdp_employees e ON e.workspace_id = h.workspace_id AND e.id = h.employee_id
      WHERE h.workspace_id = ? AND ${scope.clause} AND h.valid_from <= ?::date AND h.valid_to >= ?::date`)
      .bind(workspace.id, ...scope.values, at, at).all<Record<string, unknown>>();

    const date = (value: unknown) => value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
    const text = (value: unknown) => value == null || value === "" ? null : String(value);
    const rows = headcountAt(
      employees.results.map((row): HeadcountEmployee => ({
        id: String(row.id), fullName: String(row.social_name || row.full_name), registrationNumber: String(row.registration_number),
        admissionDate: date(row.admission_date) ?? at, terminationDate: date(row.termination_date),
        employmentStatus: String(row.employment_status) as EmploymentStatus, companyId: String(row.company_id),
        establishmentId: text(row.establishment_id), departmentId: text(row.department_id), positionId: text(row.position_id),
        costCenterId: text(row.cost_center_id), workScheduleId: text(row.work_schedule_id),
      })),
      records.results.map((row) => ({ ...historyRecordFromRow(row), employeeId: String(row.employee_id) })),
      at,
    );

    // Nomes dos catálogos numa leitura só, em vez de JOIN por linha do quadro.
    const pairs = (statement: SqlPreparedStatement) => statement.bind(workspace.id).all<{ id: string; name: string }>().then((result) => result.results);
    const [departments, positions, costCenters, schedules, establishments, companies] = await Promise.all([
      pairs(d1.prepare("SELECT id, name FROM fdp_departments WHERE workspace_id = ?")),
      pairs(d1.prepare("SELECT id, name FROM fdp_positions WHERE workspace_id = ?")),
      pairs(d1.prepare("SELECT id, name FROM fdp_cost_centers WHERE workspace_id = ?")),
      pairs(d1.prepare("SELECT id, name FROM fdp_work_schedules WHERE workspace_id = ?")),
      pairs(d1.prepare("SELECT id, name FROM fdp_establishments WHERE workspace_id = ?")),
      pairs(d1.prepare("SELECT id, COALESCE(NULLIF(trade_name, ''), legal_name) AS name FROM fdp_companies WHERE workspace_id = ?")),
    ]);
    const map = (list: Array<{ id: string; name: string }>) => Object.fromEntries(list.map((item) => [item.id, item.name]));
    return Response.json({
      at, rows, summary: summarizeHeadcount(rows),
      names: { departments: map(departments), positions: map(positions), costCenters: map(costCenters), schedules: map(schedules), establishments: map(establishments), companies: map(companies) },
    });
  } catch (error) { return apiError(error); }
}
