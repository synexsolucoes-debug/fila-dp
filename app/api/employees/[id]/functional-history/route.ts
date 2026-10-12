import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { optionalDate } from "@/lib/registrations";
import {
  currentValuesFromEmployee, divergencesAt, historyRecordFromRow, snapshotAt, timelineGaps, todayInBrazil,
} from "@/lib/employee-history";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Histórico funcional do colaborador (§4.27).
 *
 * `?at=AAAA-MM-DD` é a data-base — o "dia-chave" dos relatórios do SAP:
 * devolve a fotografia da pessoa naquele dia. Sem `at`, a data-base é hoje.
 *
 * Só leitura. O histórico é escrito pelas rotas que mudam o vínculo
 * (aplicar movimentação, demitir, editar o cadastro), no mesmo lote da
 * mudança — não existe "lançar histórico à mão", porque um registro que não
 * corresponde a nenhuma mudança é justamente o que o SAP proíbe.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const employee = await d1.prepare(`SELECT id, company_id, employment_status, establishment_id, department_id, position_id,
        cost_center_id, work_schedule_id, admission_date
      FROM fdp_employees WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(employee.company_id));

    const today = todayInBrazil();
    const at = optionalDate(new URL(request.url).searchParams.get("at")) ?? today;

    const result = await d1.prepare(`SELECT h.*,
        c.legal_name AS company_name, est.name AS establishment_name, d.name AS department_name,
        p.name AS position_name, cc.name AS cost_center_name, ws.name AS work_schedule_name
      FROM fdp_employee_history_records h
      LEFT JOIN fdp_companies c ON c.workspace_id = h.workspace_id AND c.id = h.company_id
      LEFT JOIN fdp_establishments est ON est.workspace_id = h.workspace_id AND est.id = h.establishment_id
      LEFT JOIN fdp_departments d ON d.workspace_id = h.workspace_id AND d.id = h.department_id
      LEFT JOIN fdp_positions p ON p.workspace_id = h.workspace_id AND p.id = h.position_id
      LEFT JOIN fdp_cost_centers cc ON cc.workspace_id = h.workspace_id AND cc.id = h.cost_center_id
      LEFT JOIN fdp_work_schedules ws ON ws.workspace_id = h.workspace_id AND ws.id = h.work_schedule_id
      WHERE h.workspace_id = ? AND h.employee_id = ?
      ORDER BY h.valid_from DESC, h.record_type`).bind(workspace.id, id).all<Record<string, unknown>>();

    const names = (row: Record<string, unknown>) => ({
      companyName: row.company_name ? String(row.company_name) : null,
      establishmentName: row.establishment_name ? String(row.establishment_name) : null,
      departmentName: row.department_name ? String(row.department_name) : null,
      positionName: row.position_name ? String(row.position_name) : null,
      costCenterName: row.cost_center_name ? String(row.cost_center_name) : null,
      workScheduleName: row.work_schedule_name ? String(row.work_schedule_name) : null,
    });
    const records = result.results.map((row) => ({ ...historyRecordFromRow(row), ...names(row) }));
    const snapshot = snapshotAt(records, at);

    return Response.json({
      at,
      today,
      records,
      snapshot,
      // Comparado com hoje, e não com a data-base: o cadastro é o agora.
      divergences: divergencesAt(records, currentValuesFromEmployee(employee), today),
      gaps: timelineGaps(records),
    });
  } catch (error) { return apiError(error); }
}
