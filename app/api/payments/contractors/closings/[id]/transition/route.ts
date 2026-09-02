import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertTransition, contractorClosingStatuses, contractorTransitions, requiredPaymentEnum, requiredReason } from "@/lib/payments";
import { contractorClosingSnapshot, findContractorClosing, refreshContractorReconciliation } from "@/lib/payment-service";
import { invoicePaymentBlock } from "@/lib/contractor-invoices";
import { loadInvoicePolicy } from "@/lib/contractor-invoice-service";
import { prepareDomainEvent } from "@/lib/outbox";

type Params = { params: Promise<{ id: string }> };

/**
 * Avança o fechamento PJ. Concluir exige complemento configurado quando há
 * valor a pagar fora da nota, conciliação sem divergência e grava o snapshot
 * imutável usado como histórico da competência.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const closing = await findContractorClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);

    const target = requiredPaymentEnum(body.status, contractorClosingStatuses, "Status do fechamento");
    assertTransition(contractorTransitions, closing.status, target);
    if (target === "paid" || target === "closed") requireCapability(workspace, "contractors.payments.close");
    if (target === "reopened") requireCapability(workspace, "payments.reopen");

    if (target === "ready_to_pay" || target === "paid") {
      if (Number(closing.complement_amount) > 0 && closing.complement_method === "none") {
        throw ApiError.badRequest(
          "Configure o meio complementar do prestador antes de pagar o valor que excede o limite da nota.",
          "COMPLEMENT_METHOD_REQUIRED",
        );
      }
      /* A nota trava o pagamento — e o motivo do travamento é dito por extenso.
         A regra e a mensagem vêm do módulo de notas, e não de uma condição
         escrita aqui: a tela de Notas Fiscais, a de Pagamentos e esta rota
         precisam responder a mesma coisa, e a política de exigir aprovação é
         configuração do grupo (§10). */
      const policy = await loadInvoicePolicy(d1, workspace.id);
      const block = invoicePaymentBlock({
        expectedAmount: Number(closing.invoice_expected_amount),
        reviewStatus: String(closing.invoice_review_status ?? ""),
        policy: policy.reviewPolicy,
      });
      if (block) throw ApiError.badRequest(`${block} O pagamento não pode ser liberado.`, "INVOICE_APPROVAL_REQUIRED");
    }

    const reason = target === "reopened" ? requiredReason(body.reason, "REOPEN_REASON_REQUIRED") : "";
    if (target === "closed") {
      const { reconciliation } = await refreshContractorReconciliation(d1, workspace.id, id);
      if (reconciliation.status !== "reconciled") {
        throw ApiError.badRequest(
          `Conciliação pendente: diferença de R$ ${reconciliation.difference.toFixed(2)} entre líquido devido, nota e complemento.`,
          "RECONCILIATION_DIVERGENT",
        );
      }
    }
    const snapshot = target === "closed" ? await contractorClosingSnapshot(d1, workspace.id, id) : null;

    const updated = await d1.prepare(`UPDATE fdp_contractor_closings SET status = ?,
        approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
        approved_at = CASE WHEN ? = 'approved' THEN now() ELSE approved_at END,
        closed_by = CASE WHEN ? = 'closed' THEN ? ELSE closed_by END,
        closed_at = CASE WHEN ? = 'closed' THEN now() ELSE closed_at END,
        snapshot_json = CASE WHEN ? = 'closed' THEN ?::jsonb ELSE snapshot_json END,
        reopen_reason = CASE WHEN ? = 'reopened' THEN ? ELSE reopen_reason END
      WHERE workspace_id = ? AND id = ? AND status = ?
      RETURNING id, status`)
      .bind(target, target, user.id, target, target, user.id, target, target, JSON.stringify(snapshot ?? {}), target, reason,
        workspace.id, id, closing.status)
      .first<{ id: string; status: string }>();
    if (!updated) throw new ApiError(409, "PAYMENT_CLOSING_CONFLICT", "O fechamento mudou de estado. Recarregue e tente novamente.");

    const statements = [prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `contractor_closing.${target}`, entityType: "contractor_closing", entityId: id,
      before: { status: closing.status },
      after: {
        status: target, netAmount: Number(closing.net_amount),
        invoiceExpectedAmount: Number(closing.invoice_expected_amount), cajuAmount: Number(closing.caju_amount),
      },
      metadata: { reasonProvided: Boolean(reason), snapshotStored: Boolean(snapshot) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    })];

    // Outbox: o evento nasce na mesma transação do fato que o originou.
    if (target === "closed" || target === "reopened") {
      statements.push(prepareDomainEvent(d1, {
        workspaceId: workspace.id,
        eventType: target === "closed" ? "contractor_closing.closed" : "contractor_closing.reopened",
        entityType: "contractor_closing",
        entityId: id,
        payload: {
          competence: closing.competence, companyId: closing.company_id, providerId: closing.provider_id,
          status: target, previousStatus: closing.status,
          netAmount: Number(closing.net_amount), invoiceExpectedAmount: Number(closing.invoice_expected_amount),
          complementAmount: Number(closing.complement_amount), cajuAmount: Number(closing.caju_amount),
          invoiceStatus: closing.invoice_status, cajuStatus: closing.caju_status,
        },
        actorUserId: user.id,
        requestId: request.headers.get("x-fila-dp-request-id"),
      }));
    }
    await d1.batch(statements);

    return Response.json({ closing: updated });
  } catch (error) {
    return apiError(error);
  }
}
