import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import type { WorkspaceRole } from "@/lib/fila-dp-types";

type RouteContext = { params: Promise<{ id: string }> };
const memberRoles: WorkspaceRole[] = ["admin", "member", "observer", "guest"];

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { role?: WorkspaceRole };
    if (!body.role || !memberRoles.includes(body.role)) {
      return Response.json({ error: "Papel de acesso inválido." }, { status: 400 });
    }
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const member = await d1.prepare(
      `SELECT u.email, CASE WHEN w.owner_user_id = wm.user_id THEN 1 ELSE 0 END AS is_owner
       FROM fdp_workspace_members wm
       JOIN fdp_users u ON u.id = wm.user_id
       JOIN fdp_workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = ? AND wm.user_id = ?`,
    ).bind(workspace.id, id).first<{ email: string; is_owner: number }>();
    if (!member) throw new Error("Membro não encontrado.");
    if (Boolean(member.is_owner) && body.role !== "admin") {
      return Response.json({ error: "O proprietário precisa permanecer administrador." }, { status: 400 });
    }
    await d1.prepare("UPDATE fdp_workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?")
      .bind(body.role, workspace.id, id)
      .run();
    await recordActivity(workspace.id, null, auth.user.email, "workspace.member_role_changed", { email: member.email, role: body.role });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const member = await d1.prepare(
      `SELECT u.email, CASE WHEN w.owner_user_id = wm.user_id THEN 1 ELSE 0 END AS is_owner
       FROM fdp_workspace_members wm
       JOIN fdp_users u ON u.id = wm.user_id
       JOIN fdp_workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = ? AND wm.user_id = ?`,
    ).bind(workspace.id, id).first<{ email: string; is_owner: number }>();
    if (!member) throw new Error("Membro não encontrado.");
    if (Boolean(member.is_owner)) {
      return Response.json({ error: "O proprietário não pode ser removido." }, { status: 400 });
    }
    if (id === user.id) {
      return Response.json({ error: "Você não pode remover seu próprio acesso por esta tela." }, { status: 400 });
    }
    await d1.batch([
      d1.prepare("DELETE FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?").bind(workspace.id, id),
      d1.prepare("UPDATE fdp_user_workspace_preferences SET active_workspace_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?").bind(id, workspace.id),
    ]);
    await recordActivity(workspace.id, null, auth.user.email, "workspace.member_removed", { email: member.email });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
