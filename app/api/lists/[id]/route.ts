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
    const current = await d1.prepare("SELECT board_id FROM fdp_lists WHERE id = ?").bind(id).first<{ board_id: string }>();
    if (!current) return Response.json({ error: "Coluna não encontrada." }, { status: 404 });
    const name = text(body.name, 80);
    const position = Number(body.position);
    const slaBehavior = ["running", "paused", "completed"].includes(String(body.slaBehavior)) ? String(body.slaBehavior) : null;
    if (name && slaBehavior) await d1.prepare("UPDATE fdp_lists SET name = ?, position = ?, sla_behavior = ? WHERE id = ?").bind(name, Number.isFinite(position) ? position : 1000, slaBehavior, id).run();
    else if (name) await d1.prepare("UPDATE fdp_lists SET name = ?, position = ? WHERE id = ?").bind(name, Number.isFinite(position) ? position : 1000, id).run();
    else if (slaBehavior) await d1.prepare("UPDATE fdp_lists SET position = ?, sla_behavior = ? WHERE id = ?").bind(Number.isFinite(position) ? position : 1000, slaBehavior, id).run();
    else await d1.prepare("UPDATE fdp_lists SET position = ? WHERE id = ?").bind(Number.isFinite(position) ? position : 1000, id).run();
    await recordActivity(workspace.id, null, auth.user.email, "list.updated", { listId: id, boardId: current.board_id });
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
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const count = await d1.prepare("SELECT COUNT(*) AS value FROM fdp_lists WHERE board_id = (SELECT board_id FROM fdp_lists WHERE id = ?)").bind(id).first<{ value: number }>();
    if (Number(count?.value ?? 0) <= 1) return Response.json({ error: "O quadro precisa manter pelo menos uma coluna." }, { status: 400 });
    await d1.prepare("DELETE FROM fdp_lists WHERE id = ? AND board_id IN (SELECT id FROM fdp_boards WHERE workspace_id = ?)").bind(id, workspace.id).run();
    await recordActivity(workspace.id, null, auth.user.email, "list.deleted", { listId: id });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
