import { ApiError, apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { extractMentions, mentionWarning, resolveMentions } from "@/lib/comment-mentions";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { body?: string; taskInstanceId?: string };
    const comment = text(body.body, 2000);
    if (!comment) return Response.json({ error: "Escreva um comentário." }, { status: 400 });
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member", "guest"]);
    requireCapability(workspace, "comments.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const card = await d1.prepare("SELECT id, title FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0")
      .bind(id, board.id)
      .first<{ id: string; title: string }>();
    if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
    const taskInstanceId = text(body.taskInstanceId, 120) || null;
    if (taskInstanceId) {
      const task = await d1.prepare("SELECT id FROM fdp_demand_tasks WHERE workspace_id = ? AND card_id = ? AND id = ?")
        .bind(workspace.id, id, taskInstanceId).first<{ id: string }>();
      if (!task) throw ApiError.badRequest("A tarefa selecionada não pertence a esta demanda.", "TASK_NOT_FOUND");
    }
    const commentId = crypto.randomUUID();
    await d1.prepare("INSERT INTO fdp_card_comments (id, workspace_id, card_id, task_instance_id, author_user_id, body) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(commentId, workspace.id, id, taskInstanceId, user.id, comment)
      .run();
    const recipients = await d1.prepare("SELECT user_id FROM fdp_card_assignees WHERE card_id = ? AND user_id <> ?").bind(id, user.id).all<{ user_id: string }>();
    const cardCompany = await d1.prepare("SELECT company_id FROM fdp_cards WHERE id = ?").bind(id).first<{ company_id: string | null }>();
    const companyId = cardCompany?.company_id ? String(cardCompany.company_id) : null;
    const mentions = extractMentions(comment).length
      ? resolveMentions(comment, (await d1.prepare(`SELECT u.id AS user_id, u.name, wm.role,
            EXISTS (SELECT 1 FROM fdp_member_company_access mca
              WHERE mca.workspace_id = wm.workspace_id AND mca.user_id = u.id AND mca.company_id = ?) AS has_company
          FROM fdp_users u
          JOIN fdp_workspace_members wm ON wm.user_id = u.id
          WHERE wm.workspace_id = ?`)
        .bind(companyId, workspace.id)
        .all<{ user_id: string; name: string; role: string; has_company: boolean | number }>()).results
        .map((row) => ({ userId: row.user_id, name: String(row.name ?? ""), canSeeCard: row.role === "admin" || Boolean(Number(row.has_company)) })), user.id)
      : { userIds: [] as string[], ambiguous: [] as string[], unknown: [] as string[], withoutAccess: [] as string[] };
    const mentionRecipients = { results: mentions.userIds.map((userId) => ({ user_id: userId })) };
    const recipientIds = Array.from(new Set([...recipients.results.map((recipient) => recipient.user_id), ...mentionRecipients.results.map((recipient) => recipient.user_id)]));
    if (recipientIds.length) await d1.batch(recipientIds.map((recipientId) => d1.prepare(`INSERT INTO fdp_notifications
      (id, workspace_id, user_id, event_key, notification_type, title, body, card_id)
      VALUES (?, ?, ?, ?, 'comment', 'Novo comentário', ?, ?) ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), workspace.id, recipientId, `comment:${commentId}:${recipientId}`, `${auth.user.displayName} comentou em ${card.title}`, id)));
    await recordActivity(workspace.id, id, auth.user.email, "card.commented");
    return Response.json({ ...await getWorkspaceSnapshot(auth.user), createdCommentId: commentId, mentionWarning: mentionWarning(mentions) }, { status: 201 });
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
    requireCapability(workspace, "comments.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
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
    requireCapability(workspace, "comments.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
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
