import { getAttachmentsBucket } from "@/db";
import { requireCapability } from "@/lib/authorization";
import {
  chooseRegistrationFormAttachment, openSheet, sanitizeSheetWarnings, sealSheet,
} from "@/lib/admission-sheet";
import { buildRegistrationSheet } from "@/lib/employee-registration-form";
import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, prepareAuditEvent, recordActivity, requireCardCompanyAccess, requireWorkspaceRole,
} from "@/lib/fila-dp-db";
import { readRegistrationFormPdf } from "@/lib/registration-form-pdf";

type RouteContext = { params: Promise<{ id: string }> };

type StoredSheet = {
  id: string;
  attachment_id: string;
  source_filename: string;
  encrypted_value: string;
  initialization_vector: string;
  auth_tag: string;
  key_version: number;
  warnings_json: string;
  created_by: string;
  updated_at: string;
};

/**
 * A ficha NÃO viaja no retrato do workspace.
 *
 * Todo o resto da demanda chega pelo `getWorkspaceSnapshot`, que a tela carrega
 * inteiro a cada navegação. Pôr valor de documento ali o colocaria na memória
 * do navegador de qualquer pessoa que abrisse o painel, tivesse ou não aberto a
 * demanda — e no cache de qualquer intermediário que guardasse a resposta.
 *
 * Por isso a ficha tem rota própria, buscada quando a aba abre e por quem tem a
 * capability. É o que torna `admission.sheet.read` uma barreira de verdade, em
 * vez de um enfeite sobre um dado que já foi entregue.
 */
async function loadCard(auth: NonNullable<Awaited<ReturnType<typeof getApiUser>>["user"]>, cardId: string) {
  const context = await getWorkspaceContext(auth);
  const { d1, workspace, board, user } = context;
  await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, cardId);
  const card = await d1.prepare(`SELECT id FROM fdp_cards
    WHERE workspace_id = ? AND board_id = ? AND id = ? AND archived = 0`)
    .bind(workspace.id, board.id, cardId).first<{ id: string }>();
  if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
  return context;
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id: cardId } = await context.params;
    const { d1, workspace } = await loadCard(auth.user, cardId);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "admission.sheet.read");

    const stored = await d1.prepare(`SELECT id, attachment_id, source_filename, encrypted_value,
        initialization_vector, auth_tag, key_version, warnings_json, created_by, updated_at
      FROM fdp_admission_sheets WHERE workspace_id = ? AND card_id = ?`)
      .bind(workspace.id, cardId).first<StoredSheet>();
    if (!stored) return Response.json({ sheet: null });

    const fields = openSheet({
      encryptedValue: stored.encrypted_value,
      initializationVector: stored.initialization_vector,
      authTag: stored.auth_tag,
      keyVersion: stored.key_version,
    });
    const sheet = buildRegistrationSheet(fields);

    // Auditar o ACESSO, nunca o conteúdo: escrever os campos lidos no histórico
    // recriaria em texto aberto exatamente o que a cifra existe para proteger.
    await d1.batch([
      prepareAuditEvent({
        workspaceId: workspace.id, actorType: "user", actorEmail: auth.user.email,
        action: "admission.sheet.read", entityType: "card", entityId: cardId,
        after: { sheetId: stored.id, readableCount: sheet.readable },
      }),
    ]);

    return Response.json({
      sheet: {
        ...sheet,
        warnings: [...sheet.warnings, ...sanitizeSheetWarnings(JSON.parse(stored.warnings_json || "[]"))],
        sourceFilename: stored.source_filename,
        attachmentId: stored.attachment_id,
        updatedAt: stored.updated_at,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

/** Lê (ou relê) a ficha a partir do PDF já anexado à demanda. */
export async function POST(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id: cardId } = await context.params;
    const { d1, workspace, user } = await loadCard(auth.user, cardId);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "attachments.write");
    requireCapability(workspace, "admission.sheet.read");

    const attachments = await d1.prepare(`SELECT id, filename, content_type AS "contentType", object_key AS "objectKey"
      FROM fdp_card_attachments WHERE workspace_id = ? AND card_id = ? ORDER BY created_at DESC`)
      .bind(workspace.id, cardId).all<{ id: string; filename: string; contentType: string; objectKey: string }>();

    const chosen = chooseRegistrationFormAttachment(attachments.results ?? []);
    if (!chosen) {
      throw new ApiError(409, "REGISTRATION_FORM_NOT_ATTACHED",
        "Esta demanda ainda não tem a ficha de registro em PDF. Use \"Autorizar anexos da Sólides\" para trazê-la.");
    }

    const object = await getAttachmentsBucket().get(chosen.objectKey);
    if (!object) throw ApiError.notFound("O arquivo da ficha não está mais disponível.", "ATTACHMENT_NOT_FOUND");
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());

    let extracted: Awaited<ReturnType<typeof readRegistrationFormPdf>>;
    try {
      extracted = await readRegistrationFormPdf(bytes);
    } catch (cause) {
      throw new ApiError(422, "REGISTRATION_FORM_UNREADABLE",
        cause instanceof Error ? cause.message : "Não foi possível ler a ficha de registro.");
    }

    const sheet = buildRegistrationSheet(extracted.fields);
    const sealed = sealSheet(extracted.fields);
    const warnings = sanitizeSheetWarnings([...extracted.warnings, ...sheet.warnings]);
    const sheetId = crypto.randomUUID();

    // Uma ficha por demanda: reler substitui. Duas transcrições da mesma pessoa
    // seriam duas respostas para a mesma pergunta, e a tela teria de escolher
    // uma sem critério.
    await d1.prepare(`INSERT INTO fdp_admission_sheets
        (id, workspace_id, card_id, attachment_id, source_filename, encrypted_value, initialization_vector,
         auth_tag, key_version, filled_count, readable_count, warnings_json, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, card_id) DO UPDATE SET
        attachment_id = EXCLUDED.attachment_id, source_filename = EXCLUDED.source_filename,
        encrypted_value = EXCLUDED.encrypted_value, initialization_vector = EXCLUDED.initialization_vector,
        auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version,
        filled_count = EXCLUDED.filled_count, readable_count = EXCLUDED.readable_count,
        warnings_json = EXCLUDED.warnings_json, updated_at = CURRENT_TIMESTAMP`)
      .bind(sheetId, workspace.id, cardId, chosen.id, chosen.filename.slice(0, 220), sealed.encryptedValue,
        sealed.initializationVector, sealed.authTag, sealed.keyVersion, sheet.filled, sheet.readable,
        JSON.stringify(warnings), user.id).run();

    await d1.batch([
      prepareAuditEvent({
        workspaceId: workspace.id, actorType: "user", actorEmail: auth.user.email,
        action: "admission.sheet.built", entityType: "card", entityId: cardId,
        after: { attachmentId: chosen.id, filled: sheet.filled, readable: sheet.readable, warnings: warnings.length },
      }),
    ]);
    await recordActivity(workspace.id, cardId, auth.user.email, "admission.sheet.built", {
      filled: sheet.filled, readable: sheet.readable,
    });

    return Response.json({
      sheet: { ...sheet, warnings, sourceFilename: chosen.filename, attachmentId: chosen.id },
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

/** Expurgo manual. O automático acontece ao concluir a demanda. */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id: cardId } = await context.params;
    const { d1, workspace } = await loadCard(auth.user, cardId);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "attachments.write");

    const result = await d1.prepare("DELETE FROM fdp_admission_sheets WHERE workspace_id = ? AND card_id = ?")
      .bind(workspace.id, cardId).run();
    if (result.meta.changes) {
      await d1.batch([
        prepareAuditEvent({
          workspaceId: workspace.id, actorType: "user", actorEmail: auth.user.email,
          action: "admission.sheet.purged", entityType: "card", entityId: cardId, after: { reason: "manual" },
        }),
      ]);
      await recordActivity(workspace.id, cardId, auth.user.email, "admission.sheet.purged", { reason: "manual" });
    }
    return Response.json({ sheet: null });
  } catch (error) {
    return apiError(error);
  }
}
