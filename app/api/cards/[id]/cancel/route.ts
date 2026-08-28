import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, getWorkspaceSnapshot, recordActivity,
  requireCardCompanyAccess, requireWorkspaceRole,
} from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";

/**
 * Cancelar uma demanda (spec: Ações da demanda).
 *
 * Cancelar não é concluir, e não é arquivar.
 *
 * - **Concluir** diz que o trabalho foi entregue. Uma admissão que não vai
 *   acontecer contada como concluída infla a produtividade com trabalho que
 *   ninguém fez.
 * - **Arquivar** tira da vista. Não diz por quê, e o motivo é justamente o que
 *   alguém vai procurar meses depois.
 *
 * Por isso o cancelamento preenche `cancelled_at` **e** `closed_at`: a demanda
 * sai da fila — que é o que `closed_at` significa para as sete consultas de "em
 * aberto" — e fica marcada como não-entregue para as três que contam entrega.
 *
 * O motivo é obrigatório, e a recusa acontece aqui **e** no banco: a restrição
 * `fdp_cards_cancellation_check` existe porque uma rota nova, amanhã, poderia
 * esquecer esta validação.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);

    const body = await request.json().catch(() => ({})) as { reason?: unknown };
    const reason = cleanText(body.reason, 500);
    if (!reason) {
      throw new ApiError(400, "CANCELLATION_REASON_REQUIRED",
        "Diga por que esta demanda está sendo cancelada. O motivo é o que responde, meses depois, por que ela não aconteceu.");
    }

    /* `closed_at IS NULL` no WHERE: demanda já encerrada não é cancelada por
       cima. Reabrir para cancelar é outra decisão, com outro registro — e
       sobrescrever a conclusão de alguém em silêncio seria perder o desfecho
       original sem que ninguém percebesse. */
    const result = await d1.prepare(`UPDATE fdp_cards
        SET cancelled_at = CURRENT_TIMESTAMP, closed_at = CURRENT_TIMESTAMP,
            cancellation_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND board_id = ? AND closed_at IS NULL`)
      .bind(reason, workspace.id, id, board.id).run();

    if (!result.meta.changes) {
      throw ApiError.notFound(
        "Demanda não encontrada, ou já encerrada. Recarregue para ver o estado atual.",
        "CARD_NOT_FOUND");
    }

    await recordActivity(workspace.id, id, auth.user.email, "card.cancelled", { reason });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
