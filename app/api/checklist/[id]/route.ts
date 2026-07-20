import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { completed?: boolean };
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    const item = await d1.prepare(`SELECT ci.id, ci.card_id
      FROM fdp_checklist_items ci JOIN fdp_cards c ON c.id = ci.card_id
      WHERE ci.id = ? AND c.board_id = ? AND c.archived = 0`)
      .bind(id, board.id)
      .first<{ id: string; card_id: string }>();
    if (!item) throw new Error("Etapa não encontrada.");
    const completed = Boolean(body.completed);
    await d1.prepare("UPDATE fdp_checklist_items SET completed = ?, completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?")
      .bind(completed ? 1 : 0, completed ? 1 : 0, id)
      .run();

    const remaining = await d1.prepare("SELECT COUNT(*) AS count FROM fdp_checklist_items WHERE card_id = ? AND completed = 0").bind(item.card_id).first<{ count: number }>();
    if (Number(remaining?.count ?? 0) === 0) {
      const doneList = await d1.prepare("SELECT id FROM fdp_lists WHERE board_id = ? AND kind = 'done'").bind(board.id).first<{ id: string }>();
      if (doneList) {
        const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0").bind(doneList.id).first<{ max_position: number }>();
        await d1.prepare("UPDATE fdp_cards SET list_id = ?, position = ?, sla_status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(doneList.id, Number(position?.max_position ?? 0) + 1000, item.card_id)
          .run();
      }
    }
    await recordActivity(workspace.id, item.card_id, auth.user.email, "checklist.item_toggled", { itemId: id, completed });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

