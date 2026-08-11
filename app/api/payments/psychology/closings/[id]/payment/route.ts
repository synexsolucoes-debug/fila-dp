import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText, optionalDate } from "@/lib/registrations";
import {
  invoiceComparison,
  paymentEnum,
  positiveMoney,
  psychologyPaymentMethods,
  psychologyPaymentStatuses,
} from "@/lib/payments";
import { findPsychologyClosing } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };

/**
 * Registro do pagamento ao psicólogo e, quando aplicável, da nota fiscal.
 * O Vinculato não emite nota: ele compara o valor apurado com o valor informado
 * e expõe a divergência.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "psychology.payments.manage");

    const closing = await findPsychologyClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);

    const amount = positiveMoney(body.amount ?? closing.net_amount, "Valor do pagamento");
    const method = paymentEnum(body.method, psychologyPaymentMethods, "pix");
    const status = paymentEnum(body.status, psychologyPaymentStatuses, "pending");
    const invoiceNumber = cleanText(body.invoiceNumber, 80);
    const invoiceAmount = positiveMoney(body.invoiceAmount ?? 0, "Valor da nota");
    const requiresInvoice = Boolean(body.requiresInvoice) || Boolean(invoiceNumber) || invoiceAmount > 0;
    const invoiceStatus = requiresInvoice
      ? invoiceComparison(Number(closing.net_amount), invoiceAmount, Boolean(invoiceNumber) || invoiceAmount > 0)
      : "not_required";
    const paymentId = crypto.randomUUID();

    const saved = await d1.prepare(`INSERT INTO fdp_psychology_payments (id, workspace_id, closing_id, amount, method, status, scheduled_date, paid_date,
        invoice_number, invoice_amount, invoice_issue_date, invoice_status, receipt_reference, responsible_user_id, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, closing_id) DO UPDATE SET amount = EXCLUDED.amount, method = EXCLUDED.method, status = EXCLUDED.status,
        scheduled_date = EXCLUDED.scheduled_date, paid_date = EXCLUDED.paid_date, invoice_number = EXCLUDED.invoice_number,
        invoice_amount = EXCLUDED.invoice_amount, invoice_issue_date = EXCLUDED.invoice_issue_date, invoice_status = EXCLUDED.invoice_status,
        receipt_reference = EXCLUDED.receipt_reference, responsible_user_id = EXCLUDED.responsible_user_id, note = EXCLUDED.note, updated_at = now()
      RETURNING id, amount, method, status, invoice_status`)
      .bind(paymentId, workspace.id, id, amount, method, status, optionalDate(body.scheduledDate), optionalDate(body.paidDate),
        invoiceNumber, invoiceAmount, optionalDate(body.invoiceIssueDate), invoiceStatus, cleanText(body.receiptReference, 200),
        cleanText(body.responsibleUserId, 120) || user.id, cleanText(body.note, 300), user.id)
      .first<Record<string, unknown>>();

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "psychology_payment.registered", entityType: "psychology_closing", entityId: id,
      after: { amount, method, status, invoiceStatus },
      metadata: { netAmount: Number(closing.net_amount), invoiceProvided: Boolean(invoiceNumber) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ payment: saved, divergence: invoiceStatus === "divergent" });
  } catch (error) {
    return apiError(error);
  }
}
