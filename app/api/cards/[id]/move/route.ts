import { ApiError, apiError, computeSlaStatus, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireWorkspaceRole, runAutomations } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { resolveCardPosition } from "@/lib/card-position";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const toListId = text(body.toListId, 80);
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const card = await d1.prepare("SELECT id, list_id, due_at FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).first<{ id: string; list_id: string; due_at: string | null }>();
    const list = await d1.prepare("SELECT id, name, kind, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ?").bind(toListId, board.id).first<{ id: string; name: string; kind: string; sla_behavior: string }>();
    if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
    if (!list) throw ApiError.notFound("Coluna não encontrada.", "LIST_NOT_FOUND");
    /* Onde a demanda cai dentro da coluna: entre os vizinhos que a pessoa
       escolheu ao soltar, ou no fim quando nenhum foi informado. */
    const position = await resolveCardPosition(d1, {
      listId: toListId, cardId: id,
      beforeCardId: text(body.beforeCardId, 100), afterCardId: text(body.afterCardId, 100),
    });

    /* Reordenar dentro da mesma coluna não é mover: a etapa, o SLA e a data de
       conclusão ficam como estão, e não há evento nem automação de "movida". */
    if (card.list_id === toListId) {
      await d1.prepare("UPDATE fdp_cards SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND board_id = ?")
        .bind(position, id, board.id).run();
      return Response.json(await getWorkspaceSnapshot(auth.user));
    }

    await d1.prepare("UPDATE fdp_cards SET list_id = ?, position = ?, sla_status = ?, closed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END, archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND board_id = ?")
      .bind(toListId, position, computeSlaStatus(card.due_at, list.sla_behavior), list.sla_behavior, id, board.id)
      .run();
    const fromList = await d1.prepare("SELECT name, kind FROM fdp_lists WHERE id = ?").bind(card.list_id).first<{ name: string; kind: string }>();
    await recordActivity(workspace.id, id, auth.user.email, "card.moved", { fromListId: card.list_id, fromListName: fromList?.name ?? "Coluna anterior", toListId, toListName: list.name, automation: list.sla_behavior });
    await runAutomations(workspace.id, board.id, id, "card.moved", auth.user.email, { listKind: list.kind, fromListKind: fromList?.kind });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

