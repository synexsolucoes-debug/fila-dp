import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { contractorComponentType, contractorProjectionKey } from "@/lib/payroll-ledger";
import type { LedgerCategory } from "@/lib/payroll-ledger";

/**
 * As transições da conferência.
 *
 * O vocabulário separa três coisas que a planilha escrevia igual — "lançado na
 * Domínio" podia significar qualquer uma delas, e por isso não significava
 * nenhuma:
 *
 *   draft → in_review → approved → exported → sent_to_payroll → confirmed → closed
 *
 * * **exported**: o arquivo saiu daqui;
 * * **sent_to_payroll**: alguém lançou no sistema de folha;
 * * **confirmed**: os valores efetivamente descontados voltaram e foram
 *   registrados parcela a parcela.
 *
 * Nenhuma transição confirma desconto. Elas movem o lote; o saldo só muda por
 * `fdp_ledger_confirmations`.
 */
const transicoes: Record<string, string[]> = {
  draft: ["in_review"],
  in_review: ["draft", "approved"],
  approved: ["in_review", "exported", "sent_to_payroll"],
  exported: ["approved", "sent_to_payroll"],
  sent_to_payroll: ["exported", "confirmed"],
  confirmed: ["sent_to_payroll", "closed"],
  closed: ["reopened"],
  reopened: ["in_review", "approved"],
};

/** Situações que exigem permissão além de `ledger.manage`. */
const permissaoDe: Record<string, string> = {
  approved: "ledger.close",
  closed: "ledger.close",
  reopened: "ledger.reopen",
};

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);

    const alvo = cleanText(body.status, 30);
    if (!Object.values(transicoes).flat().includes(alvo)) {
      throw ApiError.badRequest("Situação de destino inválida.", "LEDGER_BATCH_STATUS");
    }
    requireNamedCapability(workspace, "ledger.manage", "conduzir a conferência da competência");
    if (permissaoDe[alvo]) {
      requireNamedCapability(workspace, permissaoDe[alvo] as "ledger.close",
        alvo === "reopened" ? "reabrir a conferência encerrada" : "aprovar ou encerrar a conferência");
    }

    const batch = await d1.prepare(`SELECT batch.*, cycle.status AS cycle_status
      FROM fdp_ledger_batches batch
      JOIN fdp_payroll_cycles cycle
        ON cycle.workspace_id = batch.workspace_id AND cycle.id = batch.payroll_cycle_id
      WHERE batch.workspace_id = ? AND batch.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!batch) throw ApiError.notFound("Conferência não encontrada.", "LEDGER_BATCH_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(batch.company_id));

    const atual = String(batch.status);
    if (!transicoes[atual]?.includes(alvo)) {
      throw ApiError.badRequest(
        `A conferência está em "${atual}" e não pode ir direto para "${alvo}".`,
        "LEDGER_BATCH_TRANSITION",
      );
    }

    const justificativa = cleanText(body.reason, 500);
    if (alvo === "reopened" && justificativa.trim().length < 5) {
      throw ApiError.badRequest("Informe o motivo da reabertura.", "LEDGER_REOPEN_REASON_REQUIRED");
    }

    const competence = String(batch.competence);
    const companyId = String(batch.company_id);
    const requestId = request.headers.get("x-fila-dp-request-id");

    /* Aprovar tem portões, e eles são o motivo de a conferência existir. Um
       lançamento sem aprovação aprovado em lote seria um desconto autorizado
       por omissão. */
    if (alvo === "approved") {
      const bloqueios = await d1.prepare(`SELECT
          (SELECT COUNT(*)::int FROM fdp_ledger_entries entry
            WHERE entry.workspace_id = ? AND entry.company_id = ?
              AND entry.status IN ('draft', 'pending_approval')
              AND entry.first_competence <= ?) AS sem_aprovacao,
          (SELECT COUNT(*)::int FROM fdp_ledger_advance_payments payment
            WHERE payment.workspace_id = ? AND payment.company_id = ?
              AND payment.competence = ? AND payment.status = 'pending_data') AS adiantamentos_pendentes`)
        .bind(workspace.id, companyId, competence, workspace.id, companyId, competence)
        .first<Record<string, unknown>>();

      const semAprovacao = Number(bloqueios?.sem_aprovacao ?? 0);
      const pendentes = Number(bloqueios?.adiantamentos_pendentes ?? 0);
      if (semAprovacao || pendentes) {
        const partes = [
          semAprovacao ? `${semAprovacao} lançamento(s) sem aprovação` : "",
          pendentes ? `${pendentes} adiantamento(s) sem valor calculado` : "",
        ].filter(Boolean);
        throw new ApiError(409, "LEDGER_BATCH_BLOCKED",
          `Não é possível aprovar a conferência: ${partes.join(" e ")}. Resolva esses itens e tente novamente.`,
          { blockers: { entriesWithoutApproval: semAprovacao, advancesPending: pendentes } });
      }
    }

    const statements = [
      /* O `WHERE` carrega a situação esperada: se outra pessoa avançou a
         conferência no intervalo, o UPDATE não pega linha e a transição não é
         aplicada duas vezes. */
      d1.prepare(`UPDATE fdp_ledger_batches
        SET status = ?, reopen_reason = ?, notes = ?,
            approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
            approved_at = CASE WHEN ? = 'approved' THEN now() ELSE approved_at END,
            closed_by = CASE WHEN ? = 'closed' THEN ? ELSE closed_by END,
            closed_at = CASE WHEN ? = 'closed' THEN now() ELSE closed_at END,
            snapshot_json = CASE WHEN ? = 'closed' THEN ?::jsonb ELSE snapshot_json END
        WHERE workspace_id = ? AND id = ? AND status = ?`)
        .bind(alvo, alvo === "reopened" ? justificativa : String(batch.reopen_reason ?? ""),
          cleanText(body.notes, 1000) || String(batch.notes ?? ""),
          alvo, user.id, alvo, alvo, user.id, alvo, alvo,
          JSON.stringify(body.snapshot ?? {}), workspace.id, id, atual),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: `ledger_batch.${alvo}`, entityType: "ledger_batch", entityId: id,
        before: { status: atual }, after: { status: alvo },
        metadata: { competence, companyId, reason: justificativa || null }, requestId,
      }),
    ];

    /**
     * A projeção PJ.
     *
     * Ao aprovar a conferência, cada parcela de prestador vira um desconto em
     * `fdp_contractor_components` com `external_id = ledger:<parcela>`. O índice
     * único que **já existia** naquela tabela é o que garante que reprocessar a
     * aprovação — ou recalcular o fechamento PJ — não lance a mesma cobrança
     * duas vezes. A garantia está no banco, não na ordem em que o serviço roda.
     *
     * Não há fechamento PJ paralelo: a confirmação desses descontos vem do
     * fechamento que o módulo de Pagamento PJ já governa.
     */
    let projetadas = 0;
    if (alvo === "approved") {
      const pj = await d1.prepare(`SELECT installment.id, installment.planned_amount, installment.number,
          installment.total_count, entry.provider_id, entry.category, entry.title
        FROM fdp_ledger_installments installment
        JOIN fdp_ledger_entries entry
          ON entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
        WHERE installment.workspace_id = ? AND installment.company_id = ?
          AND installment.competence = ?
          AND installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
          AND entry.settlement_target = 'contractor_payment'
          AND entry.status IN ('approved', 'active')`)
        .bind(workspace.id, companyId, competence).all<Record<string, unknown>>();

      for (const parcela of pj.results) {
        projetadas += 1;
        const numero = parcela.total_count
          ? `${Number(parcela.number)}/${Number(parcela.total_count)}`
          : String(Number(parcela.number));
        statements.push(d1.prepare(`INSERT INTO fdp_contractor_components
          (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence, direction,
           component_type, description, amount, origin, external_id, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 'debit', ?, ?, ?, 'import', ?, ?)
          ON CONFLICT (workspace_id, external_id) DO NOTHING`)
          .bind(crypto.randomUUID(), workspace.id, companyId, String(parcela.provider_id),
            String(batch.payroll_cycle_id), competence,
            contractorComponentType(String(parcela.category) as LedgerCategory),
            `${String(parcela.title)} — parcela ${numero}`,
            Number(parcela.planned_amount ?? 0),
            contractorProjectionKey(String(parcela.id)), user.id));
        statements.push(d1.prepare(`INSERT INTO fdp_ledger_events
          (id, workspace_id, entry_id, installment_id, event_type, summary, payload_json, actor_user_id)
          SELECT ?, ?, installment.entry_id, installment.id, 'projected_to_contractor', ?, ?::jsonb, ?
          FROM fdp_ledger_installments installment
          WHERE installment.workspace_id = ? AND installment.id = ?`)
          .bind(crypto.randomUUID(), workspace.id,
            `Projetado no fechamento PJ de ${competence}`,
            JSON.stringify({ externalId: contractorProjectionKey(String(parcela.id)) }), user.id,
            workspace.id, String(parcela.id)));
      }
    }

    /* Vincular as parcelas ao lote é o que dá rastro de qual conferência tratou
       qual parcela — e é o que a exportação usa para montar o arquivo. */
    if (alvo === "in_review" || alvo === "approved") {
      statements.push(d1.prepare(`UPDATE fdp_ledger_installments installment
        SET batch_id = ?, updated_at = now()
        FROM fdp_ledger_entries entry
        WHERE entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
          AND installment.workspace_id = ? AND installment.company_id = ?
          AND installment.competence = ? AND installment.batch_id IS NULL
          AND entry.status IN ('approved', 'active', 'suspended')`)
        .bind(id, workspace.id, companyId, competence));
    }

    if (alvo === "exported") {
      statements.push(d1.prepare(`UPDATE fdp_ledger_batches
        SET exported_at = now(), exported_by = ?, export_reference = ?
        WHERE workspace_id = ? AND id = ?`)
        .bind(user.id, cleanText(body.exportReference, 200), workspace.id, id));
    }

    await d1.batch(statements);

    const aplicado = await d1.prepare(`SELECT id, status, competence, version, reopen_reason
      FROM fdp_ledger_batches WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (String(aplicado?.status) !== alvo) {
      throw new ApiError(409, "LEDGER_BATCH_CONFLICT",
        "Alguém moveu a conferência enquanto você a movia. Recarregue e confira o estado atual.");
    }

    return Response.json({ batch: aplicado, projectedToContractorPayment: projetadas });
  } catch (error) { return apiError(error); }
}
