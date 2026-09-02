import { getAttachmentsBucket } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";
import { findContractorClosing, refreshContractorReconciliation } from "@/lib/payment-service";
import {
  checkInvoiceFile,
  documentDigits,
  invoiceAmountFromInput,
  isConfirmed,
  sanitizeInvoiceFilename,
  summarizeInvoiceCompetence,
} from "@/lib/contractor-invoices";
import {
  assertNotDuplicated,
  listInvoicePanel,
  loadInvoicePolicy,
  registerInvoice,
} from "@/lib/contractor-invoice-service";

/**
 * Notas fiscais da competência PJ.
 *
 * O GET responde a pergunta que traz alguém a esta tela no dia 3 do mês: quem
 * precisa emitir nota, quem já mandou, e quem está travando o pagamento. A
 * lista não vem de um cadastro próprio — ela nasce dos fechamentos da
 * competência, porque quem precisa emitir é exatamente quem tem valor de nota
 * apurado.
 *
 * O POST registra um envio. Ele nunca sobrescreve o anterior: cada nota é uma
 * linha, e a que estava valendo é marcada como substituída.
 */

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * O plano cobre este arquivo?
 *
 * A conta e a mensagem são as mesmas do anexo de nota que já existia — a
 * gravação continua acontecendo numa instrução só, com trava de aviso, para
 * que dois envios simultâneos não estourem o limite juntos.
 */
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

/** O formulário chega como multipart quando traz arquivo e como JSON quando não traz. */
async function requestValues(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    const body = await request.json() as Record<string, unknown>;
    return { ...body, file: null as File | null };
  }
  const form = await request.formData();
  const file = form.get("invoiceFile");
  return {
    closingId: form.get("closingId"),
    invoiceNumber: form.get("invoiceNumber"),
    series: form.get("series"),
    issueDate: form.get("issueDate"),
    issuerDocument: form.get("issuerDocument"),
    issuerName: form.get("issuerName"),
    receiverDocument: form.get("receiverDocument"),
    serviceDescription: form.get("serviceDescription"),
    amount: form.get("amount"),
    notes: form.get("notes"),
    replacesInvoiceId: form.get("replacesInvoiceId"),
    confirmDuplicate: form.get("confirmDuplicate"),
    file: file instanceof File ? file : null,
  };
}

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.read");

    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const requested = url.searchParams.get("competence") ? validCompetence(url.searchParams.get("competence")) : "";
    const cycles = await d1.prepare(`SELECT id, competence, status, payment_date, closed_at FROM fdp_payroll_cycles
      WHERE workspace_id = ? AND company_id = ? ORDER BY competence DESC LIMIT 36`)
      .bind(workspace.id, companyId)
      .all<Record<string, unknown>>();
    const competence = requested || String(cycles.results[0]?.competence ?? new Date().toISOString().slice(0, 7));
    const cycle = cycles.results.find((item) => item.competence === competence) ?? null;

    const policy = await loadInvoicePolicy(d1, workspace.id);
    const rows = cycle
      ? await listInvoicePanel(d1, {
        workspaceId: workspace.id, companyId, cycleId: String(cycle.id), policy,
      })
      : [];

    // Os responsáveis pela conferência da competência saem das próprias linhas:
    // não há uma lista de "conferentes" para manter, e uma lista de todos os
    // membros do grupo transformaria o filtro num catálogo de gente que nunca
    // conferiu nada.
    const reviewers = [...new Map(rows
      .filter((row) => row.reviewedByUserId)
      .map((row) => [row.reviewedByUserId, { id: row.reviewedByUserId, name: row.reviewedByName }]))
      .values()];

    return Response.json({
      competence,
      cycle,
      cycles: cycles.results,
      rows,
      reviewers,
      summary: summarizeInvoiceCompetence(rows, policy.reviewPolicy),
      policy,
      permissions: {
        read: true,
        create: hasCapability(workspace, "invoice.create"),
        upload: hasCapability(workspace, "invoice.upload"),
        update: hasCapability(workspace, "invoice.update"),
        review: hasCapability(workspace, "invoice.review"),
        approve: hasCapability(workspace, "invoice.approve"),
        reject: hasCapability(workspace, "invoice.reject"),
        replace: hasCapability(workspace, "invoice.replace"),
        export: hasCapability(workspace, "invoice.export"),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

/** Registra a nota do prestador na competência e guarda o arquivo enviado. */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  let uploadedObjectKey = "";
  let documentStored = false;
  let invoiceStored = false;
  let documentId = "";
  /* Desfazer a gravação do documento exige a conexão com o tenant, que só
     existe dentro do `try`. A função é guardada aqui para que o `catch`
     consiga chamá-la sem reabrir contexto. */
  let discardDocument: (() => Promise<void>) | null = null;
  try {
    const values = await requestValues(request);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.create");

    const closingId = cleanText(values.closingId, 120);
    if (!closingId) throw ApiError.badRequest("Informe o pagamento da nota fiscal.", "CLOSING_REQUIRED");
    const closing = await findContractorClosing(d1, workspace.id, closingId);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);

    if (closing.status === "closed" || closing.status === "paid") {
      throw ApiError.badRequest(
        "O pagamento está concluído. Reabra com justificativa para alterar a nota fiscal.",
        "PAYMENT_CLOSING_LOCKED",
      );
    }
    if (Number(closing.invoice_expected_amount) <= 0) {
      throw ApiError.badRequest(
        "Este prestador não tem valor de nota fiscal nesta competência.",
        "INVOICE_NOT_REQUIRED",
      );
    }

    const invoiceNumber = cleanText(values.invoiceNumber, 80);
    if (!invoiceNumber) throw ApiError.badRequest("Informe o número da nota fiscal.", "INVOICE_NUMBER_REQUIRED");
    const series = cleanText(values.series, 20);
    const issueDate = optionalDate(values.issueDate, true);
    if (!issueDate) throw ApiError.badRequest("Informe a data de emissão da nota.", "INVOICE_ISSUE_DATE_REQUIRED");
    const amount = invoiceAmountFromInput(values.amount);
    const issuerDocument = documentDigits(values.issuerDocument);
    const issuerName = cleanText(values.issuerName, 200);
    const receiverDocument = documentDigits(values.receiverDocument);
    const serviceDescription = cleanText(values.serviceDescription, 400);
    const notes = cleanText(values.notes, 500);
    const replacesInvoiceId = cleanText(values.replacesInvoiceId, 120) || null;

    // Substituir uma nota já aprovada é a ação que reescreve um documento que
    // já liberou pagamento: ela tem permissão própria (§30).
    if (replacesInvoiceId) {
      const previous = await d1.prepare("SELECT status FROM fdp_contractor_invoices WHERE workspace_id = ? AND id = ?")
        .bind(workspace.id, replacesInvoiceId)
        .first<{ status: string }>();
      if (previous?.status === "approved") requireCapability(workspace, "invoice.replace");
    }

    const duplicate = await assertNotDuplicated(d1, {
      workspaceId: workspace.id,
      closingId,
      providerId: closing.provider_id,
      invoiceNumber,
      series,
      issuerDocument,
      acknowledged: isConfirmed(values.confirmDuplicate),
      canAcknowledge: hasCapability(workspace, "invoice.review"),
    });

    const file = values.file;
    if (file) {
      requireCapability(workspace, "invoice.upload");
      const { contentType } = checkInvoiceFile({ name: file.name, type: file.type, size: file.size });
      const filename = sanitizeInvoiceFilename(file.name);

      documentId = crypto.randomUUID();
      // A chave carrega workspace, prestador e competência: um documento sem
      // vínculo com os três não pode existir no armazenamento (§14, §22).
      uploadedObjectKey = `workspaces/${workspace.id}/contractors/${closing.provider_id}/invoices/${closing.competence}/${documentId}`;
      const bucket = getAttachmentsBucket();
      await bucket.put(uploadedObjectKey, file.stream(), {
        // `attachment` na origem: o visualizador interno pede `inline`
        // explicitamente na rota de leitura, e o padrão seguro é não deixar o
        // navegador renderizar um arquivo enviado por terceiro.
        httpMetadata: { contentType, contentDisposition: "attachment" },
        customMetadata: {
          documentId, providerId: closing.provider_id, closingId,
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
        .bind(workspace.id, workspace.id, documentId, workspace.id, closing.company_id, closing.provider_id,
          closingId, closing.competence, invoiceNumber, uploadedObjectKey, filename, contentType, file.size, user.id,
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
      invoiceNumber, series, issueDate, issuerDocument, issuerName, receiverDocument,
      serviceDescription, amount, notes,
      documentId: documentStored ? documentId : null,
      duplicateAck: Boolean(duplicate),
      replacesInvoiceId,
      actorUserId: user.id,
      actorName: user.name || auth.user.email,
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
      userAgent: request.headers.get("user-agent") ?? "",
    });
    invoiceStored = true;

    // A conciliação continua sendo do fechamento: nota recebida mais
    // complemento pago precisam fechar o líquido devido.
    const { reconciliation, invoiceStatus } = await refreshContractorReconciliation(d1, workspace.id, closingId);

    await prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_invoice.registered",
      entityType: "contractor_invoice",
      entityId: registered.invoiceId,
      before: { previousInvoiceId: registered.replacedInvoiceId },
      after: {
        closingId, invoiceNumber, series, issueDate,
        amount: registered.comparison.informedAmount,
        expectedAmount: registered.comparison.expectedAmount,
        difference: registered.comparison.difference,
        documentId: documentStored ? documentId : null,
        attempt: registered.attempt,
      },
      metadata: {
        competence: closing.competence, providerId: closing.provider_id, companyId: closing.company_id,
        reconciliationStatus: reconciliation.status, invoiceStatus,
        duplicateAcknowledged: Boolean(duplicate),
        filename: values.file ? sanitizeInvoiceFilename(values.file.name) : null,
      },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      invoice: {
        id: registered.invoiceId,
        closingId,
        attempt: registered.attempt,
        invoiceNumber,
        amount: registered.comparison.informedAmount,
        expectedAmount: registered.comparison.expectedAmount,
        difference: registered.comparison.difference,
        matches: registered.comparison.matches,
        status: "received",
        documentId: documentStored ? documentId : "",
      },
      replacedInvoiceId: registered.replacedInvoiceId,
      duplicate,
      reconciliation,
    }, { status: 201 });
  } catch (error) {
    // Arquivo guardado sem a nota que o explica vira lixo invisível: ninguém o
    // encontra depois para apagar, e ele conta contra a cota do plano. O
    // desfazimento cobre os dois estados possíveis — objeto sem linha, e linha
    // sem nota.
    if (uploadedObjectKey && !invoiceStored) {
      if (documentStored && discardDocument) await discardDocument();
      await getAttachmentsBucket().delete(uploadedObjectKey).catch(() => undefined);
    }
    return apiError(error);
  }
}
