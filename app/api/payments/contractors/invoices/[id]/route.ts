import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { refreshContractorReconciliation } from "@/lib/payment-service";
import {
  compareInvoiceAmount,
  documentDigits,
  invoiceAmountFromInput,
  invoiceEventSummary,
  invoicePaymentBlock,
  isTerminalInvoiceStatus,
  reviewStatusFor,
  sanitizeChecklist,
} from "@/lib/contractor-invoices";
import {
  findInvoice,
  listClosingInvoices,
  listInvoiceEvents,
  loadInvoicePolicy,
  prepareInvoiceEvent,
} from "@/lib/contractor-invoice-service";

type Params = { params: Promise<{ id: string }> };

/**
 * Uma nota fiscal, com tudo que a conferência precisa numa resposta só.
 *
 * A gaveta lateral abre com os dados do prestador, os números do pagamento, os
 * campos da nota, as versões anteriores e o histórico. Buscar isso em cinco
 * chamadas faria a janela abrir em cinco etapas — e conferir trinta notas
 * custaria cento e cinquenta idas ao servidor.
 */
export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.read");

    const invoice = await findInvoice(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, invoice.company_id);

    const [closing, versions, events, policy] = await Promise.all([
      d1.prepare(`SELECT c.id, c.status, c.competence, c.net_amount, c.base_amount, c.credits_amount, c.debits_amount,
          c.invoice_expected_amount, c.invoice_limit_amount, c.invoice_limit_source, c.complement_amount,
          c.invoice_review_status, c.invoice_status, c.invoice_current_id,
          a.legal_name AS provider_name, a.trade_name AS provider_trade_name, a.tax_id AS provider_document,
          coalesce(p.contract_reference, '') AS contract_reference, coalesce(p.role_title, '') AS role_title,
          company.legal_name AS company_legal_name, company.trade_name AS company_trade_name, company.tax_id AS company_document
        FROM fdp_contractor_closings c
        JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
        LEFT JOIN fdp_contractor_profiles p ON p.workspace_id = c.workspace_id AND p.provider_id = c.provider_id
        JOIN fdp_companies company ON company.workspace_id = c.workspace_id AND company.id = c.company_id
        WHERE c.workspace_id = ? AND c.id = ?`)
        .bind(workspace.id, invoice.closing_id)
        .first<Record<string, unknown>>(),
      listClosingInvoices(d1, workspace.id, invoice.closing_id),
      listInvoiceEvents(d1, workspace.id, invoice.closing_id),
      loadInvoicePolicy(d1, workspace.id),
    ]);
    if (!closing) throw ApiError.notFound("Pagamento não encontrado.", "CONTRACTOR_CLOSING_NOT_FOUND");

    const document = invoice.document_id
      ? await d1.prepare(`SELECT id, filename, content_type, size_bytes, created_at
          FROM fdp_contractor_documents WHERE workspace_id = ? AND id = ?`)
        .bind(workspace.id, invoice.document_id)
        .first<Record<string, unknown>>()
      : null;

    const comparison = compareInvoiceAmount(invoice.expected_amount, invoice.amount);
    const reviewStatus = reviewStatusFor({
      expectedAmount: Number(closing.invoice_expected_amount ?? 0),
      invoiceStatus: String(closing.invoice_current_id) === invoice.id ? invoice.status : null,
    });

    return Response.json({
      invoice: { ...invoice, checklist: sanitizeChecklist(parseJson(invoice.checklist_json)) },
      comparison,
      closing,
      document,
      versions,
      events,
      policy,
      isCurrent: String(closing.invoice_current_id ?? "") === invoice.id,
      paymentBlock: invoicePaymentBlock({
        expectedAmount: Number(closing.invoice_expected_amount ?? 0),
        reviewStatus,
        policy: policy.reviewPolicy,
      }),
      permissions: {
        update: hasCapability(workspace, "invoice.update"),
        review: hasCapability(workspace, "invoice.review"),
        approve: hasCapability(workspace, "invoice.approve"),
        reject: hasCapability(workspace, "invoice.reject"),
        replace: hasCapability(workspace, "invoice.replace"),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

function parseJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

/**
 * Corrige os dados informados da nota — não o documento, nem a decisão.
 *
 * Um número digitado errado não deveria exigir substituir a nota inteira e
 * perder o arquivo já anexado. O que esta rota **não** faz é mexer em nota
 * aprovada: ali a correção passa por rejeitar e substituir, que é o caminho
 * que deixa rastro (§30).
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.update");

    const invoice = await findInvoice(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, invoice.company_id);

    if (invoice.status === "approved") {
      throw ApiError.badRequest(
        "A nota já foi aprovada. Rejeite-a e envie uma substituta para corrigir os dados.",
        "INVOICE_ALREADY_APPROVED",
      );
    }
    if (invoice.superseded_at || isTerminalInvoiceStatus(invoice.status)) {
      throw ApiError.badRequest("Esta nota não é mais a vigente do pagamento.", "INVOICE_NOT_CURRENT");
    }

    const closing = await d1.prepare(`SELECT status, invoice_expected_amount FROM fdp_contractor_closings
      WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, invoice.closing_id)
      .first<{ status: string; invoice_expected_amount: string | number }>();
    if (!closing) throw ApiError.notFound("Pagamento não encontrado.", "CONTRACTOR_CLOSING_NOT_FOUND");
    if (closing.status === "closed" || closing.status === "paid") {
      throw ApiError.badRequest("O pagamento está concluído e a nota não pode ser alterada.", "PAYMENT_CLOSING_LOCKED");
    }

    const invoiceNumber = cleanText(body.invoiceNumber, 80) || invoice.invoice_number;
    const series = body.series === undefined ? invoice.series : cleanText(body.series, 20);
    const issueDate = body.issueDate === undefined ? invoice.issue_date : optionalDate(body.issueDate, true);
    const amount = body.amount === undefined ? Number(invoice.amount) : invoiceAmountFromInput(body.amount);
    const issuerDocument = body.issuerDocument === undefined ? invoice.issuer_document : documentDigits(body.issuerDocument);
    const issuerName = body.issuerName === undefined ? invoice.issuer_name : cleanText(body.issuerName, 200);
    const receiverDocument = body.receiverDocument === undefined ? invoice.receiver_document : documentDigits(body.receiverDocument);
    const serviceDescription = body.serviceDescription === undefined
      ? invoice.service_description : cleanText(body.serviceDescription, 400);
    const notes = body.notes === undefined ? invoice.notes : cleanText(body.notes, 500);
    const comparison = compareInvoiceAmount(invoice.expected_amount, amount);

    const updated = await d1.prepare(`UPDATE fdp_contractor_invoices SET invoice_number = ?, series = ?, issue_date = ?,
        issuer_document = ?, issuer_name = ?, receiver_document = ?, service_description = ?,
        amount = ?, difference_amount = ?, notes = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ? AND superseded_at IS NULL AND status <> 'approved'
      RETURNING id`)
      .bind(invoiceNumber, series, issueDate, issuerDocument, issuerName, receiverDocument, serviceDescription,
        comparison.informedAmount, comparison.difference, notes, workspace.id, id)
      .first<{ id: string }>();
    if (!updated) throw new ApiError(409, "INVOICE_CONFLICT", "A nota mudou de estado. Recarregue e tente novamente.");

    const before = {
      invoiceNumber: invoice.invoice_number, series: invoice.series, issueDate: invoice.issue_date,
      amount: Number(invoice.amount), issuerDocument: invoice.issuer_document,
    };
    const after = { invoiceNumber, series, issueDate, amount: comparison.informedAmount, issuerDocument };

    await d1.batch([
      d1.prepare(`UPDATE fdp_contractor_closings SET invoice_number = ?, invoice_received_amount = ?,
          invoice_issue_date = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND invoice_current_id = ?`)
        .bind(invoiceNumber, comparison.informedAmount, issueDate, workspace.id, invoice.closing_id, id),
      prepareInvoiceEvent(d1, {
        workspaceId: workspace.id, invoiceId: id, closingId: invoice.closing_id,
        providerId: invoice.provider_id, competence: invoice.competence,
        action: "updated", actorUserId: user.id,
        summary: invoiceEventSummary({
          action: "updated", actorName: user.name || auth.user.email, invoiceNumber,
        }),
        before, after,
      }),
    ]);

    const { reconciliation } = await refreshContractorReconciliation(d1, workspace.id, invoice.closing_id);
    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "contractor_invoice.updated", entityType: "contractor_invoice", entityId: id,
      before, after,
      metadata: { competence: invoice.competence, closingId: invoice.closing_id, difference: comparison.difference },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ invoice: { id, ...after, difference: comparison.difference }, comparison, reconciliation });
  } catch (error) {
    return apiError(error);
  }
}
