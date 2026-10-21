import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type RouteContext = { params: Promise<{ id: string }> };

/** Revoga o link do portal do colaborador: a porta fecha na hora. */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.manage");
    const link = await d1.prepare("SELECT id, company_id, employee_id FROM fdp_employee_portal_links WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ id: string; company_id: string; employee_id: string }>();
    if (!link) throw ApiError.notFound("Link não encontrado.", "EMPLOYEE_PORTAL_LINK_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, link.company_id);
    await d1.batch([
      d1.prepare("UPDATE fdp_employee_portal_links SET revoked_at = now(), revoked_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL")
        .bind(user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "employee.portal_link.revoked", entityType: "employee", entityId: link.employee_id,
        before: { linkId: id }, after: { revoked: true },
        metadata: { scope: "company", companyId: link.company_id }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ revoked: true });
  } catch (error) { return apiError(error); }
}
