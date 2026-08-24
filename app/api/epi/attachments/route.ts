import { getAttachmentsBucket } from "@/db";
import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";
import { epiAttachmentKinds, type EpiAttachmentKind } from "@/lib/epi";
import { epiText, parseAttachmentEntity } from "@/lib/epi-service";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const allowedMimeTypes = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const allowedExtensions = new Set(["pdf", "jpg", "jpeg", "png", "webp", "txt", "csv", "docx", "xlsx"]);

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 * 10 ? 1 : 0)} MB`;

/**
 * Escopo do registro que vai receber o anexo.
 *
 * A alternativa óbvia — interpolar o nome da tabela a partir do tipo — deixa a
 * consulta fora da verificação de `scripts/verify-inline-sql`, que prepara cada
 * instrução contra o schema real: um nome de coluna errado numa das seis
 * tabelas só apareceria no cliente. Escrita como união estática, a consulta é
 * verificável, e o planejador empurra os dois filtros para dentro de cada ramo.
 *
 * O SQL fica aqui dentro, e não numa constante compartilhada, porque o coletor
 * do verificador só enxerga o literal escrito em `.prepare(`. Guardá-lo numa
 * constante tiraria a consulta da contagem de não verificadas — sem verificá-la,
 * que é o pior dos dois resultados.
 */
async function entityOwner(
  d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"],
  workspaceId: string,
  entityType: string,
  entityId: string,
) {
  const owner = await d1.prepare(`SELECT company_id FROM (
      SELECT 'product' AS entity_kind, id, workspace_id, NULL::text AS company_id FROM fdp_epi_products
      UNION ALL SELECT 'delivery', id, workspace_id, company_id FROM fdp_epi_deliveries
      UNION ALL SELECT 'return', id, workspace_id, company_id FROM fdp_epi_returns
      UNION ALL SELECT 'damage', id, workspace_id, company_id FROM fdp_epi_damages
      UNION ALL SELECT 'disposal', id, workspace_id, company_id FROM fdp_epi_disposals
      UNION ALL SELECT 'discount', id, workspace_id, company_id FROM fdp_epi_discount_requests
    ) epi_entity
    WHERE epi_entity.workspace_id = ? AND epi_entity.entity_kind = ? AND epi_entity.id = ?`)
    .bind(workspaceId, entityType, entityId).first<{ company_id: string | null }>();
  if (!owner) throw ApiError.notFound("Registro de EPI não encontrado.", "EPI_ENTITY_NOT_FOUND");
  return owner;
}

async function storageQuotaError(
  d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"],
  workspaceId: string,
  incomingBytes: number,
) {
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

/**
 * Evidência anexada a um registro de EPI.
 *
 * O anexo é sempre de um registro existente — termo de entrega, foto do dano,
 * comprovante do descarte. Não há anexo solto: sem dono ele não apareceria em
 * nenhuma tela e ocuparia cota para sempre.
 *
 * A cota do plano é a mesma dos anexos de demanda e é conferida na instrução
 * que grava, somando as duas tabelas. Guardar o arquivo primeiro e conferir
 * depois deixaria dois envios simultâneos passarem juntos pela última fatia.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_SIZE + 1024 * 1024) return Response.json({ error: "O arquivo excede o limite de 20 MB." }, { status: 413 });

  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.edit", "anexar evidências ao Controle de EPI");
    const form = await request.formData();
    const entityType = parseAttachmentEntity(form.get("entityType"));
    const entityId = epiText(form.get("entityId"), "o registro de destino", 120, true);
    const kindValue = cleanText(form.get("kind"), 40) || "evidence";
    const kind = (epiAttachmentKinds.includes(kindValue as EpiAttachmentKind) ? kindValue : "evidence") as EpiAttachmentKind;

    const owner = await entityOwner(d1, workspace.id, entityType, entityId);
    if (owner.company_id) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, owner.company_id);

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Selecione um arquivo válido." }, { status: 400 });
    if (file.size > MAX_FILE_SIZE) return Response.json({ error: "O arquivo excede o limite de 20 MB." }, { status: 413 });
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowedMimeTypes.has(file.type) || !allowedExtensions.has(extension)) {
      return Response.json({ error: "Tipo de arquivo não permitido. Use PDF, imagem, TXT, CSV, DOCX ou XLSX." }, { status: 415 });
    }

    const attachmentId = crypto.randomUUID();
    const objectKey = `workspaces/${workspace.id}/epi/${entityType}/${entityId}/${attachmentId}`;
    const bucket = getAttachmentsBucket();
    await bucket.put(objectKey, file.stream(), {
      httpMetadata: { contentType: file.type, contentDisposition: "attachment" },
      customMetadata: { attachmentId, entityType, entityId, workspaceId: workspace.id },
    });
    try {
      const stored = await d1.prepare(`WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext(?))
        ), entitlement AS (
          SELECT plan.storage_limit_mb FROM fdp_workspace_subscriptions subscription
          JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
          WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
        ), inserted AS (
          INSERT INTO fdp_epi_attachments
            (id, workspace_id, company_id, entity_type, entity_id, attachment_kind, object_key, filename, content_type, size_bytes, created_by)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM entitlement
          WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_card_attachments WHERE workspace_id = ?)
              + (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_epi_attachments WHERE workspace_id = ?)
              + (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_contractor_documents WHERE workspace_id = ?) + ?
            <= entitlement.storage_limit_mb::bigint * 1024 * 1024
          RETURNING id
        ) SELECT id FROM inserted`)
        .bind(workspace.id, workspace.id, attachmentId, workspace.id, owner.company_id, entityType, entityId,
          kind, objectKey, file.name.slice(0, 220), file.type, file.size, user.id,
          workspace.id, workspace.id, workspace.id, file.size)
        .first<{ id: string }>();

      if (!stored) {
        await bucket.delete(objectKey).catch(() => undefined);
        throw await storageQuotaError(d1, workspace.id, file.size);
      }
    } catch (error) {
      await bucket.delete(objectKey).catch(() => undefined);
      throw error;
    }

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_attachment.uploaded",
      entityType: "epi_attachment", entityId: attachmentId,
      after: { attachmentId, entityType, entityId, kind, filename: file.name.slice(0, 220), sizeBytes: file.size },
      metadata: { companyId: owner.company_id }, requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      attachment: {
        id: attachmentId, entityType, entityId, attachmentKind: kind,
        filename: file.name.slice(0, 220), contentType: file.type, sizeBytes: file.size,
      },
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar anexos do Controle de EPI");
    const url = new URL(request.url);
    const entityType = parseAttachmentEntity(url.searchParams.get("entityType"));
    const entityId = epiText(url.searchParams.get("entityId"), "o registro", 120, true);
    const owner = await entityOwner(d1, workspace.id, entityType, entityId);
    if (owner.company_id) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, owner.company_id);
    const attachments = await d1.prepare(`SELECT id, entity_type, entity_id, attachment_kind, filename, content_type,
        size_bytes, created_at FROM fdp_epi_attachments
      WHERE workspace_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at`)
      .bind(workspace.id, entityType, entityId).all<Record<string, unknown>>();
    return Response.json({ attachments: attachments.results });
  } catch (error) { return apiError(error); }
}
