import { prepareAuditEvent } from "./fila-dp-db.ts";
import { prepareDomainEvent } from "./outbox.ts";
import { contractorClosingSnapshot, refreshContractorReconciliation } from "./payment-service.ts";

type Db = Parameters<typeof contractorClosingSnapshot>[0];

/**
 * Fechar a competência na Operação DP fecha junto todos os fechamentos PJ dela.
 *
 * É um fechamento por decisão do DP, não pelo fluxo normal: não exige pagamento
 * nem conciliação. Por isso cada fechamento guarda o snapshot de sempre, e a
 * auditoria registra `forced` com o status anterior e a conciliação do momento,
 * para que divergência fechada à força continue rastreável.
 */
export async function forceCloseContractorClosings(d1: Db, input: {
  workspaceId: string; cycleId: string; actorUserId: string; actorEmail: string; requestId: string | null;
}) {
  const open = await d1.prepare(`SELECT id, status, competence, company_id, provider_id, net_amount, invoice_expected_amount,
      complement_amount, caju_amount, invoice_status, caju_status
    FROM fdp_contractor_closings
    WHERE workspace_id = ? AND payroll_cycle_id = ? AND excluded_at IS NULL AND status <> 'closed'`)
    .bind(input.workspaceId, input.cycleId).all<Record<string, unknown>>();

  let closed = 0;
  for (const row of open.results) {
    const id = String(row.id);
    const { reconciliation } = await refreshContractorReconciliation(d1, input.workspaceId, id);
    const snapshot = await contractorClosingSnapshot(d1, input.workspaceId, id);
    const updated = await d1.prepare(`UPDATE fdp_contractor_closings SET status = 'closed', closed_by = ?, closed_at = now(),
        snapshot_json = ?::jsonb WHERE workspace_id = ? AND id = ? AND status = ? RETURNING id`)
      .bind(input.actorUserId, JSON.stringify(snapshot), input.workspaceId, id, String(row.status)).first();
    if (!updated) continue;
    closed += 1;
    await d1.batch([
      prepareAuditEvent({
        workspaceId: input.workspaceId, actorUserId: input.actorUserId, actorEmail: input.actorEmail,
        action: "contractor_closing.closed", entityType: "contractor_closing", entityId: id,
        before: { status: row.status }, after: { status: "closed", netAmount: Number(row.net_amount) },
        metadata: { forced: true, via: "competence_close", reconciliation: reconciliation.status },
        requestId: input.requestId,
      }),
      prepareDomainEvent(d1, {
        workspaceId: input.workspaceId, eventType: "contractor_closing.closed", entityType: "contractor_closing", entityId: id,
        payload: {
          competence: row.competence, companyId: row.company_id, providerId: row.provider_id,
          status: "closed", previousStatus: row.status, forced: true,
          netAmount: Number(row.net_amount), invoiceExpectedAmount: Number(row.invoice_expected_amount),
          complementAmount: Number(row.complement_amount), cajuAmount: Number(row.caju_amount),
          invoiceStatus: row.invoice_status, cajuStatus: row.caju_status,
        },
        actorUserId: input.actorUserId, requestId: input.requestId,
      }),
    ]);
  }
  return closed;
}
