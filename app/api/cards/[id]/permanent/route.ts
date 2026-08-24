import { getAttachmentsBucket } from "@/db";
import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    requireCapability(workspace, "cards.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const card = await d1.prepare("SELECT title FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 1").bind(id, board.id).first<{ title: string }>();
    if (!card) throw ApiError.notFound("Demanda arquivada não encontrada.", "CARD_NOT_FOUND");
    const attachments = await d1.prepare("SELECT object_key FROM fdp_card_attachments WHERE card_id = ?").bind(id).all<{ object_key: string }>();
    const bucket = getAttachmentsBucket();
    for (const attachment of attachments.results) await bucket.delete(attachment.object_key);
    await d1.prepare("DELETE FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 1").bind(id, board.id).run();
    await recordActivity(workspace.id, null, auth.user.email, "card.permanently_deleted", { cardId: id, title: card.title });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
