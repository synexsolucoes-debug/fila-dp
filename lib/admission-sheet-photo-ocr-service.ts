/**
 * O preparo do OCR de fotos, fora da tela — mesmo desenho de `admission-sheet-service.ts`.
 *
 * Entre "a foto chegou" e "a sugestão está pronta" existe um intervalo (a
 * chamada ao Google Vision não é instantânea), e a tela precisa dizer o que
 * está acontecendo. Três estados pela mesma razão da ficha em PDF:
 *
 *   `pending` — enfileirada, ainda não lida.
 *   `ready`   — lida; pode ter zero, um ou mais campos sugeridos.
 *   `failed`  — as tentativas acabaram, ou o arquivo não é uma foto legível.
 *
 * O resultado nunca é escrito na ficha diretamente — ver o comentário de
 * `lib/photo-document-fields.ts` para o porquê. Confirmar uma sugestão usa o
 * mesmo caminho de correção manual que a ficha já tem
 * (`PATCH /registration-sheet`), então este módulo não precisa saber nada
 * sobre merge de campos, só produzir e guardar o candidato.
 */
import { getAttachmentsBucket } from "../db/index.ts";
import type { getD1 } from "../db/index.ts";
import { openSheet, sanitizeSheetFields, sanitizeSheetWarnings, sealSheet } from "./admission-sheet.ts";
import { log } from "./observability.ts";
import { extractPhotoFields, type PhotoFieldConfidence } from "./photo-document-fields.ts";
import { ocrConfigured, runDocumentOcr } from "./photo-ocr.ts";

type Database = ReturnType<typeof getD1>;

export const PHOTO_OCR_MAX_ATTEMPTS = 3;

export type PhotoOcrState = "pending" | "ready" | "failed";

const imageContentTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

function isImageAttachment(contentType: string, filename: string) {
  return imageContentTypes.has(contentType.trim().toLowerCase()) || /\.(?:jpe?g|png|webp)$/iu.test(filename);
}

export async function enqueuePhotoOcr(d1: Database, input: {
  workspaceId: string;
  cardId: string;
  attachment: { id: string; filename: string; contentType: string };
}) {
  if (!isImageAttachment(input.attachment.contentType, input.attachment.filename)) return { enqueued: false };
  const row = await d1.prepare(`INSERT INTO fdp_admission_sheet_photo_ocr
      (id, workspace_id, card_id, attachment_id, source_filename, state)
    VALUES (?, ?, ?, ?, ?, 'pending')
    ON CONFLICT (workspace_id, attachment_id) DO UPDATE SET
      state = 'pending', error_code = '', attempts = 0, last_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE fdp_admission_sheet_photo_ocr.state <> 'ready'
    RETURNING id`)
    .bind(crypto.randomUUID(), input.workspaceId, input.cardId, input.attachment.id,
      input.attachment.filename.slice(0, 220))
    .first<{ id: string }>();
  return { enqueued: Boolean(row) };
}

/** Fotos aguardando OCR, mais antigas primeiro — mesma forma de claimPendingSheets. */
export async function claimPendingPhotoOcr(d1: Database, workspaceId: string, limit = 5) {
  const rows = await d1.prepare(`SELECT card_id, attachment_id, attempts FROM fdp_admission_sheet_photo_ocr
    WHERE workspace_id = ? AND state = 'pending' AND attempts < ?
    ORDER BY last_attempt_at NULLS FIRST, created_at
    LIMIT ?`)
    .bind(workspaceId, PHOTO_OCR_MAX_ATTEMPTS, Math.max(1, Math.min(25, limit)))
    .all<{ card_id: string; attachment_id: string; attempts: number }>();
  return rows.results ?? [];
}

export type PhotoOcrPreparation = { state: PhotoOcrState; errorCode: string; attempts: number; fieldCount: number };

/** Lê a foto anexada, roda o OCR e grava a sugestão. Nunca lança — devolve o estado. */
export async function preparePhotoOcr(d1: Database, input: {
  workspaceId: string;
  cardId: string;
  attachmentId: string;
}): Promise<PhotoOcrPreparation> {
  const current = await d1.prepare(`SELECT attempts FROM fdp_admission_sheet_photo_ocr
    WHERE workspace_id = ? AND attachment_id = ?`)
    .bind(input.workspaceId, input.attachmentId).first<{ attempts: number }>();
  const attempts = Number(current?.attempts ?? 0) + 1;

  const fail = async (errorCode: string) => {
    const state: PhotoOcrState = attempts >= PHOTO_OCR_MAX_ATTEMPTS ? "failed" : "pending";
    await d1.prepare(`UPDATE fdp_admission_sheet_photo_ocr
      SET state = ?, error_code = ?, attempts = ?, last_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND attachment_id = ?`)
      .bind(state, errorCode.slice(0, 120), attempts, input.workspaceId, input.attachmentId).run();
    return { state, errorCode, attempts, fieldCount: 0 };
  };

  if (!ocrConfigured()) return fail("OCR_NOT_CONFIGURED");

  const attachment = await d1.prepare(`SELECT object_key, content_type, filename FROM fdp_card_attachments
    WHERE workspace_id = ? AND id = ? AND card_id = ?`)
    .bind(input.workspaceId, input.attachmentId, input.cardId)
    .first<{ object_key: string; content_type: string; filename: string }>();
  if (!attachment) return fail("ATTACHMENT_MISSING");

  const object = await getAttachmentsBucket().get(attachment.object_key);
  if (!object) return fail("ATTACHMENT_MISSING");

  let text: string;
  try {
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    text = await runDocumentOcr({ bytes, contentType: attachment.content_type });
  } catch (cause) {
    log("warn", "admission.photo_ocr_failed", { workspaceId: input.workspaceId }, {
      cardId: input.cardId, errorName: cause instanceof Error ? cause.name : "UnknownError",
    });
    return fail("OCR_REQUEST_FAILED");
  }

  const { fields, warnings } = extractPhotoFields(text);
  const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
  const confidence: Record<string, PhotoFieldConfidence> = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, field.confidence]));

  if (Object.keys(values).length === 0) {
    // Nenhum campo passou em conferência nenhuma — a foto foi lida, mas não
    // rendeu sugestão. `ready` com zero campos é honesto: a leitura não
    // falhou, só não achou nada confiável para oferecer.
    await d1.prepare(`UPDATE fdp_admission_sheet_photo_ocr SET
        state = 'ready', error_code = '', encrypted_value = NULL, initialization_vector = NULL,
        auth_tag = NULL, key_version = NULL, confidence_json = '{}', warnings_json = ?,
        attempts = ?, last_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND attachment_id = ?`)
      .bind(JSON.stringify(sanitizeSheetWarnings(warnings)), attempts, input.workspaceId, input.attachmentId).run();
    return { state: "ready", errorCode: "", attempts, fieldCount: 0 };
  }

  const sealed = sealSheet(sanitizeSheetFields(values));
  await d1.prepare(`UPDATE fdp_admission_sheet_photo_ocr SET
      state = 'ready', error_code = '', encrypted_value = ?, initialization_vector = ?, auth_tag = ?,
      key_version = ?, confidence_json = ?, warnings_json = ?, attempts = ?,
      last_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND attachment_id = ?`)
    .bind(sealed.encryptedValue, sealed.initializationVector, sealed.authTag, sealed.keyVersion,
      JSON.stringify(confidence), JSON.stringify(sanitizeSheetWarnings(warnings)), attempts,
      input.workspaceId, input.attachmentId).run();
  return { state: "ready", errorCode: "", attempts, fieldCount: Object.keys(values).length };
}

/**
 * Roda o OCR pendente de uma demanda específica, na hora — mesmo espírito de
 * `prepareSheetAfterTransfer`: a conclusão da transferência já tem tudo em
 * mãos (bytes acabaram de chegar), e esperar o próximo ciclo do cron para a
 * primeira tentativa seria atraso sem motivo. Uma foto que falhar aqui ainda
 * cai na fila do cron (`claimPendingPhotoOcr`) para as tentativas seguintes.
 */
export async function runPendingPhotoOcrForCard(d1: Database, workspaceId: string, cardId: string) {
  const rows = await d1.prepare(`SELECT attachment_id FROM fdp_admission_sheet_photo_ocr
    WHERE workspace_id = ? AND card_id = ? AND state = 'pending' AND attempts < ?`)
    .bind(workspaceId, cardId, PHOTO_OCR_MAX_ATTEMPTS)
    .all<{ attachment_id: string }>();
  let prepared = 0;
  for (const row of rows.results ?? []) {
    const result = await preparePhotoOcr(d1, { workspaceId, cardId, attachmentId: String(row.attachment_id) })
      .catch(() => null);
    if (result?.state === "ready") prepared += 1;
  }
  return prepared;
}

export type PhotoOcrSuggestion = {
  attachmentId: string;
  sourceFilename: string;
  state: PhotoOcrState;
  fields: Record<string, { value: string; confidence: PhotoFieldConfidence }>;
};

/** As sugestões prontas de uma demanda, uma por foto anexada. Nunca lança. */
export async function loadPhotoOcrSuggestions(d1: Database, workspaceId: string, cardId: string): Promise<PhotoOcrSuggestion[]> {
  const rows = await d1.prepare(`SELECT attachment_id, source_filename, state, encrypted_value,
      initialization_vector, auth_tag, key_version, confidence_json
    FROM fdp_admission_sheet_photo_ocr WHERE workspace_id = ? AND card_id = ? ORDER BY created_at`)
    .bind(workspaceId, cardId)
    .all<{
      attachment_id: string; source_filename: string; state: PhotoOcrState;
      encrypted_value: string | null; initialization_vector: string | null;
      auth_tag: string | null; key_version: number | null; confidence_json: string;
    }>();

  return (rows.results ?? []).map((row) => {
    let opened: Partial<Record<string, string>> = {};
    if (row.encrypted_value && row.initialization_vector && row.auth_tag && row.key_version !== null) {
      try {
        opened = openSheet({
          encryptedValue: row.encrypted_value, initializationVector: row.initialization_vector,
          authTag: row.auth_tag, keyVersion: row.key_version,
        });
      } catch { opened = {}; }
    }
    const confidence = JSON.parse(row.confidence_json || "{}") as Record<string, PhotoFieldConfidence>;
    const fields = Object.fromEntries(Object.entries(opened)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => [key, { value, confidence: confidence[key] === "ok" ? "ok" as const : "low" as const }]));
    return {
      attachmentId: String(row.attachment_id), sourceFilename: String(row.source_filename),
      state: row.state, fields,
    };
  });
}
