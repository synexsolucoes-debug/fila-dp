import { getAttachmentsBucket } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { positiveMoney } from "@/lib/payments";
import { findContractorClosing, refreshContractorReconciliation } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const allowedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const allowedExtensions = new Set(["pdf", "jpg", "jpeg", "png", "webp"]);
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

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
      "Este grupo não tem uma assinatura ativa, então a nota fiscal não pode ser guardada.");
  }
  const used = Number(row.used ?? 0);
  const total = Number(row.limit_mb) * 1024 * 1024;
  return new ApiError(409, "STORAGE_LIMIT_REACHED",
    `O armazenamento do plano está em ${megabytes(used)} de ${megabytes(total)} e este arquivo tem ${megabytes(incomingBytes)}.`,
    { usedBytes: used, limitBytes: total, incomingBytes });
}

async function requestValues(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return {
      invoiceNumber: form.get("invoiceNumber"),
      receivedAmount: form.get("receivedAmount"),
      issueDate: form.get("issueDate"),
      attachmentReference: form.get("attachmentReference"),
      file: form.get("invoiceFile"),
    };
  }
  const body = await request.json() as Record<string, unknown>;
  return { ...body, file: null };
}

/** Registra a nota e guarda seu arquivo na pasta documental do contrato PJ. */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  let uploadedObjectKey = "";
  let documentStored = false;
  try {
    const { id } = await params;
    const values = await requestValues(request);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const closing = await findContractorClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);
    if (closing.status === "closed" || closing.status === "paid") {
      throw ApiError.badRequest("O fechamento está concluído. Reabra com justificativa para alterar a nota.", "PAYMENT_CLOSING_LOCKED");
    }

    const invoiceNumber = cleanText(values.invoiceNumber, 80);
    if (!invoiceNumber) throw ApiError.badRequest("Informe o número da nota fiscal.", "INVOICE_NUMBER_REQUIRED");
    const receivedAmount = positiveMoney(values.receivedAmount, "Valor da nota recebida");
    const issueDate = optionalDate(values.issueDate);
    const file = values.file;
    let documentId = "";

    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_SIZE) throw new ApiError(413, "INVOICE_FILE_TOO_LARGE", "O arquivo excede o limite de 20 MB.");
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!allowedMimeTypes.has(file.type) || !allowedExtensions.has(extension)) {
        throw new ApiError(415, "INVOICE_FILE_TYPE_NOT_ALLOWED", "Use PDF, JPG, PNG ou WEBP para a nota fiscal.");
      }

      documentId = crypto.randomUUID();
      uploadedObjectKey = `workspaces/${workspace.id}/contractors/${closing.provider_id}/invoices/${documentId}`;
      const bucket = getAttachmentsBucket();
      await bucket.put(uploadedObjectKey, file.stream(), {
        httpMetadata: { contentType: file.type, contentDisposition: "attachment" },
        customMetadata: { documentId, providerId: closing.provider_id, closingId: id, workspaceId: workspace.id },
      });

      const stored = await d1.prepare(`WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext(?))
        ), entitlement AS (
          SELECT plan.storage_limit_mb FROM fdp_workspace_subscriptions subscription
          JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
          WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
        ), inserted AS (
          INSERT INTO fdp_contractor_documents
            (id, workspace_id, company_id, provider_id, closing_id, document_kind, competence, invoice_number,
             object_key, filename, content_type, size_bytes, created_by)
          SELECT ?, ?, ?, ?, ?, 'invoice', ?, ?, ?, ?, ?, ?, ? FROM entitlement
          WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_card_attachments WHERE workspace_id = ?)
              + (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_epi_attachments WHERE workspace_id = ?)
              + (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_contractor_documents WHERE workspace_id = ?)
              + ? <= entitlement.storage_limit_mb::bigint * 1024 * 1024
          RETURNING id
        ) SELECT id FROM inserted`)
        .bind(workspace.id, workspace.id, documentId, workspace.id, closing.company_id, closing.provider_id, id,
          closing.competence, invoiceNumber, uploadedObjectKey, file.name.slice(0, 220), file.type, file.size, user.id,
          workspace.id, workspace.id, workspace.id, file.size)
        .first<{ id: string }>();
      if (!stored) {
        await bucket.delete(uploadedObjectKey).catch(() => undefined);
        uploadedObjectKey = "";
        throw await storageQuotaError(d1, workspace.id, file.size);
      }
      documentStored = true;
    }

    const attachmentReference = documentId || cleanText(values.attachmentReference, 200);
    const updated = await d1.prepare(`UPDATE fdp_contractor_closings SET invoice_number = ?, invoice_received_amount = ?, invoice_issue_date = ?,
        invoice_attachment_reference = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ? AND status NOT IN ('closed', 'paid')`)
      .bind(invoiceNumber, receivedAmount, issueDate, attachmentReference, workspace.id, id).run();
    if (!updated.meta.changes) {
      if (documentStored) await d1.prepare("DELETE FROM fdp_contractor_documents WHERE workspace_id = ? AND id = ?").bind(workspace.id, documentId).run();
      if (uploadedObjectKey) await getAttachmentsBucket().delete(uploadedObjectKey).catch(() => undefined);
      uploadedObjectKey = "";
      throw new ApiError(409, "PAYMENT_CLOSING_CONFLICT", "O fechamento mudou de estado. Recarregue e tente novamente.");
    }

    const { reconciliation, invoiceStatus } = await refreshContractorReconciliation(d1, workspace.id, id);
    await prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_invoice.registered",
      entityType: "contractor_closing",
      entityId: id,
      before: { invoiceReceivedAmount: Number(closing.invoice_received_amount), invoiceStatus: closing.invoice_status },
      after: { invoiceNumber, receivedAmount, invoiceStatus, documentId: documentId || null },
      metadata: {
        expectedAmount: Number(closing.invoice_expected_amount), reconciliationStatus: reconciliation.status,
        difference: reconciliation.difference, filename: file instanceof File && file.size > 0 ? file.name.slice(0, 220) : null,
      },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      invoice: { number: invoiceNumber, expectedAmount: Number(closing.invoice_expected_amount), receivedAmount, status: invoiceStatus },
      document: documentId ? { id: documentId, filename: file instanceof File ? file.name.slice(0, 220) : "" } : null,
      reconciliation,
    });
  } catch (error) {
    if (uploadedObjectKey && !documentStored) await getAttachmentsBucket().delete(uploadedObjectKey).catch(() => undefined);
    return apiError(error);
  }
}
