import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { getAttachmentsBucket } from "@/db";

type RouteContext = { params: Promise<{ id: string }> };
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const allowedMimeTypes = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const allowedExtensions = new Set(["pdf", "jpg", "jpeg", "png", "webp", "txt", "csv", "docx", "xlsx"]);

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_SIZE + 1024 * 1024) return Response.json({ error: "O arquivo excede o limite de 20 MB." }, { status: 413 });

  try {
    const { id } = await context.params;
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const card = await d1.prepare("SELECT id FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).first();
    if (!card) throw new Error("Demanda não encontrada.");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Selecione um arquivo válido." }, { status: 400 });
    if (file.size > MAX_FILE_SIZE) return Response.json({ error: "O arquivo excede o limite de 20 MB." }, { status: 413 });
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowedMimeTypes.has(file.type) || !allowedExtensions.has(extension)) {
      return Response.json({ error: "Tipo de arquivo não permitido. Use PDF, imagem, TXT, CSV, DOCX ou XLSX." }, { status: 415 });
    }

    const attachmentId = crypto.randomUUID();
    const objectKey = `workspaces/${workspace.id}/cards/${id}/${attachmentId}`;
    const bucket = getAttachmentsBucket();
    await bucket.put(objectKey, file.stream(), {
      httpMetadata: { contentType: file.type, contentDisposition: "attachment" },
      customMetadata: { attachmentId, cardId: id, workspaceId: workspace.id },
    });
    try {
      await d1.prepare(`INSERT INTO fdp_card_attachments
        (id, card_id, object_key, filename, content_type, size_bytes, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(attachmentId, id, objectKey, file.name.slice(0, 220), file.type, file.size, auth.user.email).run();
    } catch (error) {
      await bucket.delete(objectKey).catch(() => undefined);
      throw error;
    }
    await recordActivity(workspace.id, id, auth.user.email, "attachment.uploaded", { attachmentId, filename: file.name, sizeBytes: file.size });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
