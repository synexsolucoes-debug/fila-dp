import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { scheduleTransitions } from "@/lib/vacation-service";

type RouteContext = { params: Promise<{ id: string }> };

/** Aprova, marca como gozada ou cancela uma programação de férias. Gozada não volta. */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.manage");
    const row = await d1.prepare("SELECT id, company_id, employee_id, status FROM fdp_vacation_schedules WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ id: string; company_id: string; employee_id: string; status: string }>();
    if (!row) throw ApiError.notFound("Programação não encontrada.", "VACATION_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, row.company_id);
    const next = String(body.status ?? "");
    if (!(scheduleTransitions[row.status] ?? []).includes(next)) {
      throw ApiError.badRequest(`Não é possível passar de "${row.status}" para "${next}".`, "VACATION_TRANSITION_INVALID");
    }
    await d1.batch([
      d1.prepare("UPDATE fdp_vacation_schedules SET status = ?, updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ? AND status = ?")
        .bind(next, user.id, workspace.id, id, row.status),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: `employee.vacation.${next}`, entityType: "employee", entityId: row.employee_id,
        before: { scheduleId: id, status: row.status }, after: { scheduleId: id, status: next },
        metadata: { scope: "company", companyId: row.company_id }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ id, status: next });
  } catch (error) { return apiError(error); }
}
