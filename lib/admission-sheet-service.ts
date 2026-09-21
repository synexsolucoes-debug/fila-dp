/**
 * O preparo da ficha de contratação, fora da tela.
 *
 * ## Por que existe um estado, e não só um resultado
 *
 * Antes, a ficha nascia quando alguém abria a aba e clicava. O agente já tinha
 * entrado no Tangerino, baixado o PDF e anexado à demanda — e o trabalho parava
 * ali, esperando um clique que ninguém sabia que precisava dar.
 *
 * Agora a conclusão da transferência enfileira o preparo. Entre "o PDF chegou" e
 * "a ficha está pronta" existe um intervalo, e durante ele a tela precisa dizer
 * o que está acontecendo. Sem estado persistido ela mostraria "nenhuma ficha
 * lida", que é falso e manda a pessoa clicar de novo no que já está em curso.
 *
 * ## Três estados, porque são três situações diferentes
 *
 *   `pending` — enfileirada, ainda não lida. A tela diz "preparando".
 *   `ready`   — lida, com envelope cifrado. É a única que mostra campos.
 *   `failed`  — as tentativas acabaram. A tela diz o motivo e oferece o PDF.
 *
 * `failed` não é fim de linha: o documento continua anexado e a releitura
 * manual continua disponível. Uma falha de leitura **nunca** provoca novo
 * download — o PDF já está guardado, e reprocessá-lo não custa navegador.
 *
 * ## Por que o preparo não roda no worker de navegador
 *
 * O worker do Windows existe para navegar e transferir. Ler um PDF que já está
 * no Vinculato não precisa de navegador, de sessão autenticada nem da máquina
 * de alguém ligada. Deixar a leitura no servidor é o que permite reprocessar
 * quando o layout mudar, sem pedir nada ao operador.
 */
import { getAttachmentsBucket } from "../db/index.ts";
import type { getD1 } from "../db/index.ts";
import { chooseRegistrationFormAttachment, sanitizeSheetWarnings, sealSheet } from "./admission-sheet.ts";
import { ApiError } from "./api-errors.ts";
import { buildRegistrationSheet } from "./employee-registration-form.ts";
import { log } from "./observability.ts";
import { readRegistrationFormPdf } from "./registration-form-pdf.ts";

type Database = ReturnType<typeof getD1>;

/** Tentativas automáticas antes de a ficha parar e pedir uma pessoa. */
export const SHEET_MAX_ATTEMPTS = 3;

export type SheetState = "pending" | "ready" | "failed";

export type SheetPreparation = {
  state: SheetState;
  errorCode: string;
  attempts: number;
  filled: number;
  readable: number;
};

type AttachmentRow = { id: string; filename: string; contentType: string; objectKey: string };

/** Os anexos da demanda, para escolher qual é a ficha. */
export async function listCardAttachments(d1: Database, workspaceId: string, cardId: string) {
  const rows = await d1.prepare(`SELECT id, filename, content_type AS "contentType", object_key AS "objectKey"
    FROM fdp_card_attachments WHERE workspace_id = ? AND card_id = ? ORDER BY created_at DESC`)
    .bind(workspaceId, cardId).all<AttachmentRow>();
  return rows.results ?? [];
}

/**
 * Marca a ficha como pendente de preparo.
 *
 * ## A regra que protege a correção manual
 *
 * Uma ficha já pronta **não** volta para `pending` só porque a transferência
 * rodou de novo com o mesmo arquivo. Quem conferiu e corrigiu campos não pode
 * perder esse trabalho por um reprocessamento que ninguém pediu.
 *
 * O que reabre o preparo é um anexo **diferente** — documento novo é informação
 * nova, e aí a releitura é o comportamento certo. Mesmo assim ela não apaga a
 * ficha atual: grava por cima apenas quando a leitura nova terminar bem.
 */
export async function enqueueSheetPreparation(d1: Database, input: {
  workspaceId: string;
  cardId: string;
  attachment: Pick<AttachmentRow, "id" | "filename">;
  requestedByKind: "user" | "transfer";
  createdBy: string;
}) {
  const inserted = await d1.prepare(`INSERT INTO fdp_admission_sheets
      (id, workspace_id, card_id, attachment_id, source_filename, state, requested_by_kind, created_by)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT (workspace_id, card_id) DO UPDATE SET
      attachment_id = EXCLUDED.attachment_id,
      source_filename = EXCLUDED.source_filename,
      state = 'pending', error_code = '', attempts = 0, last_attempt_at = NULL,
      requested_by_kind = EXCLUDED.requested_by_kind,
      updated_at = CURRENT_TIMESTAMP
    WHERE fdp_admission_sheets.state <> 'ready'
       OR fdp_admission_sheets.attachment_id <> EXCLUDED.attachment_id
    RETURNING id, state`)
    .bind(crypto.randomUUID(), input.workspaceId, input.cardId, input.attachment.id,
      input.attachment.filename.slice(0, 220), input.requestedByKind, input.createdBy)
    .first<{ id: string; state: string }>();
  return { enqueued: Boolean(inserted), sheetId: inserted?.id ?? "" };
}

/** Fichas aguardando preparo, mais antigas primeiro. */
export async function claimPendingSheets(d1: Database, workspaceId: string, limit = 5) {
  const rows = await d1.prepare(`SELECT card_id, attempts FROM fdp_admission_sheets
    WHERE workspace_id = ? AND state = 'pending' AND attempts < ?
    ORDER BY last_attempt_at NULLS FIRST, created_at
    LIMIT ?`)
    .bind(workspaceId, SHEET_MAX_ATTEMPTS, Math.max(1, Math.min(25, limit)))
    .all<{ card_id: string; attempts: number }>();
  return rows.results ?? [];
}

/**
 * Lê o PDF anexado e grava a ficha.
 *
 * Devolve o estado resultante em vez de lançar, porque os três chamadores
 * querem coisas diferentes do mesmo fracasso: a conclusão da transferência não
 * pode falhar por causa da leitura (o arquivo chegou, e isso é um fato), o cron
 * quer contar e seguir, e a releitura manual quer o motivo na tela.
 */
export async function prepareAdmissionSheet(d1: Database, input: {
  workspaceId: string;
  cardId: string;
}): Promise<SheetPreparation> {
  const current = await d1.prepare(`SELECT attempts, attachment_id FROM fdp_admission_sheets
    WHERE workspace_id = ? AND card_id = ?`)
    .bind(input.workspaceId, input.cardId).first<{ attempts: number; attachment_id: string }>();
  const attempts = Number(current?.attempts ?? 0) + 1;

  const fail = async (errorCode: string) => {
    /* Esgotadas as tentativas, o estado vira `failed` e a máquina para de
       insistir. Insistir para sempre numa leitura que não vai dar certo
       consome varredura e esconde o problema de quem poderia resolvê-lo. */
    const state: SheetState = attempts >= SHEET_MAX_ATTEMPTS ? "failed" : "pending";
    await d1.prepare(`UPDATE fdp_admission_sheets
      SET state = ?, error_code = ?, attempts = ?, last_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND card_id = ?`)
      .bind(state, errorCode.slice(0, 120), attempts, input.workspaceId, input.cardId).run();
    log("warn", "admission.sheet_preparation_failed", { workspaceId: input.workspaceId }, {
      cardId: input.cardId, errorCode, attempts, state,
    });
    return { state, errorCode, attempts, filled: 0, readable: 0 };
  };

  const attachments = await listCardAttachments(d1, input.workspaceId, input.cardId);
  const chosen = chooseRegistrationFormAttachment(attachments);
  if (!chosen) return fail("REGISTRATION_FORM_NOT_ATTACHED");

  const object = await getAttachmentsBucket().get(chosen.objectKey);
  if (!object) return fail("ATTACHMENT_MISSING");

  let extracted: Awaited<ReturnType<typeof readRegistrationFormPdf>>;
  try {
    extracted = await readRegistrationFormPdf(new Uint8Array(await new Response(object.body).arrayBuffer()));
  } catch (cause) {
    /* Documento que não é PDF, PDF sem camada de texto ou arquivo grande demais
       não melhoram com nova tentativa: são propriedades do arquivo. Marcar
       direto como `failed` evita três varreduras para chegar à mesma conclusão. */
    void cause;
    await d1.prepare(`UPDATE fdp_admission_sheets
      SET state = 'failed', error_code = 'REGISTRATION_FORM_UNREADABLE', attempts = ?,
          last_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND card_id = ?`)
      .bind(attempts, input.workspaceId, input.cardId).run();
    return { state: "failed", errorCode: "REGISTRATION_FORM_UNREADABLE", attempts, filled: 0, readable: 0 };
  }

  const sheet = buildRegistrationSheet(extracted.fields);
  const sealed = sealSheet(extracted.fields);
  const warnings = sanitizeSheetWarnings([...extracted.warnings, ...sheet.warnings]);

  await d1.prepare(`UPDATE fdp_admission_sheets SET
      attachment_id = ?, source_filename = ?, encrypted_value = ?, initialization_vector = ?,
      auth_tag = ?, key_version = ?, filled_count = ?, readable_count = ?, warnings_json = ?,
      state = 'ready', error_code = '', attempts = ?, last_attempt_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND card_id = ?`)
    .bind(chosen.id, chosen.filename.slice(0, 220), sealed.encryptedValue, sealed.initializationVector,
      sealed.authTag, sealed.keyVersion, sheet.filled, sheet.readable, JSON.stringify(warnings),
      attempts, input.workspaceId, input.cardId).run();

  return { state: "ready", errorCode: "", attempts, filled: sheet.filled, readable: sheet.readable };
}

/** Enfileira e já tenta uma vez — o caso comum termina sem esperar a varredura. */
export async function prepareSheetAfterTransfer(d1: Database, input: {
  workspaceId: string;
  cardId: string;
}) {
  const attachments = await listCardAttachments(d1, input.workspaceId, input.cardId);
  const chosen = chooseRegistrationFormAttachment(attachments);
  if (!chosen) return { enqueued: false, preparation: null as SheetPreparation | null };

  const { enqueued } = await enqueueSheetPreparation(d1, {
    workspaceId: input.workspaceId, cardId: input.cardId,
    attachment: chosen, requestedByKind: "transfer", createdBy: "SYSTEM",
  });
  if (!enqueued) return { enqueued: false, preparation: null };
  return { enqueued: true, preparation: await prepareAdmissionSheet(d1, input) };
}

/** Traduz o código guardado na frase que a tela mostra. */
export const SHEET_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  REGISTRATION_FORM_NOT_ATTACHED: "A ficha de registro em PDF ainda não está anexada a esta demanda.",
  ATTACHMENT_MISSING: "O arquivo da ficha não está mais disponível no armazenamento.",
  REGISTRATION_FORM_UNREADABLE: "O arquivo anexado não pôde ser lido como ficha de registro. "
    + "Pode não ser um PDF, não ter camada de texto ou seguir outro modelo. Confira o documento e preencha os campos à mão.",
};

export function sheetErrorMessage(errorCode: string) {
  return SHEET_ERROR_MESSAGES[errorCode] ?? (errorCode ? "A leitura da ficha não pôde ser concluída." : "");
}

/** Erro de API para a releitura manual, quando o preparo não chegou a `ready`. */
export function sheetPreparationError(preparation: SheetPreparation) {
  return new ApiError(422, preparation.errorCode || "ADMISSION_SHEET_NOT_READY",
    sheetErrorMessage(preparation.errorCode));
}
