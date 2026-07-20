import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { body?: string };
    const comment = text(body.body, 2000);
    if (!comment) return Response.json({ error: "Escreva um comentário." }, { status: 400 });
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member", "guest"]);
    const card = await d1.prepare("SELECT id, title FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0")
      .bind(id, board.id)
      .first<{ id: string; title: string }>();
    if (!card) throw new Error("Demanda não encontrada.");
    const commentId = crypto.randomUUID();
    await d1.prepare("INSERT INTO fdp_card_comments (id, card_id, author_user_id, body) VALUES (?, ?, ?, ?)")
      .bind(commentId, id, user.id, comment)
      .run();
    const recipients = await d1.prepare("SELECT user_id FROM fdp_card_assignees WHERE card_id = ? AND user_id <> ?").bind(id, user.id).all<{ user_id: string }>();
    const mentionNames = Array.from(comment.matchAll(/@([\p{L}0-9._-]{2,80})/gu)).map((match) => match[1].toLowerCase());
    const mentionRecipients = mentionNames.length ? await d1.prepare("SELECT id AS user_id FROM fdp_users WHERE lower(name) LIKE ? AND id <> ? LIMIT 10").bind(`%${mentionNames[0]}%`, user.id).all<{ user_id: string }>() : { results: [] as Array<{ user_id: string }> };
    const recipientIds = Array.from(new Set([...recipients.results.map((recipient) => recipient.user_id), ...mentionRecipients.results.map((recipient) => recipient.user_id)]));
    if (recipientIds.length) await d1.batch(recipientIds.map((recipientId) => d1.prepare(`INSERT OR IGNORE INTO fdp_notifications
      (id, workspace_id, user_id, event_key, notification_type, title, body, card_id)
      VALUES (?, ?, ?, ?, 'comment', 'Novo comentário', ?, ?)`)
      .bind(crypto.randomUUID(), workspace.id, recipientId, `comment:${commentId}:${recipientId}`, `${auth.user.displayName} comentou em ${card.title}`, id)));
    await recordActivity(workspace.id, id, auth.user.email, "card.commented");
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { id?: string; body?: string };
    const commentId = text(body.id, 120);
    const comment = text(body.body, 2000);
    if (!commentId || !comment) return Response.json({ error: "Informe o comentário." }, { status: 400 });
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member", "guest"]);
    const current = await d1.prepare(`SELECT cc.id, cc.author_user_id FROM fdp_card_comments cc JOIN fdp_cards c ON c.id = cc.card_id WHERE cc.id = ? AND cc.card_id = ? AND c.board_id = ? AND c.archived = 0`).bind(commentId, id, board.id).first<{ id: string; author_user_id: string }>();
    if (!current) return Response.json({ error: "Comentário não encontrado." }, { status: 404 });
    if (current.author_user_id !== user.id && workspace.role !== "admin") return Response.json({ error: "Você só pode editar seus próprios comentários." }, { status: 403 });
    await d1.prepare("UPDATE fdp_card_comments SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(comment, commentId).run();
    await recordActivity(workspace.id, id, auth.user.email, "card.comment_edited", { commentId });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const commentId = text(url.searchParams.get("commentId"), 120);
    if (!commentId) return Response.json({ error: "Informe o comentário." }, { status: 400 });
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member", "guest"]);
    const current = await d1.prepare(`SELECT cc.id, cc.author_user_id FROM fdp_card_comments cc JOIN fdp_cards c ON c.id = cc.card_id WHERE cc.id = ? AND cc.card_id = ? AND c.board_id = ? AND c.archived = 0`).bind(commentId, id, board.id).first<{ id: string; author_user_id: string }>();
    if (!current) return Response.json({ error: "Comentário não encontrado." }, { status: 404 });
    if (current.author_user_id !== user.id && workspace.role !== "admin") return Response.json({ error: "Você só pode excluir seus próprios comentários." }, { status: 403 });
    await d1.prepare("DELETE FROM fdp_card_comments WHERE id = ?").bind(commentId).run();
    await recordActivity(workspace.id, id, auth.user.email, "card.comment_deleted", { commentId });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
