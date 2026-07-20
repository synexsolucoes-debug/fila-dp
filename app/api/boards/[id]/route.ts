import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const name = text(body.name, 80);
    const description = text(body.description, 300);
    if (!name) return Response.json({ error: "Informe o nome do quadro." }, { status: 400 });
    const result = await d1.prepare("UPDATE fdp_boards SET name = ?, description = ? WHERE id = ? AND workspace_id = ?").bind(name, description, id, workspace.id).run();
    if (!result.meta.changes) return Response.json({ error: "Quadro não encontrado." }, { status: 404 });
    await recordActivity(workspace.id, null, auth.user.email, "board.updated", { boardId: id, name });
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
    const count = await d1.prepare("SELECT COUNT(*) AS value FROM fdp_boards WHERE workspace_id = ?").bind(workspace.id).first<{ value: number }>();
    if (Number(count?.value ?? 0) <= 1) return Response.json({ error: "O workspace precisa manter pelo menos um quadro." }, { status: 400 });
    const result = await d1.prepare("DELETE FROM fdp_boards WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).run();
    if (!result.meta.changes) return Response.json({ error: "Quadro não encontrado." }, { status: 404 });
    await d1.prepare("UPDATE fdp_user_workspace_preferences SET active_board_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_board_id = ?").bind(user.id, id).run();
    await recordActivity(workspace.id, null, auth.user.email, "board.deleted", { boardId: id });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
