import { ApiError, apiError, computeSlaStatus, getApiUser, text, validDueAt } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, prepareAuditEvent, recordActivity, requireCardCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { replaceCardRelations, stringIds } from "@/lib/fila-dp-relations";

/**
 * Uma ação sobre várias demandas de uma vez (spec: seleção em massa).
 *
 * A segunda-feira do DP é uma pilha de solicitações que chegaram no fim de
 * semana, e distribuí-las uma a uma custa um clique de abertura, um de
 * responsável e um de salvar por demanda. Isto existe para que a distribuição
 * seja um gesto só.
 *
 * Três decisões que não são detalhe:
 *
 *  * **Uma ação por chamada.** Nada de "atribuir e mudar o prazo e mover" no
 *    mesmo corpo. Ação composta é ação que falha pela metade, e desfazer a
 *    metade que passou seria trabalho manual de quem mandou.
 *  * **Acesso verificado por demanda.** O recorte de empresa é por pessoa; uma
 *    lista de ids não é autorização. Uma demanda fora do alcance derruba a
 *    chamada inteira em vez de ser ignorada em silêncio — silêncio aqui é a
 *    pessoa achar que mandou trinta e o sistema ter feito vinte e oito.
 *  * **Teto de cinquenta.** Acima disso não é operação, é importação — e
 *    importação tem outro caminho, com acompanhamento.
 */
const BULK_LIMIT = 50;

type BulkAction = "assign" | "priority" | "due" | "move";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");

    const cardIds = stringIds(body.cardIds);
    if (cardIds.length === 0) throw ApiError.badRequest("Selecione ao menos uma demanda.", "NO_CARDS_SELECTED");
    if (cardIds.length > BULK_LIMIT) throw ApiError.badRequest(`Selecione no máximo ${BULK_LIMIT} demandas por ação.`, "TOO_MANY_CARDS");

    const action = text(body.action, 20) as BulkAction;
    if (!["assign", "priority", "due", "move"].includes(action)) {
      throw ApiError.badRequest("Ação em massa desconhecida.", "UNKNOWN_BULK_ACTION");
    }

    const placeholders = cardIds.map(() => "?").join(",");
    const found = await d1.prepare(`SELECT id, list_id, priority, due_at, assignee_name, title FROM fdp_cards
      WHERE board_id = ? AND archived = 0 AND id IN (${placeholders})`)
      .bind(board.id, ...cardIds).all<Record<string, unknown>>();
    if (found.results.length !== cardIds.length) throw ApiError.notFound("Uma das demandas selecionadas não está mais no quadro.", "CARD_NOT_FOUND");
    for (const id of cardIds) await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);

    /* O que muda, e como cada demanda fica descrita no histórico. A frase é
       construída uma vez e reaproveitada: o registro de cada demanda precisa
       dizer a mesma coisa, e montá-la dentro do laço abriria a porta para
       trinta descrições ligeiramente diferentes do mesmo gesto. */
    let summary = "";
    if (action === "assign") {
      const assigneeIds = stringIds(body.assigneeIds);
      for (const id of cardIds) await replaceCardRelations(d1, workspace.id, id, { assigneeIds });
      const nome = assigneeIds.length
        ? String((await d1.prepare("SELECT assignee_name FROM fdp_cards WHERE id = ?").bind(cardIds[0]).first<{ assignee_name: string }>())?.assignee_name ?? "")
        : "";
      summary = nome ? `atribuídas a ${nome}` : "devolvidas para a fila sem responsável";
    } else if (action === "priority") {
      const priority = ["low", "normal", "high", "urgent"].includes(String(body.priority)) ? String(body.priority) : "";
      if (!priority) throw ApiError.badRequest("Prioridade inválida.", "INVALID_PRIORITY");
      await d1.prepare(`UPDATE fdp_cards SET priority = ?, updated_at = CURRENT_TIMESTAMP
        WHERE board_id = ? AND id IN (${placeholders})`).bind(priority, board.id, ...cardIds).run();
      summary = `prioridade alterada para ${priority}`;
    } else if (action === "due") {
      const dueAt = validDueAt(body.dueAt);
      if (!dueAt) throw ApiError.badRequest("Informe o novo prazo.", "INVALID_DUE_AT");
      /* O SLA é recalculado por demanda porque ele depende da coluna em que
         cada uma está: a mesma data em coluna pausada e em coluna corrente
         significa coisas diferentes. Um `UPDATE` só, com um status só, seria
         mais curto e estaria errado para metade da seleção. */
      const lists = await d1.prepare("SELECT id, sla_behavior FROM fdp_lists WHERE board_id = ?").bind(board.id).all<{ id: string; sla_behavior: string }>();
      const behaviorByList = new Map(lists.results.map((list) => [String(list.id), String(list.sla_behavior)]));
      await d1.batch(found.results.map((card) => d1.prepare(`UPDATE fdp_cards SET due_at = ?, sla_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND board_id = ?`)
        .bind(dueAt, computeSlaStatus(dueAt, behaviorByList.get(String(card.list_id)) ?? "running"), String(card.id), board.id)));
      summary = `prazo alterado para ${dueAt}`;
    } else {
      const toListId = text(body.toListId, 80);
      const list = toListId
        ? await d1.prepare("SELECT id, name, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ?").bind(toListId, board.id).first<{ id: string; name: string; sla_behavior: string }>()
        : null;
      if (!list) throw ApiError.notFound("Coluna não encontrada.", "LIST_NOT_FOUND");
      const positionRow = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0").bind(list.id).first<{ max_position: number }>();
      let position = Number(positionRow?.max_position ?? 0);
      await d1.batch(found.results.map((card) => {
        position += 1000;
        return d1.prepare(`UPDATE fdp_cards SET list_id = ?, position = ?, sla_status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND board_id = ?`)
          .bind(list.id, position, computeSlaStatus(card.due_at ? String(card.due_at) : null, list.sla_behavior), String(card.id), board.id);
      }));
      summary = `movidas para ${list.name}`;
    }

    for (const card of found.results) {
      await recordActivity(workspace.id, String(card.id), auth.user.email, "card.bulk_updated", {
        title: String(card.title ?? ""), action, summary, selectionSize: cardIds.length,
      });
    }
    await prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: `cards.bulk_${action}`,
      entityType: "card",
      entityId: null,
      after: { cardIds, summary },
      metadata: { count: cardIds.length },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
