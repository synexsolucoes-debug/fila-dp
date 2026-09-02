import { getAttachmentsBucket } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { findContractorClosing, refreshContractorReconciliation } from "@/lib/payment-service";
import {
  checkInvoiceFile,
  documentDigits,
  invoiceAmountFromInput,
  isConfirmed,
  sanitizeInvoiceFilename,
} from "@/lib/contractor-invoices";
import { assertNotDuplicated, registerInvoice } from "@/lib/contractor-invoice-service";

type Params = { params: Promise<{ id: string }> };

/**
 * Registra a nota fiscal a partir da tela de Pagamentos.
 *
 * A ação "Nota" da tabela de apuração continua aqui, porque é ali que ela é
 * usada — mas o que ela faz mudou: em vez de escrever direto nas colunas do
 * fechamento, ela cria um registro de nota pelo mesmo caminho da aba de Notas
 * Fiscais. As colunas do fechamento passaram a ser o reflexo da nota vigente, e
 * dois caminhos escrevendo as mesmas colunas por regras diferentes é como as
 * duas telas acabariam mostrando números distintos para o mesmo prestador.
 *
 * O envio anterior não é sobrescrito: ele vira versão substituída, com o
 * histórico completo (§15, §30).
 */

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
    const file = form.get("invoiceFile");
    return {
      invoiceNumber: form.get("invoiceNumber"),
      receivedAmount: form.get("receivedAmount"),
      issueDate: form.get("issueDate"),
      series: form.get("series"),
      issuerDocument: form.get("issuerDocument"),
      confirmDuplicate: form.get("confirmDuplicate"),
      file: file instanceof File ? file : null,
    };
  }
  const body = await request.json() as Record<string, unknown>;
  return { ...body, file: null as File | null };
}

export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  let uploadedObjectKey = "";
  let documentStored = false;
  let invoiceStored = false;
  let documentId = "";
  let discardDocument: (() => Promise<void>) | null = null;
  try {
    const { id } = await params;
    const values = await requestValues(request);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");
    requireCapability(workspace, "invoice.create");

    const closing = await findContractorClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);
    if (closing.status === "closed" || closing.status === "paid") {
      throw ApiError.badRequest("O fechamento está concluído. Reabra com justificativa para alterar a nota.", "PAYMENT_CLOSING_LOCKED");
    }
    if (Number(closing.invoice_expected_amount) <= 0) {
      throw ApiError.badRequest("Este prestador não tem valor de nota fiscal nesta competência.", "INVOICE_NOT_REQUIRED");
    }

    const invoiceNumber = cleanText(values.invoiceNumber, 80);
    if (!invoiceNumber) throw ApiError.badRequest("Informe o número da nota fiscal.", "INVOICE_NUMBER_REQUIRED");
    const amount = invoiceAmountFromInput(values.receivedAmount);
    const issueDate = optionalDate(values.issueDate, true);
    if (!issueDate) throw ApiError.badRequest("Informe a data de emissão da nota.", "INVOICE_ISSUE_DATE_REQUIRED");
    const series = cleanText(values.series, 20);
    const issuerDocument = documentDigits(values.issuerDocument);

    // Substituir uma nota já aprovada tem permissão própria: é a ação que
    // reescreve um documento que já liberou pagamento (§30).
    if (closing.invoice_current_id) {
      const previous = await d1.prepare("SELECT status FROM fdp_contractor_invoices WHERE workspace_id = ? AND id = ?")
        .bind(workspace.id, closing.invoice_current_id)
        .first<{ status: string }>();
      if (previous?.status === "approved") requireCapability(workspace, "invoice.replace");
    }

    const duplicate = await assertNotDuplicated(d1, {
      workspaceId: workspace.id,
      closingId: id,
      providerId: closing.provider_id,
      invoiceNumber,
      series,
      issuerDocument,
      acknowledged: isConfirmed(values.confirmDuplicate),
      canAcknowledge: hasCapability(workspace, "invoice.review"),
    });

    const file = values.file;
    if (file && file.size > 0) {
      requireCapability(workspace, "invoice.upload");
      const { contentType } = checkInvoiceFile({ name: file.name, type: file.type, size: file.size });
      const filename = sanitizeInvoiceFilename(file.name);

      documentId = crypto.randomUUID();
      uploadedObjectKey = `workspaces/${workspace.id}/contractors/${closing.provider_id}/invoices/${closing.competence}/${documentId}`;
      const bucket = getAttachmentsBucket();
      await bucket.put(uploadedObjectKey, file.stream(), {
        httpMetadata: { contentType, contentDisposition: "attachment" },
        customMetadata: {
          documentId, providerId: closing.provider_id, closingId: id,
          workspaceId: workspace.id, competence: closing.competence,
        },
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
          closing.competence, invoiceNumber, uploadedObjectKey, filename, contentType, file.size, user.id,
          workspace.id, workspace.id, workspace.id, file.size)
        .first<{ id: string }>();
      if (!stored) {
        await bucket.delete(uploadedObjectKey).catch(() => undefined);
        uploadedObjectKey = "";
        throw await storageQuotaError(d1, workspace.id, file.size);
      }
      documentStored = true;
      discardDocument = async () => {
        await d1.prepare("DELETE FROM fdp_contractor_documents WHERE workspace_id = ? AND id = ?")
          .bind(workspace.id, documentId).run().catch(() => undefined);
      };
    }

    const registered = await registerInvoice(d1, {
      workspaceId: workspace.id,
      closing: {
        id: closing.id, company_id: closing.company_id, provider_id: closing.provider_id,
        payroll_cycle_id: closing.payroll_cycle_id, competence: closing.competence,
        invoice_expected_amount: closing.invoice_expected_amount,
      },
      invoiceNumber, series, issueDate, issuerDocument,
      issuerName: "", receiverDocument: "", serviceDescription: "",
      amount, notes: "",
      documentId: documentStored ? documentId : null,
      duplicateAck: Boolean(duplicate),
      replacesInvoiceId: closing.invoice_current_id,
      actorUserId: user.id,
      actorName: user.name || auth.user.email,
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
      userAgent: request.headers.get("user-agent") ?? "",
    });
    invoiceStored = true;

    const { reconciliation, invoiceStatus } = await refreshContractorReconciliation(d1, workspace.id, id);
    await prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_invoice.registered",
      entityType: "contractor_invoice",
      entityId: registered.invoiceId,
      before: { invoiceReceivedAmount: Number(closing.invoice_received_amount), invoiceStatus: closing.invoice_status },
      after: {
        closingId: id, invoiceNumber, amount: registered.comparison.informedAmount,
        expectedAmount: registered.comparison.expectedAmount, difference: registered.comparison.difference,
        invoiceStatus, documentId: documentStored ? documentId : null, attempt: registered.attempt,
      },
      metadata: {
        competence: closing.competence, providerId: closing.provider_id,
        reconciliationStatus: reconciliation.status, difference: reconciliation.difference,
        origin: "payments_table", duplicateAcknowledged: Boolean(duplicate),
        filename: file && file.size > 0 ? sanitizeInvoiceFilename(file.name) : null,
      },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      invoice: {
        id: registered.invoiceId,
        number: invoiceNumber,
        expectedAmount: registered.comparison.expectedAmount,
        receivedAmount: registered.comparison.informedAmount,
        difference: registered.comparison.difference,
        status: invoiceStatus,
        reviewStatus: "received",
      },
      document: documentStored ? { id: documentId, filename: sanitizeInvoiceFilename(file?.name) } : null,
      replacedInvoiceId: registered.replacedInvoiceId,
      duplicate,
      reconciliation,
    });
  } catch (error) {
    if (uploadedObjectKey && !invoiceStored) {
      if (documentStored && discardDocument) await discardDocument();
      await getAttachmentsBucket().delete(uploadedObjectKey).catch(() => undefined);
    }
    return apiError(error);
  }
}
