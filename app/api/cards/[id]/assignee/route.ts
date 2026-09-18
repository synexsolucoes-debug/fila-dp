import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, prepareAuditEvent, recordActivity, requireCardCompanyAccess, requireWorkspaceRole, runAutomations } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { replaceCardRelations, stringIds } from "@/lib/fila-dp-relations";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Trocar o responsável de uma demanda — a ação do arrasto no quadro.
 *
 * O `PATCH` da demanda já aceitava `assigneeIds`, e continuaria aceitando. Ele
 * não serve para isto por duas razões práticas, ambas medidas no produto de pé:
 *
 *  1. **O histórico mentia.** O `PATCH` grava `card.updated` com o diff dos
 *     campos da tabela, e `assignee_name` é escrito *depois* dele, por
 *     `replaceCardRelations`. O resultado é uma linha "atualizou os dados" sem
 *     nenhuma menção ao responsável — justamente o evento que a operação mais
 *     precisa reconstituir ("quem passou isso para mim, e quando?").
 *  2. **O corpo é o registro inteiro.** Arrastar um cartão passaria título,
 *     empresa, prazo, prioridade e áreas de volta ao servidor para mudar uma
 *     coisa. Qualquer campo desatualizado no navegador — e no quadro eles ficam
 *     desatualizados, porque outra pessoa também mexe — seria regravado por
 *     cima. Um arrasto não pode reescrever a demanda.
 *
 * Por isso a atribuição é uma rota própria, com um corpo só: a lista de
 * responsáveis. Lista vazia é desatribuir, e é um pedido legítimo — devolver a
 * demanda para a fila comum é uma decisão de operação, não um erro.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    /* A permissão é verificada aqui, e não só no botão: a interface esconde o
       arrasto de quem é observador, mas esconder não é impedir. */
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");

    const current = await d1.prepare("SELECT id, title, assignee_name FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0")
      .bind(id, board.id).first<{ id: string; title: string; assignee_name: string }>();
    if (!current) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);

    if (body.assigneeIds === undefined) throw ApiError.badRequest("Informe quem passa a responder pela demanda.", "MISSING_ASSIGNEES");
    const assigneeIds = stringIds(body.assigneeIds);
    const previousName = String(current.assignee_name ?? "");

    /* O mesmo caminho de escrita do resto do produto: validar quem pode
       responder por demanda (admin ou membro do grupo), trocar os vínculos e
       manter `assignee_name` coerente com o primeiro deles. Reimplementar isso
       aqui criaria uma segunda regra para a mesma coisa. */
    await replaceCardRelations(d1, workspace.id, id, { assigneeIds });

    const updated = await d1.prepare("SELECT assignee_name FROM fdp_cards WHERE id = ?").bind(id).first<{ assignee_name: string }>();
    const nextName = String(updated?.assignee_name ?? "");

    if (assigneeIds.length > 0) {
      await runAutomations(workspace.id, board.id, id, "assignee.added", auth.user.email, { assignee: "present" });
    }
    /* Quem, para quem, e quando — os três campos que faltavam. O evento tem
       tipo próprio porque a linha do tempo precisa dizer "atribuiu a Ana", e
       não "atualizou os dados". */
    await recordActivity(workspace.id, id, auth.user.email, "card.assigned", {
      title: String(current.title ?? ""),
      from: previousName,
      to: nextName,
      assigneeCount: assigneeIds.length,
    });
    await prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: assigneeIds.length ? "card.assigned" : "card.unassigned",
      entityType: "card",
      entityId: id,
      before: { assigneeName: previousName },
      after: { assigneeName: nextName },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
