import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot } from "@/lib/fila-dp-db";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as { boardId?: string };
    const boardId = text(body.boardId, 100);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const board = await d1.prepare("SELECT id FROM fdp_boards WHERE id = ? AND workspace_id = ?").bind(boardId, workspace.id).first<{ id: string }>();
    if (!board) return Response.json({ error: "Quadro não encontrado." }, { status: 404 });
    await d1.prepare("UPDATE fdp_user_workspace_preferences SET active_board_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?").bind(boardId, user.id, workspace.id).run();
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
