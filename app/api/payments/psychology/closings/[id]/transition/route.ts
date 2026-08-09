import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertTransition, psychologyClosingStatuses, psychologyTransitions, requiredPaymentEnum, requiredReason } from "@/lib/payments";
import { findPsychologyClosing, psychologyClosingSnapshot } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };

/**
 * Avança o fechamento do psicólogo pelo ciclo de vida do produto.
 * Concluir grava o snapshot imutável; reabrir exige capability própria e justificativa.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "psychology.payments.manage");

    const closing = await findPsychologyClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);

    const target = requiredPaymentEnum(body.status, psychologyClosingStatuses, "Status do fechamento");
    assertTransition(psychologyTransitions, closing.status, target);
    if (target === "closed" || target === "paid") requireCapability(workspace.role, "psychology.payments.close");
    if (target === "reopened") requireCapability(workspace.role, "payments.reopen");

    const reason = target === "reopened" ? requiredReason(body.reason, "REOPEN_REASON_REQUIRED") : "";
    const snapshot = target === "closed" ? await psychologyClosingSnapshot(d1, workspace.id, id) : null;

    const updated = await d1.prepare(`UPDATE fdp_psychology_closings SET status = ?,
        approved_by = CASE WHEN ? = 'approval' THEN ? ELSE approved_by END,
        approved_at = CASE WHEN ? = 'approval' THEN now() ELSE approved_at END,
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

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `psychology_closing.${target}`, entityType: "psychology_closing", entityId: id,
      before: { status: closing.status }, after: { status: target, netAmount: Number(closing.net_amount) },
      metadata: { reasonProvided: Boolean(reason), snapshotStored: Boolean(snapshot) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ closing: updated });
  } catch (error) {
    return apiError(error);
  }
}
