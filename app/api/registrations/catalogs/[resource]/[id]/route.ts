import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, getCatalogResource } from "@/lib/registrations";

type Context = { params: Promise<{ resource: string; id: string }> };

export async function PATCH(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { resource: key, id } = await context.params;
    const resource = getCatalogResource(key);
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "registrations.catalogs.manage");
    const current = await d1.prepare(`SELECT * FROM ${resource.table} WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound(`${resource.label} não encontrado.`, "CATALOG_ITEM_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    const code = cleanText(body.code, 50) || String(current.code);
    const name = cleanText(body.name, 160) || String(current.name);
    const status = body.status === "inactive" ? "inactive" : body.status === "active" ? "active" : String(current.status);
    const duplicate = await d1.prepare(`SELECT id FROM ${resource.table} WHERE workspace_id = ? AND company_id = ? AND code = ? AND id <> ?`)
      .bind(workspace.id, current.company_id, code, id).first();
    if (duplicate) throw new ApiError(409, "CATALOG_CODE_CONFLICT", `Já existe ${resource.label.toLowerCase()} com este código.`);
    let update: D1PreparedStatement;
    if (key === "positions") {
      update = d1.prepare(`UPDATE ${resource.table} SET code = ?, name = ?, cbo_code = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(code, name, Object.hasOwn(body, "cboCode") ? cleanText(body.cboCode, 20) : current.cbo_code, status, workspace.id, id);
    } else if (key === "work-schedules") {
      const weeklyHours = Object.hasOwn(body, "weeklyHours") ? Math.min(Math.max(Number(body.weeklyHours) || 44, 1), 60) : current.weekly_hours;
      update = d1.prepare(`UPDATE ${resource.table} SET code = ?, name = ?, weekly_hours = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(code, name, weeklyHours, Object.hasOwn(body, "description") ? cleanText(body.description, 500) : current.description, status, workspace.id, id);
    } else if (key === "departments") {
      update = d1.prepare(`UPDATE ${resource.table} SET code = ?, name = ?, parent_department_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(code, name, Object.hasOwn(body, "parentDepartmentId") ? (cleanText(body.parentDepartmentId, 120) || null) : current.parent_department_id, status, workspace.id, id);
    } else {
      update = d1.prepare(`UPDATE ${resource.table} SET code = ?, name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(code, name, status, workspace.id, id);
    }
    const after = { ...current, code, name, status };
    await d1.batch([update, prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `registration.${key}.updated`, entityType: `registration_${key}`, entityId: id, before: current, after,
      requestId: request.headers.get("x-fila-dp-request-id") })]);
    return Response.json({ item: after });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { resource: key, id } = await context.params;
    const resource = getCatalogResource(key);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "registrations.catalogs.manage");
    const current = await d1.prepare(`SELECT * FROM ${resource.table} WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound(`${resource.label} não encontrado.`, "CATALOG_ITEM_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    await d1.batch([
      d1.prepare(`UPDATE ${resource.table} SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: `registration.${key}.inactivated`, entityType: `registration_${key}`, entityId: id, before: current, after: { ...current, status: "inactive" },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ item: { ...current, status: "inactive" } });
  } catch (error) { return apiError(error); }
}
