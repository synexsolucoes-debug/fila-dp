import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { getAttachmentsBucket } from "@/db";

type RouteContext = { params: Promise<{ id: string }> };
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const allowedMimeTypes = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const allowedExtensions = new Set(["pdf", "jpg", "jpeg", "png", "webp", "txt", "csv", "docx", "xlsx"]);

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 * 10 ? 1 : 0)} MB`;

/**
 * Explica por que a gravação não passou, depois de ela não passar.
 *
 * Duas causas diferentes chegam aqui, e confundi-las manda o cliente para o
 * lugar errado: cota do plano esgotada resolve-se mudando de plano ou apagando
 * anexos; workspace sem assinatura ativa é problema de contrato, e nenhuma
 * faxina de arquivos resolve.
 */
async function storageQuotaError(
  d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"],
  workspaceId: string,
  incomingBytes: number,
) {
  const row = await d1.prepare(`SELECT
      (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM fdp_card_attachments WHERE workspace_id = $1) AS used,
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

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_SIZE + 1024 * 1024) return Response.json({ error: "O arquivo excede o limite de 20 MB." }, { status: 413 });

  try {
    const { id } = await context.params;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const card = await d1.prepare("SELECT id FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).first();
    if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return Response.json({ error: "Selecione um arquivo válido." }, { status: 400 });
    if (file.size > MAX_FILE_SIZE) return Response.json({ error: "O arquivo excede o limite de 20 MB." }, { status: 413 });
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowedMimeTypes.has(file.type) || !allowedExtensions.has(extension)) {
      return Response.json({ error: "Tipo de arquivo não permitido. Use PDF, imagem, TXT, CSV, DOCX ou XLSX." }, { status: 415 });
    }

    const attachmentId = crypto.randomUUID();
    const objectKey = `workspaces/${workspace.id}/cards/${id}/${attachmentId}`;
    const bucket = getAttachmentsBucket();
    await bucket.put(objectKey, file.stream(), {
      httpMetadata: { contentType: file.type, contentDisposition: "attachment" },
      customMetadata: { attachmentId, cardId: id, workspaceId: workspace.id },
    });
    try {
      // A cota de armazenamento do plano é conferida aqui, na mesma instrução
      // que grava — como já se faz com empresas e assentos. O teto por arquivo
      // (20 MB) existia, mas o total por workspace não era aplicado em lugar
      // nenhum: o plano anunciava 1 GB no Starter e nada impedia o cliente de
      // passar disso, um arquivo de 20 MB por vez. `storage_limit_mb` só
      // aparecia em código de leitura.
      //
      // O bloqueio precisa ser atômico: conferir antes e gravar depois deixaria
      // dois envios simultâneos passarem juntos pela última fatia da cota.
      const stored = await d1.prepare(`WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext(?))
        ), entitlement AS (
          SELECT plan.storage_limit_mb FROM fdp_workspace_subscriptions subscription
          JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
          WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
        ), inserted AS (
          INSERT INTO fdp_card_attachments
            (id, workspace_id, card_id, object_key, filename, content_type, size_bytes, uploaded_by)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM entitlement
          WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_card_attachments WHERE workspace_id = ?) + ?
            <= entitlement.storage_limit_mb::bigint * 1024 * 1024
          RETURNING id
        ) SELECT id FROM inserted`)
        .bind(workspace.id, workspace.id, attachmentId, workspace.id, id, objectKey, file.name.slice(0, 220),
          file.type, file.size, auth.user.email, workspace.id, file.size)
        .first<{ id: string }>();

      if (!stored) {
        // O arquivo já subiu para o armazenamento; sem a linha no banco ele
        // seria lixo invisível, pago e nunca referenciado.
        await bucket.delete(objectKey).catch(() => undefined);
        throw await storageQuotaError(d1, workspace.id, file.size);
      }
    } catch (error) {
      await bucket.delete(objectKey).catch(() => undefined);
      throw error;
    }
    await recordActivity(workspace.id, id, auth.user.email, "attachment.uploaded", { attachmentId, filename: file.name, sizeBytes: file.size });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
