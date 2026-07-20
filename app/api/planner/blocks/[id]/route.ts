import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const owner = await d1.prepare("SELECT user_id FROM fdp_planner_blocks WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).first<{ user_id: string }>();
    if (!owner) return Response.json({ error: "Bloco não encontrado." }, { status: 404 });
    if (owner.user_id !== user.id && workspace.role !== "admin") return Response.json({ error: "Você só pode alterar seus próprios blocos." }, { status: 403 });
    await d1.prepare("UPDATE fdp_planner_blocks SET title = ?, start_at = ?, end_at = ?, block_type = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(text(body.title, 160), text(body.startAt, 40), text(body.endAt, 40), text(body.blockType, 30) || "focus", text(body.notes, 500), id).run();
    await recordActivity(workspace.id, null, auth.user.email, "planner.block_updated", { blockId: id });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) { return apiError(error); }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const owner = await d1.prepare("SELECT user_id FROM fdp_planner_blocks WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).first<{ user_id: string }>();
    if (!owner) return Response.json({ error: "Bloco não encontrado." }, { status: 404 });
    if (owner.user_id !== user.id && workspace.role !== "admin") return Response.json({ error: "Você só pode excluir seus próprios blocos." }, { status: 403 });
    await d1.prepare("DELETE FROM fdp_planner_blocks WHERE id = ?").bind(id).run();
    await recordActivity(workspace.id, null, auth.user.email, "planner.block_deleted", { blockId: id });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) { return apiError(error); }
}
