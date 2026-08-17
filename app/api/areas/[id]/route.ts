import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { areaCode, areaModuleList, areaName } from "@/lib/areas";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "departments.view", "consultar áreas operacionais");
    const area = await d1.prepare("SELECT * FROM fdp_areas WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first();
    if (!area) throw ApiError.notFound("Área não encontrada.", "AREA_NOT_FOUND");
    const [members, modules] = await Promise.all([
      d1.prepare(`SELECT am.*, u.name, u.email FROM fdp_area_members am JOIN fdp_users u ON u.id = am.user_id
        WHERE am.workspace_id = ? AND am.area_id = ? ORDER BY am.is_primary DESC, u.name`).bind(workspace.id, id).all(),
      d1.prepare("SELECT module_key FROM fdp_area_module_assignments WHERE workspace_id = ? AND area_id = ? ORDER BY module_key")
        .bind(workspace.id, id).all(),
    ]);
    const canManageMembers = hasCapability(workspace, "departments.manage_members");
    return Response.json({
      area,
      members: members.results.map((member) => canManageMembers ? member : { ...(member as Record<string, unknown>), email: "" }),
      moduleKeys: modules.results.map((row) => String((row as { module_key: string }).module_key)),
    });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "departments.edit", "editar áreas operacionais");
    const before = await d1.prepare("SELECT * FROM fdp_areas WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!before) throw ApiError.notFound("Área não encontrada.", "AREA_NOT_FOUND");
    const next = {
      name: body.name === undefined ? String(before.name) : areaName(body.name),
      code: body.code === undefined ? String(before.code) : areaCode(body.code),
      description: body.description === undefined ? String(before.description) : cleanText(body.description, 1000),
      managerUserId: body.managerUserId === undefined ? before.manager_user_id : cleanText(body.managerUserId, 120) || null,
      color: body.color === undefined ? String(before.color) : cleanText(body.color, 20) || "#475569",
      icon: body.icon === undefined ? String(before.icon) : cleanText(body.icon, 40) || "building-2",
      defaultSlaDays: body.defaultSlaDays === undefined ? Number(before.default_sla_days) : Math.min(Math.max(Math.trunc(Number(body.defaultSlaDays)), 0), 365),
      status: body.status === undefined ? String(before.status) : cleanText(body.status, 20),
    };
    if (!["active", "inactive", "archived"].includes(next.status)) throw ApiError.badRequest("Status de área inválido.", "AREA_STATUS_INVALID");
    if (next.managerUserId) {
      const member = await d1.prepare("SELECT user_id FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?")
        .bind(workspace.id, next.managerUserId).first();
      if (!member) throw ApiError.badRequest("O responsável precisa ser integrante deste grupo.", "AREA_MANAGER_NOT_MEMBER");
    }
    if (next.code !== String(before.code)) {
      const duplicate = await d1.prepare("SELECT id FROM fdp_areas WHERE workspace_id = ? AND code = ? AND id <> ?")
        .bind(workspace.id, next.code, id).first();
      if (duplicate) throw new ApiError(409, "AREA_CODE_CONFLICT", "Já existe uma área com este código.");
    }
    const statements = [d1.prepare(`UPDATE fdp_areas SET name = ?, code = ?, description = ?, manager_user_id = ?, color = ?, icon = ?,
      default_sla_days = ?, status = ?, archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, now()) ELSE NULL END,
      updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
      .bind(next.name, next.code, next.description, next.managerUserId, next.color, next.icon,
        next.defaultSlaDays, next.status, next.status, user.id, workspace.id, id)];
    if (body.moduleKeys !== undefined) {
      const modules = areaModuleList(body.moduleKeys);
      statements.push(d1.prepare("DELETE FROM fdp_area_module_assignments WHERE workspace_id = ? AND area_id = ?").bind(workspace.id, id));
      statements.push(...modules.map((moduleKey) => d1.prepare(`INSERT INTO fdp_area_module_assignments
        (workspace_id, module_key, area_id, created_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, module_key) DO UPDATE SET area_id = EXCLUDED.area_id, updated_at = now()`)
        .bind(workspace.id, moduleKey, id, user.id)));
    }
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "area.updated", entityType: "area", entityId: id, before, after: next,
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));
    await d1.batch(statements);
    return Response.json({ area: { id, ...next } });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "departments.archive", "arquivar áreas operacionais");
    const before = await d1.prepare("SELECT * FROM fdp_areas WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first();
    if (!before) throw ApiError.notFound("Área não encontrada.", "AREA_NOT_FOUND");
    await d1.batch([
      d1.prepare("UPDATE fdp_areas SET status = 'archived', archived_at = now(), updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
        .bind(user.id, workspace.id, id),
      d1.prepare("DELETE FROM fdp_area_module_assignments WHERE workspace_id = ? AND area_id = ?").bind(workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "area.archived", entityType: "area", entityId: id, before, after: { status: "archived" },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ ok: true, area: { id, status: "archived" } });
  } catch (error) { return apiError(error); }
}
