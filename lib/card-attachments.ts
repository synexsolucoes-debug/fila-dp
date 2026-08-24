import { getAttachmentsBucket } from "../db/index.ts";
import { ApiError } from "./api-errors.ts";

export const MAX_CARD_ATTACHMENT_SIZE = 20 * 1024 * 1024;

export const allowedCardAttachmentMimeTypes = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const allowedCardAttachmentExtensions = new Set([
  "pdf", "jpg", "jpeg", "png", "webp", "txt", "csv", "docx", "xlsx",
]);

type Database = D1Database;

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 * 10 ? 1 : 0)} MB`;

export function safeAttachmentFilename(value: string) {
  const leaf = value.replace(/\\/gu, "/").split("/").pop() ?? "";
  return leaf.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 220);
}

export function validateCardAttachment(input: { filename: string; contentType: string; sizeBytes: number }) {
  const filename = safeAttachmentFilename(input.filename);
  const contentType = input.contentType.trim().toLowerCase();
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!filename || !Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw ApiError.badRequest("Selecione um arquivo válido.", "ATTACHMENT_INVALID");
  }
  if (input.sizeBytes > MAX_CARD_ATTACHMENT_SIZE) {
    throw new ApiError(413, "ATTACHMENT_TOO_LARGE", "O arquivo excede o limite de 20 MB.");
  }
  if (!allowedCardAttachmentMimeTypes.has(contentType) || !allowedCardAttachmentExtensions.has(extension)) {
    throw new ApiError(415, "ATTACHMENT_TYPE_NOT_ALLOWED", "Tipo de arquivo não permitido. Use PDF, imagem, TXT, CSV, DOCX ou XLSX.");
  }
  return { filename, contentType, extension };
}

async function storageQuotaError(d1: Database, workspaceId: string, incomingBytes: number) {
  const row = await d1.prepare(`SELECT
      (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM fdp_card_attachments WHERE workspace_id = $1)
        + (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM fdp_epi_attachments WHERE workspace_id = $1)
        + (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM fdp_contractor_documents WHERE workspace_id = $1) AS used,
      (SELECT plan.storage_limit_mb FROM fdp_workspace_subscriptions subscription
       JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id
       WHERE subscription.workspace_id = $1 AND subscription.status IN ('trialing', 'active')) AS limit_mb`)
    .bind(workspaceId)
    .first<{ used: string | number; limit_mb: number | null }>();

  if (!row?.limit_mb) {
    return new ApiError(409, "SUBSCRIPTION_INACTIVE",
      "Este grupo não tem uma assinatura ativa, então novos anexos não podem ser guardados. Fale com o administrador da plataforma.");
  }
  const used = Number(row.used ?? 0);
  const total = Number(row.limit_mb) * 1024 * 1024;
  return new ApiError(409, "STORAGE_LIMIT_REACHED",
    `O armazenamento do plano está em ${megabytes(used)} de ${megabytes(total)} e este arquivo tem ${megabytes(incomingBytes)}. `
    + "Remova anexos que não sejam mais necessários ou mude de plano para continuar.",
    { usedBytes: used, limitBytes: total, incomingBytes });
}

/** Grava um anexo privado com a mesma validação e a mesma cota em todos os canais. */
export async function storeCardAttachment(input: {
  d1: Database;
  workspaceId: string;
  cardId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  body: ReadableStream<Uint8Array>;
  uploadedBy: string;
  sourceType?: "manual" | "solides";
  sourceReference?: string | null;
}) {
  const validated = validateCardAttachment(input);
  const sourceType = input.sourceType ?? "manual";
  const sourceReference = input.sourceReference?.trim().slice(0, 200) || null;

  if (sourceReference) {
    const existing = await input.d1.prepare(`SELECT id FROM fdp_card_attachments
      WHERE workspace_id = ? AND source_type = ? AND source_reference = ?`)
      .bind(input.workspaceId, sourceType, sourceReference).first<{ id: string }>();
    if (existing) return { attachmentId: String(existing.id), created: false };
  }

  const attachmentId = crypto.randomUUID();
  const objectKey = `workspaces/${input.workspaceId}/cards/${input.cardId}/${attachmentId}`;
  const bucket = getAttachmentsBucket();
  await bucket.put(objectKey, input.body, {
    httpMetadata: { contentType: validated.contentType, contentDisposition: "attachment" },
    customMetadata: { attachmentId, cardId: input.cardId, workspaceId: input.workspaceId },
  });

  try {
    const stored = await input.d1.prepare(`WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext(?))
      ), entitlement AS (
        SELECT plan.storage_limit_mb FROM fdp_workspace_subscriptions subscription
        JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
        WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
      ), inserted AS (
        INSERT INTO fdp_card_attachments
          (id, workspace_id, card_id, object_key, filename, content_type, size_bytes, uploaded_by, source_type, source_reference)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM entitlement
        WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_card_attachments WHERE workspace_id = ?)
            + (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_epi_attachments WHERE workspace_id = ?)
            + (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_contractor_documents WHERE workspace_id = ?) + ?
          <= entitlement.storage_limit_mb::bigint * 1024 * 1024
        ON CONFLICT DO NOTHING
        RETURNING id
      ) SELECT id FROM inserted`)
      .bind(input.workspaceId, input.workspaceId, attachmentId, input.workspaceId, input.cardId, objectKey,
        validated.filename, validated.contentType, input.sizeBytes, input.uploadedBy.slice(0, 220), sourceType,
        sourceReference, input.workspaceId, input.workspaceId, input.workspaceId, input.sizeBytes)
      .first<{ id: string }>();

    if (stored) return { attachmentId, created: true };
    await bucket.delete(objectKey).catch(() => undefined);
    if (sourceReference) {
      const duplicate = await input.d1.prepare(`SELECT id FROM fdp_card_attachments
        WHERE workspace_id = ? AND source_type = ? AND source_reference = ?`)
        .bind(input.workspaceId, sourceType, sourceReference).first<{ id: string }>();
      if (duplicate) return { attachmentId: String(duplicate.id), created: false };
    }
    throw await storageQuotaError(input.d1, input.workspaceId, input.sizeBytes);
  } catch (error) {
    await bucket.delete(objectKey).catch(() => undefined);
    throw error;
  }
}
