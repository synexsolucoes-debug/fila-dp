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
    const taskInstanceId = String(form.get("taskInstanceId") ?? "").trim().slice(0, 120) || null;
    if (taskInstanceId) {
      const task = await d1.prepare("SELECT id FROM fdp_demand_tasks WHERE workspace_id = ? AND card_id = ? AND id = ?")
        .bind(workspace.id, id, taskInstanceId).first<{ id: string }>();
      if (!task) throw ApiError.badRequest("A tarefa selecionada não pertence a esta demanda.", "TASK_NOT_FOUND");
    }
    const stored = await storeCardAttachment({
      d1, workspaceId: workspace.id, cardId: id, filename: file.name, contentType: file.type,
      sizeBytes: file.size, body: file.stream(), uploadedBy: auth.user.email, taskInstanceId,
    });
    await recordActivity(workspace.id, id, auth.user.email, "attachment.uploaded", {
      attachmentId: stored.attachmentId, filename: file.name, sizeBytes: file.size, taskInstanceId,
    });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
