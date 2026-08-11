import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { ensureTimeSheet, recalculateTimeSheet, requireOpenTimeCycle } from "@/lib/time-service";

export const dynamic = "force-dynamic";

/** Folhas de ponto visíveis ao usuário, dentro do escopo de empresas dele. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const cycleId = cleanText(url.searchParams.get("competenceId"), 120);
    const status = cleanText(url.searchParams.get("status"), 20);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ sheets: [] });
    const where = ["s.workspace_id = ?"];
    const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`s.company_id IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }
    if (companyId) { where.push("s.company_id = ?"); values.push(companyId); }
    if (cycleId) { where.push("s.payroll_cycle_id = ?"); values.push(cycleId); }
    if (status) { where.push("s.status = ?"); values.push(status); }

    const rows = await d1.prepare(`SELECT s.id, s.company_id, s.employee_id, s.payroll_cycle_id, s.competence, s.status, s.source,
        s.entries_count, s.worked_minutes, s.expected_minutes, s.balance_minutes, s.blocking_issues, s.warning_issues,
        s.approved_at, s.exported_at, e.registration_number, e.full_name
      FROM fdp_time_sheets s JOIN fdp_employees e ON e.workspace_id = s.workspace_id AND e.id = s.employee_id
      WHERE ${where.join(" AND ")} ORDER BY s.competence DESC, e.registration_number LIMIT 500`)
      .bind(...values).all<Record<string, unknown>>();
    return Response.json({ sheets: rows.results });
  } catch (error) {
    return apiError(error);
  }
}

/** Abre a folha de ponto do colaborador na competência. */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.manage");

    const companyId = cleanText(body.companyId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    const employeeId = cleanText(body.employeeId, 120);
    if (!companyId || !cycleId || !employeeId) {
      throw ApiError.badRequest("Empresa, competência e colaborador são obrigatórios.", "TIME_SHEET_REQUIRED_FIELDS");
    }
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const cycle = await requireOpenTimeCycle(d1, workspace.id, companyId, cycleId);

    const sheet = await ensureTimeSheet(d1, { workspaceId: workspace.id, companyId, employeeId, cycle, userId: user.id });
    const recalculated = await recalculateTimeSheet(d1, workspace.id, sheet.id);

    if (sheet.created) {
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "time_sheet.created", entityType: "time_sheet", entityId: sheet.id,
        after: { competence: cycle.competence, companyId, employeeId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
    }

    return Response.json({
      sheet: { id: sheet.id, status: sheet.status, created: sheet.created },
      totals: recalculated.totals,
    }, { status: sheet.created ? 201 : 200 });
  } catch (error) {
    return apiError(error);
  }
}
