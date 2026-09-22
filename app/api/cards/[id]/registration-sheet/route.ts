import { requireCapability } from "@/lib/authorization";
import { chooseRegistrationFormAttachment, openSheet, sanitizeSheetFields, sanitizeSheetWarnings, sealSheet } from "@/lib/admission-sheet";
import {
  detectIdentityDivergence, mergeSheetFields, registryFields, sanitizeFieldMeta, type FieldMetaMap,
} from "@/lib/admission-sheet-fields";
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
  overrides_encrypted_value: string | null;
  overrides_initialization_vector: string | null;
  overrides_auth_tag: string | null;
  overrides_key_version: number | null;
  field_meta_json: string;
  erp_registration: string;
  confirmed_at: string | null;
  confirmed_by: string;
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
        overrides_encrypted_value, overrides_initialization_vector, overrides_auth_tag, overrides_key_version,
        field_meta_json, erp_registration, confirmed_at::text AS confirmed_at, confirmed_by,
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

    const extracted = openSheet({
      encryptedValue: stored.encrypted_value,
      initializationVector: stored.initialization_vector,
      authTag: stored.auth_tag,
      keyVersion: stored.key_version,
    });
    const overrides = openOverrides(stored);
    const meta = sanitizeFieldMeta(JSON.parse(stored.field_meta_json || "{}"));

    /* O cadastro só entra quando a identidade bate. Um documento de outra
       pessoa anexado na demanda errada é o erro mais caro desta tela — e o
       único que ninguém percebe olhando para ela. */
    const employee = await loadLinkedEmployee(d1, workspace.id, cardId);
    const divergences = detectIdentityDivergence({ extracted, employee });
    const registry = divergences.length === 0 ? registryFields(employee) : {};

    const merged = mergeSheetFields({ extracted, overrides, registry, meta });
    const sheet = buildRegistrationSheet(Object.fromEntries(
      Object.entries(merged).map(([key, field]) => [key, field.value])));

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
      divergences,
      confirmation: stored.confirmed_at
        ? { erpRegistration: stored.erp_registration, confirmedAt: stored.confirmed_at, confirmedBy: stored.confirmed_by }
        : null,
      sheet: {
        ...sheet,
        provenance: Object.fromEntries(Object.entries(merged).map(([key, field]) => [key, {
          source: field.source, documentValue: field.documentValue, by: field.by, at: field.at,
        }])),
        warnings: sanitizeSheetWarnings([
          ...sheet.warnings, ...sanitizeSheetWarnings(JSON.parse(stored.warnings_json || "[]")),
        ]),
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


/** Abre o envelope das correções manuais. Ausente é ficha sem correção. */
function openOverrides(stored: Pick<StoredSheet,
  "overrides_encrypted_value" | "overrides_initialization_vector" | "overrides_auth_tag" | "overrides_key_version">) {
  if (!stored.overrides_encrypted_value || !stored.overrides_initialization_vector
    || !stored.overrides_auth_tag || stored.overrides_key_version === null) {
    return {};
  }
  return openSheet({
    encryptedValue: stored.overrides_encrypted_value,
    initializationVector: stored.overrides_initialization_vector,
    authTag: stored.overrides_auth_tag,
    keyVersion: stored.overrides_key_version,
  });
}

/** O colaborador vinculado à demanda, para conferir identidade e completar contrato. */
async function loadLinkedEmployee(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"], workspaceId: string, cardId: string) {
  const row = await d1.prepare(`SELECT employee.full_name, employee.cpf_last4, employee.admission_date::text AS admission_date,
      position.name AS position_name, company.trade_name, company.legal_name
    FROM fdp_cards card
    JOIN fdp_employees employee ON employee.workspace_id = card.workspace_id AND employee.id = card.employee_id
    LEFT JOIN fdp_positions position ON position.workspace_id = employee.workspace_id AND position.id = employee.position_id
    LEFT JOIN fdp_companies company ON company.workspace_id = employee.workspace_id AND company.id = employee.company_id
    WHERE card.workspace_id = ? AND card.id = ?`)
    .bind(workspaceId, cardId).first<Record<string, unknown>>();
  if (!row) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    fullName: text(row.full_name),
    cpfLast4: text(row.cpf_last4),
    admissionDate: text(row.admission_date),
    positionName: text(row.position_name),
    companyName: text(row.trade_name) || text(row.legal_name),
  };
}

/**
 * Corrige ou completa um campo à mão.
 *
 * Os dados bancários vêm vazios no Registro de Empregado, e o ERP costuma
 * exigi-los: sem esta porta, a ficha entregaria uma admissão que não fecha. O
 * valor extraído continua guardado, e a tela mostra os dois quando divergem —
 * corrigir não apaga o que o documento disse.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id: cardId } = await context.params;
    const { d1, workspace, user } = await loadCard(auth.user, cardId);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "attachments.write");
    requireCapability(workspace, "admission.sheet.read");

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const incoming = sanitizeSheetFields(body.fields);
    if (Object.keys(incoming).length === 0) {
      throw ApiError.badRequest("Informe ao menos um campo válido.", "ADMISSION_SHEET_FIELDS_REQUIRED");
    }

    const stored = await d1.prepare(`SELECT overrides_encrypted_value, overrides_initialization_vector,
        overrides_auth_tag, overrides_key_version, field_meta_json, confirmed_at
      FROM fdp_admission_sheets WHERE workspace_id = ? AND card_id = ?`)
      .bind(workspace.id, cardId).first<StoredSheet & { confirmed_at: string | null }>();
    if (!stored) throw ApiError.notFound("Esta demanda ainda não tem ficha.", "ADMISSION_SHEET_NOT_FOUND");
    if (stored.confirmed_at) {
      throw new ApiError(409, "ADMISSION_SHEET_CONFIRMED",
        "Esta ficha já foi confirmada como cadastrada no ERP. Reabra a conferência antes de alterar campos.");
    }

    const merged = { ...openOverrides(stored), ...incoming };
    const sealed = sealSheet(merged);
    const meta: FieldMetaMap = sanitizeFieldMeta(JSON.parse(stored.field_meta_json || "{}"));
    const at = new Date().toISOString();
    for (const key of Object.keys(incoming)) meta[key] = { source: "manual", by: auth.user.email, at };

    await d1.prepare(`UPDATE fdp_admission_sheets SET
        overrides_encrypted_value = ?, overrides_initialization_vector = ?, overrides_auth_tag = ?,
        overrides_key_version = ?, field_meta_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND card_id = ?`)
      .bind(sealed.encryptedValue, sealed.initializationVector, sealed.authTag, sealed.keyVersion,
        JSON.stringify(meta), workspace.id, cardId).run();

    /* A auditoria nomeia os campos alterados e não os valores: registrar o
       conteúdo recriaria em texto aberto o que a cifra existe para proteger. */
    await d1.batch([
      prepareAuditEvent({
        workspaceId: workspace.id, actorType: "user", actorEmail: auth.user.email,
        action: "admission.sheet.field_edited", entityType: "card", entityId: cardId,
        after: { fields: Object.keys(incoming) },
      }),
    ]);
    await recordActivity(workspace.id, cardId, auth.user.email, "admission.sheet.field_edited", {
      fields: Object.keys(incoming).length,
    });
    void user;
    return Response.json({ saved: Object.keys(incoming) });
  } catch (error) {
    return apiError(error);
  }
}
