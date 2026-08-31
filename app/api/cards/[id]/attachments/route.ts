import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { MAX_CARD_ATTACHMENT_SIZE, storeCardAttachment } from "@/lib/card-attachments";

type RouteContext = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_CARD_ATTACHMENT_SIZE + 1024 * 1024) return Response.json({ error: "O arquivo excede o limite de 20 MB." }, { status: 413 });

  try {
    const { id } = await context.params;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "attachments.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const card = await d1.prepare("SELECT id FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).first();
    if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Selecione um arquivo válido." }, { status: 400 });

    /* A qual tarefa este arquivo serve de prova (§43).
       A conferência aqui não é formalidade: sem ela, quem conhece o id de uma
       tarefa de outra demanda — ou de outro workspace — penduraria a prova nela
       e satisfaria uma exigência que não é sua (§76). A consulta amarra a
       tarefa ao workspace **e** ao cartão desta rota; um id que não passe nos
       dois é tratado como inexistente, e não como "sem tarefa": aceitar em
       silêncio gravaria o anexo no lugar errado. */
    const requestedTaskId = String(form.get("taskId") ?? "").slice(0, 80);
    let checklistItemId: string | null = null;
    let processStepId = String(form.get("stepId") ?? "").slice(0, 160);
    if (requestedTaskId) {
      const task = await d1.prepare(
        "SELECT id, process_step_id FROM fdp_checklist_items WHERE workspace_id = ? AND id = ? AND card_id = ?",
      ).bind(workspace.id, requestedTaskId, id).first<{ id: string; process_step_id: string }>();
      if (!task) throw ApiError.notFound("Tarefa não encontrada nesta demanda.", "CHECKLIST_ITEM_NOT_FOUND");
      checklistItemId = String(task.id);
      // A etapa vem da tarefa, e não do formulário: são a mesma informação, e
      // duas fontes divergentes deixariam o anexo dizendo uma coisa na etapa e
      // outra na tarefa.
      processStepId = String(task.process_step_id ?? "");
    }

    const commentId = String(form.get("commentId") ?? "").slice(0, 80) || null;
    if (commentId) {
      const comment = await d1.prepare(
        "SELECT id FROM fdp_card_comments WHERE workspace_id = ? AND id = ? AND card_id = ?",
      ).bind(workspace.id, commentId, id).first<{ id: string }>();
      if (!comment) throw ApiError.notFound("Comentário não encontrado nesta demanda.", "COMMENT_NOT_FOUND");
    }

        const stored = await storeCardAttachment({
      d1, workspaceId: workspace.id, cardId: id, filename: file.name, contentType: file.type,
      sizeBytes: file.size, body: file.stream(), uploadedBy: auth.user.email,
      processStepId, checklistItemId, commentId,
    });
    await recordActivity(workspace.id, id, auth.user.email, "attachment.uploaded", {
      attachmentId: stored.attachmentId, filename: file.name, sizeBytes: file.size,
      processStepId: processStepId || undefined, taskId: checklistItemId ?? undefined,
      commentId: commentId ?? undefined,
    });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
