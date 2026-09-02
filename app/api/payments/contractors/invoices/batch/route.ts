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

const MAX_BATCH = 200;

/**
 * A mesma decisão sobre várias notas.
 *
 * O ganho é real — colocar quarenta notas em conferência uma a uma é quarenta
 * cliques —, e o risco também: uma ação em lote é a maneira mais eficiente de
 * aprovar sem olhar. Por isso três coisas valem aqui e não são negociáveis:
 *
 *  1. a confirmação é explícita (`confirm: true`), e não o clique do botão;
 *  2. cada nota passa pelas MESMAS regras da conferência individual — a
 *     verificação mora no serviço, e este arquivo não tem uma segunda cópia;
 *  3. cada nota gera o seu próprio evento de auditoria, nominal. Um registro
 *     dizendo "quarenta notas aprovadas" não serve para auditar nenhuma delas.
 *
 * Uma nota que falha não derruba as outras: o lote responde o que passou e o
 * que não passou, com o motivo de cada recusa. Interromper no primeiro erro
 * deixaria metade do trabalho feito sem dizer qual metade.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);

    const action = requiredPaymentEnum(body.action, invoiceReviewActions, "Ação da conferência");
    requireCapability(workspace, invoiceReviewCapability[action]);

    const ids = [...new Set((Array.isArray(body.invoiceIds) ? body.invoiceIds : [])
      .map((value) => cleanText(value, 120))
      .filter(Boolean))];
    if (ids.length === 0) throw ApiError.badRequest("Selecione ao menos uma nota fiscal.", "INVOICE_SELECTION_REQUIRED");
    if (ids.length > MAX_BATCH) {
      throw ApiError.badRequest(`Selecione no máximo ${MAX_BATCH} notas por vez.`, "INVOICE_BATCH_TOO_LARGE");
    }
    if (body.confirm !== true) {
      throw ApiError.badRequest(
        "Confirme a ação em lote antes de aplicá-la às notas selecionadas.",
        "INVOICE_BATCH_CONFIRMATION_REQUIRED",
      );
    }

    const rejection = action === "reject" || action === "request_correction"
      ? validateRejection(body.reason, body.reasonDetail)
      : { reason: "", detail: "" };
    const reviewNote = cleanText(body.note, 500);
    const policy = await loadInvoicePolicy(d1, workspace.id);

    const applied: { id: string; status: string; invoiceNumber: string }[] = [];
    const failed: { id: string; code: string; message: string }[] = [];

    for (const id of ids) {
      try {
        const invoice = await findInvoice(d1, workspace.id, id);
        await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, invoice.company_id);
        const closing = await d1.prepare(`SELECT id, status, invoice_expected_amount FROM fdp_contractor_closings
          WHERE workspace_id = ? AND id = ? AND excluded_at IS NULL`)
          .bind(workspace.id, invoice.closing_id)
          .first<{ id: string; status: string; invoice_expected_amount: string | number }>();
        if (!closing) throw ApiError.notFound("Pagamento não encontrado.", "CONTRACTOR_CLOSING_NOT_FOUND");

        const result = await reviewInvoice(d1, {
          workspaceId: workspace.id,
          invoice,
          closing,
          action,
          checklist: sanitizeChecklist(parseJson(invoice.checklist_json)),
          requiredChecks: policy.requiredChecks,
          reviewNote,
          rejection,
          actorUserId: user.id,
          actorName: user.name || auth.user.email,
        });
        await refreshContractorReconciliation(d1, workspace.id, invoice.closing_id);

        // Auditoria por nota, não por lote: é a nota que precisa poder ser
        // auditada meses depois, não o clique.
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
          },
          metadata: {
            competence: invoice.competence, closingId: invoice.closing_id, providerId: invoice.provider_id,
            invoiceNumber: invoice.invoice_number, batch: true, batchSize: ids.length,
          },
          requestId: request.headers.get("x-fila-dp-request-id"),
        }).run();

        applied.push({ id, status: result.status, invoiceNumber: invoice.invoice_number });
      } catch (cause) {
        failed.push({
          id,
          code: cause instanceof ApiError ? cause.code : "INVOICE_BATCH_FAILED",
          message: cause instanceof Error ? cause.message : "Não foi possível aplicar a ação nesta nota.",
        });
      }
    }

    return Response.json({ action, applied, failed, appliedCount: applied.length, failedCount: failed.length });
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
