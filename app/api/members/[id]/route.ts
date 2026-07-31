import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import type { WorkspaceRole } from "@/lib/fila-dp-types";

type RouteContext = { params: Promise<{ id: string }> };
const memberRoles: WorkspaceRole[] = ["admin", "member", "observer", "guest"];

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { role?: WorkspaceRole; companyIds?: unknown[] };
    if (body.role !== undefined && !memberRoles.includes(body.role)) {
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
    if (Boolean(member.is_owner) && body.role !== undefined && body.role !== "admin") {
      return Response.json({ error: "O proprietário precisa permanecer administrador." }, { status: 400 });
    }
    if (body.role !== undefined) {
      await d1.prepare("UPDATE fdp_workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?")
        .bind(body.role, workspace.id, id)
        .run();
    }
    if (Array.isArray(body.companyIds)) {
      const companyIds = [...new Set(body.companyIds.map((companyId) => text(companyId, 120)).filter(Boolean))];
      const validCompanies = companyIds.length
        ? await d1.prepare(`SELECT id FROM fdp_companies WHERE workspace_id = ? AND id IN (${companyIds.map(() => "?").join(",")})`).bind(workspace.id, ...companyIds).all<{ id: string }>()
        : { results: [] as { id: string }[] };
      if (validCompanies.results.length !== companyIds.length) return Response.json({ error: "Uma ou mais empresas selecionadas não pertencem a este grupo." }, { status: 400 });
      await d1.batch([
        d1.prepare("DELETE FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ?").bind(workspace.id, id),
        ...companyIds.map((companyId) => d1.prepare("INSERT INTO fdp_member_company_access (workspace_id, user_id, company_id) VALUES (?, ?, ?)").bind(workspace.id, id, companyId)),
      ]);
    }
    await recordActivity(workspace.id, null, auth.user.email, "workspace.member_access_changed", { email: member.email, role: body.role ?? null, companyIds: Array.isArray(body.companyIds) ? body.companyIds : null });
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
      d1.prepare("DELETE FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ?").bind(workspace.id, id),
      d1.prepare("UPDATE fdp_user_workspace_preferences SET active_workspace_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?").bind(id, workspace.id),
    ]);
    await recordActivity(workspace.id, null, auth.user.email, "workspace.member_removed", { email: member.email });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
