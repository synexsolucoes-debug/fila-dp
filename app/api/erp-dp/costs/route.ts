import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { companyScopeClause } from "@/lib/erp-dp-service";
import { lastDayOfCompetence } from "@/lib/erp-dp";
import { runResults } from "@/lib/payroll-run-service";
import { companySettings } from "@/lib/payroll-settings-service";
import { remunerationAt, remunerationFromRow, type Remuneration } from "@/lib/remuneration";
import { costTotals, employeeCost, groupCosts, type EmployeeCost } from "@/lib/payroll-costs";
import { toCsv } from "@/lib/payroll-obligations";

/**
 * Custo de pessoal do ERP DP (§4.42): por pessoa, centro de custo e
 * departamento, com encargos, FGTS, provisões de férias e 13º e o
 * vale-transporte que a empresa banca; e a evolução das folhas fechadas.
 * `format=csv` devolve a planilha por pessoa.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const url = new URL(request.url);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, url.searchParams.get("companyId") ?? "", "r.company_id");
    if (!scope) return Response.json({ competence: null, competences: [], costs: [], byCostCenter: [], byDepartment: [], totals: null, evolution: [] });
    const competences = (await d1.prepare(`SELECT DISTINCT r.competence FROM fdp_payroll_runs r WHERE r.workspace_id = ? AND ${scope.clause}
        ORDER BY r.competence DESC LIMIT 24`).bind(workspace.id, ...scope.values).all<{ competence: string }>()).results ?? [];
    const requested = url.searchParams.get("competence") ?? "";
    const competence = competences.some((row) => row.competence === requested) ? requested : competences[0]?.competence ?? null;
    let costs: EmployeeCost[] = [];
    if (competence) {
      const runs = (await d1.prepare(`SELECT r.id, r.company_id FROM fdp_payroll_runs r WHERE r.workspace_id = ? AND r.competence = ? AND ${scope.clause}`)
        .bind(workspace.id, competence, ...scope.values).all<{ id: string; company_id: string }>()).results ?? [];
      for (const run of runs) {
        const settings = await companySettings(d1, workspace.id, run.company_id);
        const results = await runResults(d1, workspace.id, run.id);
        const people = (await d1.prepare(`SELECT e.id, d.name AS department_name, cc.name AS cost_center_name FROM fdp_employees e
            LEFT JOIN fdp_departments d ON d.workspace_id = e.workspace_id AND d.id = e.department_id
            LEFT JOIN fdp_cost_centers cc ON cc.workspace_id = e.workspace_id AND cc.id = e.cost_center_id
            WHERE e.workspace_id = ? AND e.company_id = ?`).bind(workspace.id, run.company_id).all<Record<string, unknown>>()).results ?? [];
        const labels = new Map(people.map((row) => [String(row.id), { department: String(row.department_name ?? ""), costCenter: String(row.cost_center_name ?? "") }]));
        const remunerationRows = (await d1.prepare(`SELECT r.* FROM fdp_employee_remuneration r JOIN fdp_employees e ON e.workspace_id = r.workspace_id AND e.id = r.employee_id
            WHERE r.workspace_id = ? AND e.company_id = ?`).bind(workspace.id, run.company_id).all<Record<string, unknown>>()).results ?? [];
        const byEmployee = new Map<string, Remuneration[]>();
        for (const row of remunerationRows) {
          const list = byEmployee.get(String(row.employee_id)) ?? [];
          list.push(remunerationFromRow(row));
          byEmployee.set(String(row.employee_id), list);
        }
        for (const result of results) {
          const label = labels.get(result.employeeId);
          const remuneration = remunerationAt(byEmployee.get(result.employeeId) ?? [], lastDayOfCompetence(competence));
          costs.push(employeeCost({
            employeeId: result.employeeId, name: result.name, registrationNumber: result.registrationNumber,
            departmentName: label?.department ?? "", costCenterName: label?.costCenter ?? "",
            salaryCents: result.salaryCents, earningsCents: result.earningsCents, fgtsCents: result.fgtsCents,
            transportVoucherCents: remuneration?.transportVoucherCents ?? 0, lines: result.lines,
          }, settings));
        }
      }
      costs = costs.sort((a, b) => b.total - a.total);
    }
    if (url.searchParams.get("format") === "csv") {
      const money = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
      const csv = toCsv([["competencia", "matricula", "nome", "centro_de_custo", "departamento", "proventos", "encargos_patronais", "fgts",
        "provisao_ferias", "provisao_13", "encargos_provisoes", "vale_transporte", "custo_total"],
        ...costs.map((cost) => [competence ?? "", cost.registrationNumber, cost.name, cost.costCenterName, cost.departmentName, money(cost.earnings),
          money(cost.employerContribution), money(cost.fgts), money(cost.vacationProvision), money(cost.thirteenthProvision),
          money(cost.provisionCharges), money(cost.transportVoucher), money(cost.total)])]);
      return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="custo-pessoal-${competence ?? "sem-folha"}.csv"`, "Cache-Control": "no-store" } });
    }
    const evolution = (await d1.prepare(`SELECT r.competence, SUM(r.earnings_cents) AS earnings, SUM(r.net_cents) AS net, SUM(r.fgts_cents) AS fgts, SUM(r.employees_count) AS people
        FROM fdp_payroll_runs r WHERE r.workspace_id = ? AND r.status = 'closed' AND ${scope.clause}
        GROUP BY r.competence ORDER BY r.competence DESC LIMIT 12`).bind(workspace.id, ...scope.values).all<Record<string, unknown>>()).results ?? [];
    return Response.json({
      competence, competences: competences.map((row) => row.competence), costs,
      byCostCenter: groupCosts(costs, "costCenterName"), byDepartment: groupCosts(costs, "departmentName"), totals: costTotals(costs),
      evolution: evolution.reverse().map((row) => ({ competence: String(row.competence), earnings: Number(row.earnings), net: Number(row.net), fgts: Number(row.fgts), people: Number(row.people) })),
    });
  } catch (error) { return apiError(error); }
}
