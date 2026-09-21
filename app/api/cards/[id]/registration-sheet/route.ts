import { requireCapability } from "@/lib/authorization";
import { chooseRegistrationFormAttachment, openSheet, sanitizeSheetWarnings } from "@/lib/admission-sheet";
import {
  enqueueSheetPreparation, listCardAttachments, prepareAdmissionSheet, sheetErrorMessage, SHEET_MAX_ATTEMPTS,
} from "@/lib/admission-sheet-service";
import { buildRegistrationSheet } from "@/lib/employee-registration-form";
import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, prepareAuditEvent, recordActivity, requireCardCompanyAccess, requireWorkspaceRole,
} from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

type StoredSheet = {
  id: string;
  attachment_id: string;
  source_filename: string;
  encrypted_value: string | null;
  initialization_vector: string | null;
  auth_tag: string | null;
  key_version: number | null;
  warnings_json: string;
  state: "pending" | "ready" | "failed";
  error_code: string;
  attempts: number;
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
        initialization_vector, auth_tag, key_version, warnings_json, state, error_code, attempts,
        created_by, updated_at
      FROM fdp_admission_sheets WHERE workspace_id = ? AND card_id = ?`)
      .bind(workspace.id, cardId).first<StoredSheet>();
    if (!stored) return Response.json({ sheet: null, state: "absent" });

    /* Pendente e falha não têm envelope para abrir, e não podem ser
       apresentadas como "nenhuma ficha". A tela precisa distinguir "estamos
       preparando" de "não foi possível ler" de "ninguém pediu ainda" — as três
       pedem coisas diferentes de quem está olhando. */
    if (stored.state !== "ready" || !stored.encrypted_value || !stored.initialization_vector
      || !stored.auth_tag || stored.key_version === null) {
      return Response.json({
        sheet: null,
        state: stored.state,
        attempts: stored.attempts,
        maxAttempts: SHEET_MAX_ATTEMPTS,
        errorCode: stored.error_code,
        errorMessage: sheetErrorMessage(stored.error_code),
        sourceFilename: stored.source_filename,
        attachmentId: stored.attachment_id,
      });
    }

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
      state: "ready",
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

    const chosen = chooseRegistrationFormAttachment(await listCardAttachments(d1, workspace.id, cardId));
    if (!chosen) {
      throw new ApiError(409, "REGISTRATION_FORM_NOT_ATTACHED",
        "Esta demanda ainda não tem a ficha de registro em PDF. Use \"Autorizar anexos da Sólides\" para trazê-la.");
    }

    /* A releitura passa pelo mesmo serviço que a chegada do PDF e o cron usam.
       Antes esta rota tinha a leitura inteira escrita aqui dentro, e foi assim
       que o preparo automático nasceu sem existir: a regra morava num lugar que
       só um clique alcançava. */
    await enqueueSheetPreparation(d1, {
      workspaceId: workspace.id, cardId, attachment: chosen,
      requestedByKind: "user", createdBy: user.id,
    });
    const preparation = await prepareAdmissionSheet(d1, { workspaceId: workspace.id, cardId });

    await d1.batch([
      prepareAuditEvent({
        workspaceId: workspace.id, actorType: "user", actorEmail: auth.user.email,
        action: "admission.sheet.built", entityType: "card", entityId: cardId,
        after: {
          attachmentId: chosen.id, state: preparation.state,
          filled: preparation.filled, readable: preparation.readable, errorCode: preparation.errorCode,
        },
      }),
    ]);
    await recordActivity(workspace.id, cardId, auth.user.email, "admission.sheet.built", {
      state: preparation.state, filled: preparation.filled, readable: preparation.readable,
    });

    /* Leitura que não chegou a `ready` não devolve 201 com ficha vazia: a
       tela precisa da diferença entre "pronta" e "não deu", e um sucesso
       genérico aqui esconderia a segunda. */
    if (preparation.state !== "ready") {
      return Response.json({
        sheet: null,
        state: preparation.state,
        attempts: preparation.attempts,
        maxAttempts: SHEET_MAX_ATTEMPTS,
        errorCode: preparation.errorCode,
        errorMessage: sheetErrorMessage(preparation.errorCode),
        sourceFilename: chosen.filename,
        attachmentId: chosen.id,
      }, { status: 200 });
    }

    const ready = await d1.prepare(`SELECT encrypted_value, initialization_vector, auth_tag, key_version, warnings_json
      FROM fdp_admission_sheets WHERE workspace_id = ? AND card_id = ?`)
      .bind(workspace.id, cardId)
      .first<{ encrypted_value: string; initialization_vector: string; auth_tag: string; key_version: number; warnings_json: string }>();
    const sheet = buildRegistrationSheet(openSheet({
      encryptedValue: ready!.encrypted_value,
      initializationVector: ready!.initialization_vector,
      authTag: ready!.auth_tag,
      keyVersion: ready!.key_version,
    }));
    return Response.json({
      state: "ready",
      sheet: {
        ...sheet,
        warnings: [...sheet.warnings, ...sanitizeSheetWarnings(JSON.parse(ready!.warnings_json || "[]"))],
        sourceFilename: chosen.filename,
        attachmentId: chosen.id,
      },
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
