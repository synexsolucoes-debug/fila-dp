import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { cajuStatuses, positiveMoney, requiredPaymentEnum } from "@/lib/payments";
import { findContractorClosing, refreshContractorReconciliation } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };

/**
 * Controle administrativo do valor complementar (hoje operado como Caju Saldo Livre).
 *
 * Não existe integração oficial implementada com a plataforma: este endpoint
 * registra lote, identificador externo, status e erro informados pela operação,
 * e alimenta a exportação assistida. Enquanto não houver API oficial contratada
 * e testada, o conector permanece não configurado.
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
      throw ApiError.badRequest("O fechamento está concluído. Reabra com justificativa para alterar o complemento.", "PAYMENT_CLOSING_LOCKED");
    }
    if (Number(closing.caju_amount) <= 0 && closing.complement_method !== "caju_saldo_livre") {
      throw ApiError.badRequest("Esta competência não possui valor complementar destinado ao cartão de benefício.", "CAJU_NOT_APPLICABLE");
    }

    const status = requiredPaymentEnum(body.status, cajuStatuses, "Status do complemento");
    const paidAmount = Object.hasOwn(body, "paidAmount")
      ? positiveMoney(body.paidAmount, "Valor complementar pago")
      : (status === "processed" ? Number(closing.caju_amount) : Number(closing.complement_paid_amount));
    if (status === "error" && !cleanText(body.error, 300)) {
      throw ApiError.badRequest("Descreva o erro retornado pela plataforma.", "CAJU_ERROR_REQUIRED");
    }

    await d1.prepare(`UPDATE fdp_contractor_closings SET caju_status = ?, caju_batch_reference = ?, caju_external_id = ?, caju_error = ?,
        complement_paid_amount = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ? AND status NOT IN ('closed', 'paid')`)
      .bind(status, cleanText(body.batchReference, 120), cleanText(body.externalId, 160), cleanText(body.error, 300),
        paidAmount, workspace.id, id).run();

    const { reconciliation } = await refreshContractorReconciliation(d1, workspace.id, id);

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "contractor_complement.updated", entityType: "contractor_closing", entityId: id,
      before: { cajuStatus: closing.caju_status, complementPaidAmount: Number(closing.complement_paid_amount) },
      after: { cajuStatus: status, complementPaidAmount: paidAmount },
      metadata: { expectedAmount: Number(closing.caju_amount), reconciliationStatus: reconciliation.status, difference: reconciliation.difference },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      complement: { status, expectedAmount: Number(closing.caju_amount), paidAmount, method: closing.complement_method },
      reconciliation,
      integration: { connected: false, note: "Controle assistido: não há integração oficial implementada com a plataforma de benefício." },
    });
  } catch (error) {
    return apiError(error);
  }
}
