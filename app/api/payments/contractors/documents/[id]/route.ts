import { getAttachmentsBucket } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { isPreviewableInvoiceType } from "@/lib/contractor-invoices";

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
    /* Duas permissões abrem o mesmo arquivo, e não é redundância: quem confere
       nota fiscal precisa ver o documento sem necessariamente ter a apuração
       PJ inteira liberada. Basta uma das duas — exigir as duas transformaria a
       permissão nova em enfeite. */
    if (!hasCapability(workspace, "invoice.read")) requireCapability(workspace, "contractors.payments.read");
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
    /* O arquivo veio de fora e é servido do mesmo domínio da aplicação. A
       política nega qualquer sub-recurso, e só PDF e imagem raster chegam a
       ser exibidos `inline` — XML e o que mais venha a ser aceito continuam
       saindo como download, que é o que impede um documento com script de
       executar com a sessão de quem o abriu. `sandbox` não entra aqui de
       propósito: ele quebra o visualizador de PDF nativo do navegador, e a
       proteção já vem do tipo servido com `nosniff`. */
    headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; object-src 'none'");
    const wantsInline = new URL(request.url).searchParams.get("disposition") === "inline";
    const previewable = isPreviewableInvoiceType(document.content_type);
    const disposition = wantsInline && previewable ? "inline" : "attachment";
    headers.set("Content-Disposition", `${disposition}; filename="${safeFilename(document.filename)}"; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
    return new Response(object.body, { headers });
  } catch (error) {
    return apiError(error);
  }
}
