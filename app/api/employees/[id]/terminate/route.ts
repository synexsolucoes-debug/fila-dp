import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { optionalDate } from "@/lib/registrations";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const terminationDate = optionalDate(body.terminationDate, true);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.manage");
    const employee = await d1.prepare("SELECT id, company_id, full_name, employment_status, termination_date FROM fdp_employees WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(employee.company_id));
    await d1.batch([
      d1.prepare("UPDATE fdp_employees SET employment_status = 'terminated', termination_date = ?::date, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(terminationDate, user.id, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "employee.terminated",
        entityType: "employee", entityId: id, before: { employmentStatus: employee.employment_status, terminationDate: employee.termination_date },
        after: { employmentStatus: "terminated", terminationDate }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ terminated: true, terminationDate });
  } catch (error) { return apiError(error); }
}
