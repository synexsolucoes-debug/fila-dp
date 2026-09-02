import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { requiredPaymentEnum } from "@/lib/payments";
import { refreshContractorReconciliation } from "@/lib/payment-service";
import { sanitizeChecklist, validateRejection } from "@/lib/contractor-invoices";
import {
  findInvoice,
  invoiceReviewActions,
  invoiceReviewCapability,
  loadInvoicePolicy,
  reviewInvoice,
} from "@/lib/contractor-invoice-service";

type Params = { params: Promise<{ id: string }> };

/**
 * A conferência de uma nota.
 *
 * Quatro decisões numa rota — colocar em conferência, aprovar, rejeitar e
 * solicitar correção — porque compartilham a mesma nota, o mesmo checklist, o
 * mesmo histórico e a mesma sincronização com o pagamento. As regras em si
 * moram no serviço, ao lado da ação em lote: aprovar em lote o que não se
 * aprovaria uma a uma é exatamente o risco que a ação em lote cria, e uma
 * segunda cópia da regra seria a forma mais fácil de criá-lo.
 *
 * O que **não** acontece: aprovação automática. Valor idêntico ao esperado é
 * informação para quem confere, nunca substituto da conferência (§8).
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);

    const action = requiredPaymentEnum(body.action, invoiceReviewActions, "Ação da conferência");
    requireCapability(workspace, invoiceReviewCapability[action]);

    const invoice = await findInvoice(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, invoice.company_id);

    const closing = await d1.prepare(`SELECT id, status, invoice_expected_amount FROM fdp_contractor_closings
      WHERE workspace_id = ? AND id = ? AND excluded_at IS NULL`)
      .bind(workspace.id, invoice.closing_id)
      .first<{ id: string; status: string; invoice_expected_amount: string | number }>();
    if (!closing) throw ApiError.notFound("Pagamento não encontrado.", "CONTRACTOR_CLOSING_NOT_FOUND");

    const policy = await loadInvoicePolicy(d1, workspace.id);
    // O checklist enviado substitui o guardado: ele é a fotografia da
    // conferência que está sendo feita, não um acumulado de tentativas.
    const checklist = body.checklist === undefined
      ? sanitizeChecklist(parseJson(invoice.checklist_json))
      : sanitizeChecklist(body.checklist);
    const rejection = action === "reject" || action === "request_correction"
      ? validateRejection(body.reason, body.reasonDetail)
      : { reason: "", detail: "" };

    const result = await reviewInvoice(d1, {
      workspaceId: workspace.id,
      invoice,
      closing,
      action,
      checklist,
      requiredChecks: policy.requiredChecks,
      reviewNote: cleanText(body.note, 500),
      rejection,
      actorUserId: user.id,
      actorName: user.name || auth.user.email,
    });

    const { reconciliation } = await refreshContractorReconciliation(d1, workspace.id, invoice.closing_id);

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `contractor_invoice.${result.status}`, entityType: "contractor_invoice", entityId: id,
      before: { status: invoice.status },
      after: {
        status: result.status,
        amount: result.comparison.informedAmount,
        expectedAmount: result.comparison.expectedAmount,
        difference: result.comparison.difference,
        rejectionReason: rejection.reason || null,
        rejectionDetail: rejection.detail || null,
      },
      metadata: {
        competence: invoice.competence, closingId: invoice.closing_id, providerId: invoice.provider_id,
        invoiceNumber: invoice.invoice_number, checklist, batch: false,
        reconciliationStatus: reconciliation.status,
      },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      invoice: { id, status: result.status },
      comparison: result.comparison,
      summary: result.summary,
      reconciliation,
    });
  } catch (error) {
    return apiError(error);
  }
}

/** `jsonb` volta como objeto no driver local e como texto em alguns caminhos. */
function parseJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
