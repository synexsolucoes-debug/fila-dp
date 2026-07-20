import { getAttachmentsBucket } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

function safeFilename(value: string) {
  return value.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "anexo";
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member", "observer"]);
    const attachment = await d1.prepare(`SELECT a.object_key, a.filename, a.content_type
      FROM fdp_card_attachments a JOIN fdp_cards c ON c.id = a.card_id
      WHERE a.id = ? AND c.board_id = ?`).bind(id, board.id).first<{ object_key: string; filename: string; content_type: string }>();
    if (!attachment) throw new Error("Anexo não encontrado.");
    const object = await getAttachmentsBucket().get(attachment.object_key);
    if (!object) throw new Error("Anexo não encontrado.");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", attachment.content_type || "application/octet-stream");
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.etag);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Disposition", `attachment; filename="${safeFilename(attachment.filename)}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    return new Response(object.body, { headers });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const attachment = await d1.prepare(`SELECT a.object_key, a.card_id, a.filename
      FROM fdp_card_attachments a JOIN fdp_cards c ON c.id = a.card_id
      WHERE a.id = ? AND c.board_id = ?`).bind(id, board.id).first<{ object_key: string; card_id: string; filename: string }>();
    if (!attachment) throw new Error("Anexo não encontrado.");
    await getAttachmentsBucket().delete(attachment.object_key);
    await d1.prepare("DELETE FROM fdp_card_attachments WHERE id = ?").bind(id).run();
    await recordActivity(workspace.id, attachment.card_id, auth.user.email, "attachment.deleted", { attachmentId: id, filename: attachment.filename });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
