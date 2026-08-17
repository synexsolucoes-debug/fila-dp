import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { members?: Array<Record<string, unknown>> };
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "departments.manage_members", "gerenciar integrantes da área");
    const area = await d1.prepare("SELECT id, status FROM fdp_areas WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<{ id: string; status: string }>();
    if (!area) throw ApiError.notFound("Área não encontrada.", "AREA_NOT_FOUND");
    if (area.status === "archived") throw new ApiError(409, "AREA_ARCHIVED", "Uma área arquivada não aceita alterações de integrantes.");
    const members = (Array.isArray(body.members) ? body.members : []).slice(0, 500).map((item) => ({
      userId: cleanText(item.userId, 120), role: cleanText(item.role, 20) || "member", isPrimary: Boolean(item.isPrimary),
    }));
    if (members.some((item) => !item.userId || !["manager", "member", "observer"].includes(item.role))) {
      throw ApiError.badRequest("Integrante ou papel de área inválido.", "AREA_MEMBER_INVALID");
    }
    if (new Set(members.map((item) => item.userId)).size !== members.length) {
      throw ApiError.badRequest("O mesmo usuário foi informado mais de uma vez.", "AREA_MEMBER_DUPLICATE");
    }
    if (members.length) {
      const found = await d1.prepare(`SELECT user_id FROM fdp_workspace_members WHERE workspace_id = ? AND user_id IN (${members.map(() => "?").join(",")})`)
        .bind(workspace.id, ...members.map((item) => item.userId)).all<{ user_id: string }>();
      if (found.results.length !== members.length) throw ApiError.badRequest("Todos os integrantes precisam pertencer ao grupo.", "AREA_MEMBER_NOT_IN_WORKSPACE");
    }
    const [currentPrimaryInArea, primaryForSelected, owner, areaModules] = await Promise.all([
      d1.prepare("SELECT user_id FROM fdp_area_members WHERE workspace_id = ? AND area_id = ? AND is_primary = 1")
        .bind(workspace.id, id).all<{ user_id: string }>(),
      members.length
        ? d1.prepare(`SELECT user_id, area_id FROM fdp_area_members
            WHERE workspace_id = ? AND is_primary = 1 AND user_id IN (${members.map(() => "?").join(",")})`)
          .bind(workspace.id, ...members.map((item) => item.userId)).all<{ user_id: string; area_id: string }>()
        : Promise.resolve({ results: [] as Array<{ user_id: string; area_id: string }> }),
      d1.prepare("SELECT owner_user_id FROM fdp_workspaces WHERE id = ?").bind(workspace.id).first<{ owner_user_id: string }>(),
      d1.prepare(`SELECT assignment.module_key FROM fdp_area_module_assignments assignment
          JOIN fdp_modules module ON module.key = assignment.module_key AND module.status = 'active'
          WHERE assignment.workspace_id = ? AND assignment.area_id = ? ORDER BY module.position`)
        .bind(workspace.id, id).all<{ module_key: string }>(),
    ]);
    const nextPrimary = new Set(members.filter((item) => item.isPrimary).map((item) => item.userId));
    const removedPrimary = currentPrimaryInArea.results.find((item) =>
      item.user_id !== owner?.owner_user_id && !nextPrimary.has(String(item.user_id)));
    if (removedPrimary) {
      throw new ApiError(409, "MEMBER_PRIMARY_DEPARTMENT_REQUIRED",
        "Um usuário não pode ficar sem departamento principal. Mova a pessoa para outro departamento pela tela de usuários antes de removê-la daqui.");
    }
    const currentPrimaryByUser = new Map(primaryForSelected.results.map((item) => [String(item.user_id), String(item.area_id)]));
    const changedPrimaryUsers = members.filter((item) => item.isPrimary
      && item.userId !== owner?.owner_user_id && currentPrimaryByUser.get(item.userId) !== id);
    const realModuleKeys = areaModules.results.map((item) => String(item.module_key));
    if (changedPrimaryUsers.length && realModuleKeys.length === 0) {
      throw new ApiError(409, "DEPARTMENT_WITHOUT_MODULES",
        "Configure pelo menos um módulo do departamento antes de defini-lo como lotação principal de um usuário.");
    }
    await d1.batch([
      ...members.filter((item) => item.isPrimary).map((item) => d1.prepare("UPDATE fdp_area_members SET is_primary = 0, updated_at = now() WHERE workspace_id = ? AND user_id = ?")
        .bind(workspace.id, item.userId)),
      d1.prepare("DELETE FROM fdp_area_members WHERE workspace_id = ? AND area_id = ?").bind(workspace.id, id),
      ...members.map((item) => d1.prepare(`INSERT INTO fdp_area_members
        (id, workspace_id, area_id, user_id, role, is_primary, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, item.userId, item.role, item.isPrimary ? 1 : 0, user.id)),
      ...changedPrimaryUsers.flatMap((item) => [
        d1.prepare("DELETE FROM fdp_member_module_grants WHERE workspace_id = ? AND user_id = ?")
          .bind(workspace.id, item.userId),
        ...realModuleKeys.map((moduleKey) => d1.prepare(`INSERT INTO fdp_member_module_grants
            (workspace_id, user_id, module_key, granted, reason, granted_by)
            VALUES (?, ?, ?, true, ?, ?)`)
          .bind(workspace.id, item.userId, moduleKey, "Acesso definido pela lotação no departamento.", user.id)),
      ]),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "area.members_updated", entityType: "area", entityId: id,
        after: { members: members.map((item) => ({ userId: item.userId, role: item.role, isPrimary: item.isPrimary })) },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ members });
  } catch (error) { return apiError(error); }
}
