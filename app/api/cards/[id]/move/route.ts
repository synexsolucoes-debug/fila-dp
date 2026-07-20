import { apiError, computeSlaStatus, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole, runAutomations } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const toListId = text(body.toListId, 80);
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const card = await d1.prepare("SELECT id, list_id, due_at FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).first<{ id: string; list_id: string; due_at: string | null }>();
    const list = await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ?").bind(toListId, board.id).first<{ id: string; kind: string; sla_behavior: string }>();
    if (!card) throw new Error("Demanda não encontrada.");
    if (!list) throw new Error("Coluna não encontrada.");
    const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0").bind(toListId).first<{ max_position: number }>();

    await d1.prepare("UPDATE fdp_cards SET list_id = ?, position = ?, sla_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND board_id = ?")
      .bind(toListId, Number(position?.max_position ?? 0) + 1000, computeSlaStatus(card.due_at, list.sla_behavior), id, board.id)
      .run();
    await recordActivity(workspace.id, id, auth.user.email, "card.moved", { fromListId: card.list_id, toListId, automation: list.sla_behavior });
    const fromList = await d1.prepare("SELECT kind FROM fdp_lists WHERE id = ?").bind(card.list_id).first<{ kind: string }>();
    await runAutomations(workspace.id, board.id, id, "card.moved", auth.user.email, { listKind: list.kind, fromListKind: fromList?.kind });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

