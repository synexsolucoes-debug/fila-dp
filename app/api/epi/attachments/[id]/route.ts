import { getAttachmentsBucket } from "@/db";
import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";

type RouteContext = { params: Promise<{ id: string }> };

type AttachmentRow = {
  id: string; company_id: string | null; entity_type: string; entity_id: string; object_key: string;
  filename: string; content_type: string; size_bytes: number;
};

function safeFilename(value: string) {
  return value.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "anexo";
}

async function attachmentOf(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"], workspaceId: string, id: string) {
  const attachment = await d1.prepare("SELECT * FROM fdp_epi_attachments WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, id).first<AttachmentRow>();
  if (!attachment) throw ApiError.notFound("Anexo não encontrado.", "EPI_ATTACHMENT_NOT_FOUND");
  return attachment;
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "baixar anexos do Controle de EPI");
    const attachment = await attachmentOf(d1, workspace.id, id);
    if (attachment.company_id) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, attachment.company_id);
    const object = await getAttachmentsBucket().get(attachment.object_key);
    if (!object) throw ApiError.notFound("Anexo não encontrado.", "EPI_ATTACHMENT_NOT_FOUND");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", attachment.content_type || "application/octet-stream");
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.etag);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    const wantsInline = new URL(request.url).searchParams.get("disposition") === "inline";
    const previewable = attachment.content_type === "application/pdf" || attachment.content_type.startsWith("image/");
    const disposition = wantsInline && previewable ? "inline" : "attachment";
    headers.set("Content-Disposition", `${disposition}; filename="${safeFilename(attachment.filename)}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    return new Response(object.body, { headers });
  } catch (error) { return apiError(error); }
}

/**
 * Remoção de anexo.
 *
 * O anexo de um descarte já confirmado não sai: ele é a evidência documental do
 * ato que o banco tornou imutável, e apagá-lo esvaziaria a prova mantendo o
 * registro — a pior das duas metades.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.edit", "remover anexos do Controle de EPI");
    const attachment = await attachmentOf(d1, workspace.id, id);
    if (attachment.company_id) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, attachment.company_id);
    if (attachment.entity_type === "disposal") {
      const disposal = await d1.prepare("SELECT status FROM fdp_epi_disposals WHERE workspace_id = ? AND id = ?")
        .bind(workspace.id, attachment.entity_id).first<{ status: string }>();
      if (disposal?.status === "disposed") {
        throw new ApiError(409, "EPI_DISPOSAL_EVIDENCE_LOCKED",
          "Este anexo comprova um descarte já confirmado e não pode ser removido.");
      }
    }
    await getAttachmentsBucket().delete(attachment.object_key).catch(() => undefined);
    await d1.batch([
      d1.prepare("DELETE FROM fdp_epi_attachments WHERE workspace_id = ? AND id = ?").bind(workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_attachment.deleted",
        entityType: "epi_attachment", entityId: id, before: attachment,
        metadata: { entityType: attachment.entity_type, entityId: attachment.entity_id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ deleted: true });
  } catch (error) { return apiError(error); }
}
