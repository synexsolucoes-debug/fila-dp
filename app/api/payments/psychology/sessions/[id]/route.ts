import type { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertNoClinicalData } from "@/lib/auxiliary";
import { cleanText, optionalDate } from "@/lib/registrations";
import { calculateSessionTotal, positiveMoney, quantity, requiredReason } from "@/lib/payments";

type Params = { params: Promise<{ id: string }> };
type Database = ReturnType<typeof getD1>;

async function loadSession(d1: Database, workspaceId: string, id: string) {
  const session = await d1
    .prepare(`SELECT s.id, s.company_id, s.provider_id, s.employee_id, s.payroll_cycle_id, s.closing_id, s.session_quantity,
        s.unit_amount, s.total_amount, s.status, s.session_date, c.status AS closing_status
      FROM fdp_psychology_sessions s
      LEFT JOIN fdp_psychology_closings c ON c.workspace_id = s.workspace_id AND c.id = s.closing_id
      WHERE s.workspace_id = ? AND s.id = ?`)
    .bind(workspaceId, id)
    .first<{
      id: string; company_id: string; provider_id: string; employee_id: string; payroll_cycle_id: string; closing_id: string | null;
      session_quantity: number; unit_amount: string | number; total_amount: string | number; status: string; session_date: string; closing_status: string | null;
    }>();
  if (!session) throw ApiError.notFound("Consulta não encontrada.", "PSYCHOLOGY_SESSION_NOT_FOUND");
  if (session.closing_status === "closed" || session.closing_status === "paid") {
    throw ApiError.badRequest("O fechamento desta competência está concluído. Reabra com justificativa para alterar consultas.", "PAYMENT_CLOSING_LOCKED");
  }
  return session;
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "psychology.payments.manage");

    const session = await loadSession(d1, workspace.id, id);
    if (session.status !== "registered") throw ApiError.badRequest("A consulta está cancelada.", "PSYCHOLOGY_SESSION_CANCELED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, session.company_id);

    const note = cleanText(body.administrativeNote, 300);
    assertNoClinicalData("psychology", note);
    const sessionQuantity = quantity(body.quantity ?? session.session_quantity, "Quantidade de consultas");
    const unitAmount = positiveMoney(body.unitAmount ?? session.unit_amount, "Valor unitário da consulta");
    const totalAmount = calculateSessionTotal(sessionQuantity, unitAmount);
    const sessionDate = optionalDate(body.sessionDate ?? session.session_date, true);

    await d1.batch([
      d1.prepare(`UPDATE fdp_psychology_sessions SET session_quantity = ?, unit_amount = ?, total_amount = ?, session_date = ?, administrative_note = ?
        WHERE workspace_id = ? AND id = ? AND status = 'registered'`)
        .bind(sessionQuantity, unitAmount, totalAmount, sessionDate, note, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "psychology_session.updated", entityType: "psychology_session", entityId: id,
        before: { sessionQuantity: session.session_quantity, unitAmount: Number(session.unit_amount), totalAmount: Number(session.total_amount) },
        after: { sessionQuantity, unitAmount, totalAmount },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ session: { id, sessionQuantity, unitAmount, totalAmount } });
  } catch (error) {
    return apiError(error);
  }
}

/** Consultas não são apagadas: o cancelamento administrativo preserva o histórico. */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "psychology.payments.manage");

    const session = await loadSession(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, session.company_id);
    // O motivo do cancelamento é texto livre e fica gravado na consulta. Sem a
    // mesma guarda usada na criação e na edição, ele era a porta aberta para
    // dado clínico entrar num módulo que é só administrativo e financeiro.
    const reason = requiredReason(body.reason, "CANCELLATION_REASON_REQUIRED");
    assertNoClinicalData("psychology", reason);

    await d1.batch([
      d1.prepare(`UPDATE fdp_psychology_sessions SET status = 'canceled', canceled_reason = ?, canceled_by = ?, canceled_at = now()
        WHERE workspace_id = ? AND id = ? AND status = 'registered'`)
        .bind(reason, user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "psychology_session.canceled", entityType: "psychology_session", entityId: id,
        before: { status: session.status, totalAmount: Number(session.total_amount) },
        after: { status: "canceled" },
        metadata: { reasonProvided: true },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ session: { id, status: "canceled" } });
  } catch (error) {
    return apiError(error);
  }
}
