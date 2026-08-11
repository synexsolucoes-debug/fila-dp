import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { assertNoClinicalData } from "@/lib/auxiliary";
import {
  calculatePsychologyClosing,
  positiveMoney,
  psychologyAdjustmentKinds,
  requiredPaymentEnum,
  requiredReason,
} from "@/lib/payments";
import { computePsychologyClosing, findPsychologyClosing, requireCycle } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };

/**
 * Ajuste administrativo do fechamento (inclusão, cancelamento, correção,
 * desconto ou complemento). Registro append-only com motivo, autor,
 * valor anterior e valor novo.
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
    if (closing.status === "closed" || closing.status === "paid") {
      throw ApiError.badRequest("O fechamento está concluído. Reabra com justificativa para ajustar.", "PAYMENT_CLOSING_LOCKED");
    }

    const kind = requiredPaymentEnum(body.kind, psychologyAdjustmentKinds, "Tipo de ajuste");
    const amount = positiveMoney(body.amount, "Valor do ajuste");
    const reason = requiredReason(body.reason, "ADJUSTMENT_REASON_REQUIRED");
    assertNoClinicalData("psychology", reason);

    const cycle = await requireCycle(d1, workspace.id, closing.company_id, closing.payroll_cycle_id);
    const previous = await computePsychologyClosing(d1, workspace.id, closing.provider_id, cycle, id);
    const projected = calculatePsychologyClosing({
      sessions: [],
      adjustments: [{ kind, amount }],
    });
    const nextNet = Math.max(previous.netAmount + projected.adjustmentsAmount, 0);
    const adjustmentId = crypto.randomUUID();

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_psychology_adjustments (id, workspace_id, closing_id, kind, amount, reason, previous_amount, new_amount, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(adjustmentId, workspace.id, id, kind, amount, reason, previous.netAmount, nextNet, user.id),
      d1.prepare(`UPDATE fdp_psychology_closings SET adjustments_amount = ?, net_amount = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND status NOT IN ('closed', 'paid')`)
        .bind(previous.adjustmentsAmount + projected.adjustmentsAmount, nextNet, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "psychology_closing.adjusted", entityType: "psychology_closing", entityId: id,
        before: { netAmount: previous.netAmount }, after: { netAmount: nextNet },
        metadata: { adjustmentId, kind, amount, reasonProvided: true },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ adjustment: { id: adjustmentId, kind, amount, previousAmount: previous.netAmount, newAmount: nextNet } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
