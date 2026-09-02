import { getAttachmentsBucket } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { validCompetence } from "@/lib/operations";
import { cleanText } from "@/lib/registrations";
import { createStoredZip, type StoredZipEntry } from "@/lib/stored-zip";

export const dynamic = "force-dynamic";

type InvoiceDocument = {
  invoice_id: string;
  invoice_number: string;
  provider_name: string;
  object_key: string;
  filename: string;
  size_bytes: string | number;
  created_at: string;
};

const invalidFilenameCharacters = /[<>:"/\\|?*\u0000-\u001f]/gu;

function safePart(value: string, fallback: string) {
  return value.normalize("NFKC")
    .replace(invalidFilenameCharacters, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "")
    .slice(0, 90) || fallback;
}

/** Mantém a extensão original e evita que duas notas sobrescrevam uma à outra ao extrair o ZIP. */
function archiveFilename(row: InvoiceDocument, used: Set<string>) {
  const original = safePart(row.filename, "nota-fiscal");
  const dot = original.lastIndexOf(".");
  const extension = dot > 0 && original.length - dot <= 12 ? original.slice(dot) : "";
  const base = safePart(`${row.provider_name} - NF ${row.invoice_number || row.invoice_id}`, "nota-fiscal");
  let candidate = `${base}${extension}`;
  let copy = 2;
  while (used.has(candidate.toLocaleLowerCase("pt-BR"))) {
    candidate = `${base} (${copy})${extension}`;
    copy += 1;
  }
  used.add(candidate.toLocaleLowerCase("pt-BR"));
  return candidate;
}

/**
 * Baixa, num único ZIP, os documentos das notas vigentes da empresa e da
 * competência abertas. O recorte não depende dos filtros da tabela: "todas"
 * significa todas as notas anexadas naquele fechamento.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.export");

    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    const competence = validCompetence(url.searchParams.get("competence"));
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const documents = await d1.prepare(`SELECT
        invoice.id AS invoice_id, invoice.invoice_number,
        provider.legal_name AS provider_name,
        document.object_key, document.filename, document.size_bytes, document.created_at
      FROM fdp_contractor_closings closing
      JOIN fdp_contractor_invoices invoice
        ON invoice.workspace_id = closing.workspace_id AND invoice.id = closing.invoice_current_id
      JOIN fdp_contractor_documents document
        ON document.workspace_id = invoice.workspace_id AND document.id = invoice.document_id
      JOIN fdp_auxiliary_providers provider
        ON provider.workspace_id = closing.workspace_id AND provider.id = closing.provider_id
      WHERE closing.workspace_id = ? AND closing.company_id = ? AND closing.competence = ?
      ORDER BY provider.legal_name, invoice.invoice_number, document.id`)
      .bind(workspace.id, companyId, competence)
      .all<InvoiceDocument>();

    if (documents.results.length === 0) {
      throw ApiError.badRequest(
        "Nenhuma nota fiscal com arquivo anexado foi encontrada nesta competência.",
        "INVOICE_ARCHIVE_EMPTY",
      );
    }

    const bucket = getAttachmentsBucket();
    const stored: { row: InvoiceDocument; object: R2ObjectBody }[] = [];
    // Poucas conexões simultâneas evitam transformar uma competência grande
    // numa rajada contra o armazenamento privado.
    for (let start = 0; start < documents.results.length; start += 8) {
      const batch = documents.results.slice(start, start + 8);
      const objects = await Promise.all(batch.map(async (row) => ({ row, object: await bucket.get(row.object_key) })));
      for (const item of objects) {
        if (!item.object) {
          throw ApiError.notFound(
            `O arquivo ${item.row.filename} não foi encontrado no armazenamento.`,
            "CONTRACTOR_DOCUMENT_FILE_NOT_FOUND",
          );
        }
        stored.push({ row: item.row, object: item.object });
      }
    }

    const usedNames = new Set<string>();
    const entries: StoredZipEntry[] = stored.map(({ row, object }) => ({
      name: archiveFilename(row, usedNames),
      size: object.size,
      body: object.body as ReadableStream<Uint8Array>,
      modifiedAt: new Date(row.created_at),
    }));
    const archive = createStoredZip(entries);

    await prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_invoices.archive_exported",
      entityType: "contractor_invoice_archive",
      entityId: `${companyId}:${competence}`,
      after: { companyId, competence, documentCount: entries.length, sizeBytes: archive.size },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return new Response(archive.stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(archive.size),
        "Content-Disposition": `attachment; filename="notas-fiscais-${competence}.zip"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
