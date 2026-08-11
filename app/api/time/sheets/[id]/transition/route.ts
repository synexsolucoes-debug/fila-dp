import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { requiredPaymentEnum, requiredReason } from "@/lib/payments";
import { assertApprovable, assertTimeTransition, timeSheetStatuses } from "@/lib/time-tracking";
import { findTimeSheet, recalculateTimeSheet, timeSheetSnapshot } from "@/lib/time-service";
import { prepareDomainEvent } from "@/lib/outbox";

type Params = { params: Promise<{ id: string }> };

/**
 * Move a folha de ponto pelo ciclo de conferência.
 *
 * Aprovar exige, além da capability, que nenhuma inconsistência bloqueante
 * esteja aberta — e a contagem usada é reapurada na hora, não a que estava
 * gravada. A transição para `exported` não passa por aqui: quem exporta é a
 * rota de exportação, que precisa dos mapeamentos do §22.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.manage");

    const sheet = await findTimeSheet(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, sheet.company_id);

    const target = requiredPaymentEnum(body.status, timeSheetStatuses, "Status da folha de ponto");
    if (target === "exported") {
      throw ApiError.badRequest("A exportação é feita pela rota de exportação, que valida os mapeamentos de rubrica.", "TIME_EXPORT_ROUTE_REQUIRED");
    }
    assertTimeTransition(sheet.status, target);

    if (target === "approved" || target === "rejected") requireCapability(workspace, "time.approve");
    const reopening = (sheet.status === "exported" || sheet.status === "closed") && target === "review";
    const reason = reopening ? requiredReason(body.reason, "TIME_REOPEN_REASON_REQUIRED") : "";
    const rejectedReason = target === "rejected" ? requiredReason(body.reason, "TIME_REJECT_REASON_REQUIRED") : "";

    if (target === "approved") {
      // Reapura antes de decidir: aprovar sobre número velho seria aprovar no escuro.
      const recalculated = await recalculateTimeSheet(d1, workspace.id, id);
      assertApprovable(recalculated.openBlockingIssues);
    }

    const snapshot = target === "closed" ? await timeSheetSnapshot(d1, workspace.id, id) : null;
    const updated = await d1.prepare(`UPDATE fdp_time_sheets SET status = ?,
        approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
        approved_at = CASE WHEN ? = 'approved' THEN now() ELSE approved_at END,
        rejected_reason = CASE WHEN ? = 'rejected' THEN ? ELSE rejected_reason END,
        reopen_reason = CASE WHEN ? THEN ? ELSE reopen_reason END,
        snapshot_json = CASE WHEN ? = 'closed' THEN ?::jsonb ELSE snapshot_json END
      WHERE workspace_id = ? AND id = ? AND status = ?
      RETURNING id, status, blocking_issues, warning_issues`)
      .bind(target, target, user.id, target, target, rejectedReason, reopening, reason, target, JSON.stringify(snapshot ?? {}),
        workspace.id, id, sheet.status)
      .first<Record<string, unknown>>();
    if (!updated) throw new ApiError(409, "TIME_SHEET_CONFLICT", "A folha de ponto mudou de estado. Recarregue e tente novamente.");

    const statements = [prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `time_sheet.${target}`, entityType: "time_sheet", entityId: id,
      before: { status: sheet.status },
      after: { status: target, workedMinutes: sheet.worked_minutes, balanceMinutes: sheet.balance_minutes },
      metadata: { reasonProvided: Boolean(reason || rejectedReason), snapshotStored: Boolean(snapshot) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    })];

    if (target === "approved" || reopening) {
      statements.push(prepareDomainEvent(d1, {
        workspaceId: workspace.id,
        eventType: target === "approved" ? "time_sheet.approved" : "time_sheet.reopened",
        entityType: "time_sheet",
        entityId: id,
        payload: {
          competence: sheet.competence, companyId: sheet.company_id, employeeId: sheet.employee_id,
          status: target, previousStatus: sheet.status,
          workedMinutes: Number(sheet.worked_minutes), balanceMinutes: Number(sheet.balance_minutes),
        },
        actorUserId: user.id,
        requestId: request.headers.get("x-fila-dp-request-id"),
      }));
    }
    await d1.batch(statements);

    return Response.json({ sheet: updated });
  } catch (error) {
    return apiError(error);
  }
}
