import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const name = text(body.name, 80);
    const description = text(body.description, 300);
    if (!name) return Response.json({ error: "Informe o nome do quadro." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const boardId = crypto.randomUUID();
    const boardType = text(body.boardType, 30) || "general";
    const columns = [
      ["Novas demandas", "new", "running"],
      ["Em análise", "analysis", "running"],
      ["Concluído", "done", "completed"],
    ] as const;
    await d1.batch([
      d1.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, ?, ?, ?)").bind(boardId, workspace.id, name, description, boardType),
      ...columns.map(([label, kind, behavior], index) => d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), boardId, label, kind, (index + 1) * 1000, behavior)),
      d1.prepare("UPDATE fdp_user_workspace_preferences SET active_board_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?").bind(boardId, user.id, workspace.id),
    ]);
    await recordActivity(workspace.id, null, auth.user.email, "board.created", { boardId, name });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
