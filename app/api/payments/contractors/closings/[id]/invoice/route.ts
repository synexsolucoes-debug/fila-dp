import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { positiveMoney } from "@/lib/payments";
import { findContractorClosing, refreshContractorReconciliation } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };

/**
 * Registro da nota fiscal recebida do prestador.
 *
 * O Fila DP não emite nota e nunca ajusta o cálculo por causa dela: informa o
 * valor esperado, guarda o valor recebido e transforma a diferença em divergência.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "contractors.payments.manage");

    const closing = await findContractorClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);
    if (closing.status === "closed" || closing.status === "paid") {
      throw ApiError.badRequest("O fechamento está concluído. Reabra com justificativa para alterar a nota.", "PAYMENT_CLOSING_LOCKED");
    }

    const invoiceNumber = cleanText(body.invoiceNumber, 80);
    if (!invoiceNumber) throw ApiError.badRequest("Informe o número da nota fiscal.", "INVOICE_NUMBER_REQUIRED");
    const receivedAmount = positiveMoney(body.receivedAmount, "Valor da nota recebida");

    await d1.prepare(`UPDATE fdp_contractor_closings SET invoice_number = ?, invoice_received_amount = ?, invoice_issue_date = ?,
        invoice_attachment_reference = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ? AND status NOT IN ('closed', 'paid')`)
      .bind(invoiceNumber, receivedAmount, optionalDate(body.issueDate), cleanText(body.attachmentReference, 200), workspace.id, id).run();

    const { reconciliation, invoiceStatus } = await refreshContractorReconciliation(d1, workspace.id, id);

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "contractor_invoice.registered", entityType: "contractor_closing", entityId: id,
      before: { invoiceReceivedAmount: Number(closing.invoice_received_amount), invoiceStatus: closing.invoice_status },
      after: { invoiceNumber, receivedAmount, invoiceStatus },
      metadata: {
        expectedAmount: Number(closing.invoice_expected_amount),
        reconciliationStatus: reconciliation.status, difference: reconciliation.difference,
      },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      invoice: { number: invoiceNumber, expectedAmount: Number(closing.invoice_expected_amount), receivedAmount, status: invoiceStatus },
      reconciliation,
    });
  } catch (error) {
    return apiError(error);
  }
}
