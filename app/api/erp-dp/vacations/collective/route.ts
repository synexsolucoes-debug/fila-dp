import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { todayInBrazil } from "@/lib/employee-history";
import { prepareSchedule, schedulesOf } from "@/lib/vacation-service";

/**
 * Férias coletivas (CLT arts. 139 a 141): uma decisão para a empresa ou um
 * departamento, que vira a programação de cada pessoa ativa. Quem não cabe
 * nas regras (saldo, fração) fica de fora com o motivo, e o resto segue — a
 * decisão não pode depender de a pessoa mais nova ter saldo.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const companyId = String(body.companyId ?? "");
    const departmentId = body.departmentId ? String(body.departmentId) : null;
    const restDays = Number(body.restDays);
    const startDate = String(body.startDate ?? "");
    if (!companyId) throw ApiError.badRequest("Escolha a empresa.", "VACATION_COMPANY_REQUIRED");
    if (!Number.isInteger(restDays) || restDays < 10 || restDays > 30) {
      throw ApiError.badRequest("Cada período de férias coletivas tem no mínimo 10 dias (CLT art. 139, §1º).", "COLLECTIVE_TOO_SHORT");
    }
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.manage");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const rows = await d1.prepare(`SELECT id, full_name, registration_number, admission_date FROM fdp_employees
        WHERE workspace_id = ? AND company_id = ? AND employment_status = 'active' AND (?::text IS NULL OR department_id = ?::text) ORDER BY full_name`)
      .bind(workspace.id, companyId, departmentId, departmentId).all<Record<string, unknown>>();
    const employees = rows.results ?? [];
    if (!employees.length) throw ApiError.badRequest("Nenhum colaborador ativo no grupo escolhido.", "COLLECTIVE_EMPTY");
    const schedules = await schedulesOf(d1, workspace.id, employees.map((row) => String(row.id)));
    const today = todayInBrazil();
    const collectiveId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    const skipped: Array<{ name: string; registrationNumber: string; reason: string }> = [];
    let planned = 0;
    for (const row of employees) {
      const admission = (row.admission_date instanceof Date ? row.admission_date.toISOString() : String(row.admission_date)).slice(0, 10);
      try {
        const schedule = prepareSchedule(d1, {
          workspaceId: workspace.id, companyId, employeeId: String(row.id), admissionDate: admission, today, userId: user.id,
          existing: schedules.filter((item) => item.employeeId === String(row.id)),
          body: { startDate, restDays, soldDays: 0, notes: String(body.notes ?? "Férias coletivas") }, collectiveId,
        });
        statements.push(schedule.statement);
        planned += 1;
      } catch (error) {
        skipped.push({ name: String(row.full_name), registrationNumber: String(row.registration_number ?? ""), reason: error instanceof Error ? error.message : "Não coube nas regras." });
      }
    }
    if (!planned) throw ApiError.badRequest("Ninguém do grupo coube nas regras das férias coletivas.", "COLLECTIVE_NONE_PLANNED");
    statements.unshift(d1.prepare(`INSERT INTO fdp_collective_vacations (id, workspace_id, company_id, department_id, start_date, rest_days, employees_count, notes, created_by)
      VALUES (?, ?, ?, ?, ?::date, ?, ?, ?, ?)`)
      .bind(collectiveId, workspace.id, companyId, departmentId, startDate, restDays, planned, String(body.notes ?? "").slice(0, 500), user.id));
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "vacation.collective.planned", entityType: "company", entityId: companyId,
      before: null, after: { collectiveId, startDate, restDays, planned, skipped: skipped.length, departmentId },
      metadata: { scope: "company", companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
    }));
    await d1.batch(statements);
    return Response.json({ collectiveId, planned, skipped }, { status: 201 });
  } catch (error) { return apiError(error); }
}
