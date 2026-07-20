import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const result = await d1.prepare("UPDATE fdp_cards SET archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND board_id = ? AND archived = 1").bind(id, board.id).run();
    if (!result.meta.changes) throw new Error("Demanda arquivada não encontrada.");
    await recordActivity(workspace.id, id, auth.user.email, "card.restored");
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
