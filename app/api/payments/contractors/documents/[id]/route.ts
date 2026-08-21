import { getAttachmentsBucket } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type Params = { params: Promise<{ id: string }> };
type DocumentRow = {
  object_key: string;
  filename: string;
  content_type: string;
  company_id: string;
};

const safeFilename = (value: string) => value.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "nota-fiscal";

/** Entrega o arquivo privado somente após validar tenant, permissão e empresa. */
export async function GET(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.read");
    const document = await d1.prepare(`SELECT object_key, filename, content_type, company_id
      FROM fdp_contractor_documents WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id)
      .first<DocumentRow>();
    if (!document) throw ApiError.notFound("Documento não encontrado.", "CONTRACTOR_DOCUMENT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, document.company_id);

    const object = await getAttachmentsBucket().get(document.object_key);
    if (!object) throw ApiError.notFound("Arquivo não encontrado no armazenamento.", "CONTRACTOR_DOCUMENT_FILE_NOT_FOUND");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", document.content_type || "application/octet-stream");
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.etag);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    const wantsInline = new URL(request.url).searchParams.get("disposition") === "inline";
    const previewable = document.content_type === "application/pdf" || document.content_type.startsWith("image/");
    const disposition = wantsInline && previewable ? "inline" : "attachment";
    headers.set("Content-Disposition", `${disposition}; filename="${safeFilename(document.filename)}"; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
    return new Response(object.body, { headers });
  } catch (error) {
    return apiError(error);
  }
}
