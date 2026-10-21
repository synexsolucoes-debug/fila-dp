import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { companyScopeClause } from "@/lib/erp-dp-service";
import { todayInBrazil } from "@/lib/employee-history";
import { addDays } from "@/lib/payroll-calc";
import { mostUrgentPeriod, vacationPeriods } from "@/lib/vacation-balance";
import { schedulesOf } from "@/lib/vacation-service";

/**
 * Painel de férias do ERP DP (§4.39): para cada pessoa com vínculo, o período
 * que mais aperta (vencido, vencendo ou disponível), o saldo e o fim do
 * concessivo; e as férias programadas que começam nos próximos dias.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const url = new URL(request.url);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, url.searchParams.get("companyId") ?? "", "e.company_id");
    const today = todayInBrazil();
    if (!scope) return Response.json({ today, items: [], upcoming: [] });
    const rows = await d1.prepare(`SELECT e.id, e.full_name, e.social_name, e.registration_number, e.admission_date, e.company_id,
        COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name
      FROM fdp_employees e JOIN fdp_companies c ON c.workspace_id = e.workspace_id AND c.id = e.company_id
      WHERE e.workspace_id = ? AND e.employment_status <> 'terminated' AND ${scope.clause}
      ORDER BY e.full_name LIMIT 1000`).bind(workspace.id, ...scope.values).all<Record<string, unknown>>();
    const employees = rows.results ?? [];
    const schedules = await schedulesOf(d1, workspace.id, employees.map((row) => String(row.id)));
    const horizon = addDays(today, Number(url.searchParams.get("days") ?? 60));
    const items = employees.map((row) => {
      const admission = (row.admission_date instanceof Date ? row.admission_date.toISOString() : String(row.admission_date)).slice(0, 10);
      const own = schedules.filter((item) => item.employeeId === String(row.id));
      const periods = vacationPeriods(admission, today, own);
      const urgent = mostUrgentPeriod(periods);
      return {
        employeeId: String(row.id), name: String(row.social_name || row.full_name), registrationNumber: String(row.registration_number ?? ""),
        companyName: String(row.company_name ?? ""), admissionDate: admission,
        period: urgent, overduePeriods: periods.filter((period) => period.status === "overdue").length,
        nextSchedule: own.filter((item) => item.status !== "canceled" && item.status !== "taken" && item.startDate >= today)[0] ?? null,
      };
    }).sort((a, b) => (a.period?.concessiveEnd ?? "9999").localeCompare(b.period?.concessiveEnd ?? "9999"));
    const names = new Map(items.map((item) => [item.employeeId, item]));
    const upcoming = schedules.filter((item) => item.status !== "canceled" && item.status !== "taken" && item.startDate >= today && item.startDate <= horizon)
      .map((item) => ({ ...item, name: names.get(item.employeeId)?.name ?? "", registrationNumber: names.get(item.employeeId)?.registrationNumber ?? "" }));
    return Response.json({ today, items, upcoming });
  } catch (error) { return apiError(error); }
}
