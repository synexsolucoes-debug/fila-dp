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

/**
 * Reabrir a competência desfaz o fechamento à força dos PJs dela.
 *
 * Sem isto, a competência voltava a aparecer aberta mas os fechamentos PJ
 * continuavam `closed`, e todo lançamento era recusado com "fechamento
 * concluído" — a tela dizia uma coisa e o servidor respondia outra.
 *
 * Só volta o que foi fechado pela competência: o último evento de auditoria do
 * fechamento precisa ser o `contractor_closing.closed` com `via:
 * competence_close`. Quem foi fechado pelo fluxo normal (pagamento conciliado)
 * continua fechado. O que já estava pago volta a `paid`, que segue travado;
 * o resto vai para `reopened`, o mesmo estado da reabertura manual.
 */
export async function reopenForcedContractorClosings(d1: Db, input: {
  workspaceId: string; cycleId: string; actorUserId: string; actorEmail: string; requestId: string | null; reason: string;
}) {
  const forced = await d1.prepare(`SELECT c.id, c.competence, c.company_id, c.provider_id, last.before_json ->> 'status' AS previous_status
    FROM fdp_contractor_closings c
    JOIN LATERAL (
      SELECT e.action, e.before_json, e.metadata_json FROM fdp_audit_events e
      WHERE e.workspace_id = c.workspace_id AND e.entity_type = 'contractor_closing' AND e.entity_id = c.id
      ORDER BY e.created_at DESC LIMIT 1
    ) last ON true
    WHERE c.workspace_id = ? AND c.payroll_cycle_id = ? AND c.excluded_at IS NULL AND c.status = 'closed'
      AND last.action = 'contractor_closing.closed' AND last.metadata_json ->> 'via' = 'competence_close'`)
    .bind(input.workspaceId, input.cycleId).all<Record<string, unknown>>();

  let reopened = 0;
  for (const row of forced.results) {
    const id = String(row.id);
    const target = row.previous_status === "paid" ? "paid" : "reopened";
    const reason = input.reason || "Competência reaberta na Operação DP.";
    const updated = await d1.prepare(`UPDATE fdp_contractor_closings SET status = ?,
        reopen_reason = CASE WHEN ? = 'reopened' THEN ? ELSE reopen_reason END
      WHERE workspace_id = ? AND id = ? AND status = 'closed' RETURNING id`)
      .bind(target, target, reason, input.workspaceId, id).first();
    if (!updated) continue;
    reopened += 1;
    const statements = [
      prepareAuditEvent({
        workspaceId: input.workspaceId, actorUserId: input.actorUserId, actorEmail: input.actorEmail,
        action: `contractor_closing.${target}`, entityType: "contractor_closing", entityId: id,
        before: { status: "closed" }, after: { status: target },
        metadata: { forced: true, via: "competence_reopen", reasonProvided: Boolean(input.reason) },
        requestId: input.requestId,
      }),
    ];
    // O que volta a `paid` não foi reaberto: segue travado, sem evento de reabertura.
    if (target === "reopened") statements.push(
      prepareDomainEvent(d1, {
        workspaceId: input.workspaceId, eventType: "contractor_closing.reopened", entityType: "contractor_closing", entityId: id,
        payload: {
          competence: row.competence, companyId: row.company_id, providerId: row.provider_id,
          status: target, previousStatus: "closed", forced: true,
        },
        actorUserId: input.actorUserId, requestId: input.requestId,
      }),
    );
    await d1.batch(statements);
  }
  return reopened;
}
