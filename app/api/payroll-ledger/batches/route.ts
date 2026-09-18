import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import {
  advanceAmount, fromCents, isCompetence, recurringOccurrenceNumber, ruleInEffect,
} from "@/lib/payroll-ledger";

/**
 * O lote de conferência da competência.
 *
 * Não é um segundo fechamento: é a conferência deste módulo **dentro** do ciclo
 * que `fdp_payroll_cycles` já governa. Um lote por ciclo, garantido por índice
 * único — a segunda conferência paralela do mesmo mês é recusada pelo banco,
 * não por uma checagem que alguém pode esquecer de fazer.
 *
 * A resposta traz, ao lado do lote, os números que decidem se ele pode avançar:
 * quantas parcelas estão programadas, quantas foram confirmadas, a diferença
 * entre as duas, quantas parcelas de competências anteriores continuam em
 * aberto e quantos lançamentos ainda não foram aprovados. São exatamente os
 * blocos que a sua conferência pedia por escrito.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.read", "abrir a conferência da competência");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const competence = cleanText(url.searchParams.get("competence"), 7);
    if (!companyId || !isCompetence(competence)) {
      throw ApiError.badRequest("Informe a empresa e a competência.", "LEDGER_SCOPE_REQUIRED");
    }
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const cycle = await d1.prepare(`SELECT id, competence, status FROM fdp_payroll_cycles
      WHERE workspace_id = ? AND company_id = ? AND competence = ?`)
      .bind(workspace.id, companyId, competence).first<Record<string, unknown>>();

    const batch = cycle
      ? await d1.prepare(`SELECT batch.*, approver.name AS approved_by_name, closer.name AS closed_by_name
        FROM fdp_ledger_batches batch
        LEFT JOIN fdp_users approver ON approver.id = batch.approved_by
        LEFT JOIN fdp_users closer ON closer.id = batch.closed_by
        WHERE batch.workspace_id = ? AND batch.payroll_cycle_id = ?`)
        .bind(workspace.id, String(cycle.id)).first<Record<string, unknown>>()
      : null;

    /* Os blocos da conferência, em uma consulta. Cada um responde uma pergunta
       que a planilha só respondia lendo aba por aba. */
    const numbers = await d1.prepare(`SELECT
        COUNT(*) FILTER (WHERE installment.competence = ?)::int AS scheduled_count,
        COALESCE(SUM(installment.planned_amount) FILTER (WHERE installment.competence = ?
          AND installment.status NOT IN ('canceled', 'rescheduled', 'skipped')), 0) AS scheduled_amount,
        COALESCE(SUM(installment.discounted_amount) FILTER (WHERE installment.competence = ?), 0) AS confirmed_amount,
        COUNT(*) FILTER (WHERE installment.competence = ?
          AND installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
          AND installment.discounted_amount < installment.planned_amount)::int AS open_count,
        COUNT(*) FILTER (WHERE installment.competence < ?
          AND installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
          AND installment.discounted_amount < installment.planned_amount)::int AS overdue_count,
        COALESCE(SUM(installment.planned_amount - installment.discounted_amount) FILTER (WHERE installment.competence < ?
          AND installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
          AND installment.discounted_amount < installment.planned_amount), 0) AS overdue_amount,
        COUNT(*) FILTER (WHERE installment.competence > ?
          AND installment.status NOT IN ('canceled', 'rescheduled', 'skipped'))::int AS future_count,
        COALESCE(SUM(installment.planned_amount - installment.discounted_amount) FILTER (WHERE installment.competence > ?
          AND installment.status NOT IN ('canceled', 'rescheduled', 'skipped')), 0) AS future_amount
      FROM fdp_ledger_installments installment
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
      WHERE installment.workspace_id = ? AND installment.company_id = ?
        AND entry.status IN ('approved', 'active', 'suspended', 'settled')`)
      .bind(competence, competence, competence, competence, competence, competence, competence, competence,
        workspace.id, companyId).first<Record<string, unknown>>();

    /* Lançamento sem aprovação é bloqueio nomeado, não um número solto: a
       conferência não avança enquanto alguém não decidir sobre ele. */
    const pending = await d1.prepare(`SELECT COUNT(*)::int AS total
      FROM fdp_ledger_entries entry
      WHERE entry.workspace_id = ? AND entry.company_id = ?
        AND entry.status IN ('draft', 'pending_approval')
        AND entry.first_competence <= ?`)
      .bind(workspace.id, companyId, competence).first<{ total: number }>();

    const advances = await d1.prepare(`SELECT
        COALESCE(SUM(approved_amount) FILTER (WHERE status <> 'canceled'), 0) AS expected_amount,
        COALESCE(SUM(paid_amount), 0) AS paid_amount,
        COUNT(*) FILTER (WHERE status = 'pending_data')::int AS pending_count
      FROM fdp_ledger_advance_payments
      WHERE workspace_id = ? AND company_id = ? AND competence = ?`)
      .bind(workspace.id, companyId, competence).first<Record<string, unknown>>();

    const scheduledAmount = Number(numbers?.scheduled_amount ?? 0);
    const confirmedAmount = Number(numbers?.confirmed_amount ?? 0);

    return Response.json({
      cycle,
      batch,
      summary: {
        scheduledCount: Number(numbers?.scheduled_count ?? 0),
        scheduledAmount,
        confirmedAmount,
        /* A diferença é o número da conferência: o que foi programado e não
           voltou confirmado. Ela não some no fim do mês. */
        differenceAmount: scheduledAmount - confirmedAmount,
        openCount: Number(numbers?.open_count ?? 0),
        overdueCount: Number(numbers?.overdue_count ?? 0),
        overdueAmount: Number(numbers?.overdue_amount ?? 0),
        futureCount: Number(numbers?.future_count ?? 0),
        futureAmount: Number(numbers?.future_amount ?? 0),
        entriesWithoutApproval: Number(pending?.total ?? 0),
        advanceExpectedAmount: Number(advances?.expected_amount ?? 0),
        advancePaidAmount: Number(advances?.paid_amount ?? 0),
        advancePendingCount: Number(advances?.pending_count ?? 0),
      },
    });
  } catch (error) { return apiError(error); }
}

/** Abre a conferência da competência. */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.manage", "abrir a conferência da competência");

    const companyId = cleanText(body.companyId, 120);
    const competence = cleanText(body.competence, 7);
    if (!companyId || !isCompetence(competence)) {
      throw ApiError.badRequest("Informe a empresa e a competência.", "LEDGER_SCOPE_REQUIRED");
    }
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    /* A competência vem do ciclo de folha. Sem ciclo aberto não há conferência:
       o módulo não cria competência própria — isso é da Operação DP. */
    const cycle = await d1.prepare(`SELECT id, status FROM fdp_payroll_cycles
      WHERE workspace_id = ? AND company_id = ? AND competence = ?`)
      .bind(workspace.id, companyId, competence).first<Record<string, unknown>>();
    if (!cycle) {
      throw ApiError.badRequest(
        "Esta competência ainda não foi aberta na Operação DP. A conferência dos descontos acontece dentro dela.",
        "LEDGER_CYCLE_NOT_FOUND",
      );
    }
    if (String(cycle.status) === "closed") {
      throw ApiError.badRequest("A competência está fechada na Operação DP.", "COMPETENCE_CLOSED");
    }

    const existing = await d1.prepare(`SELECT id, status FROM fdp_ledger_batches
      WHERE workspace_id = ? AND payroll_cycle_id = ?`)
      .bind(workspace.id, String(cycle.id)).first<Record<string, unknown>>();
    if (existing) return Response.json({ batch: existing, created: false });

    /* O recorrente não tem parcelas programadas de saída — ele tem um valor por
       mês e uma vigência. Abrir a competência é o momento em que esse valor
       vira uma parcela conferível: antes disso não havia nada a conferir, e o
       vale fixo simplesmente não aparecia no mês.
       O adiantamento salarial fica de fora daqui de propósito: ele passa pela
       programação da aba de Adiantamentos, que registra também o pagamento à
       pessoa. Materializar os dois aqui criaria a dívida duas vezes. */
    const recorrentes = await d1.prepare(`SELECT entry.id, entry.first_competence, entry.title,
        rule.mode, rule.fixed_amount, rule.percentage, rule.salary_base_amount,
        rule.effective_from_competence, rule.end_competence, rule.status AS rule_status
      FROM fdp_ledger_entries entry
      JOIN fdp_ledger_advance_rules rule
        ON rule.workspace_id = entry.workspace_id AND rule.entry_id = entry.id
      WHERE entry.workspace_id = ? AND entry.company_id = ?
        AND entry.modality = 'recurring'
        AND entry.category <> 'salary_advance'
        AND entry.status IN ('approved', 'active')
        AND entry.first_competence <= ?
        AND (entry.recurrence_end_competence IS NULL OR entry.recurrence_end_competence >= ?)`)
      .bind(workspace.id, companyId, competence, competence).all<Record<string, unknown>>();

    const regrasPorLancamento = new Map<string, Record<string, unknown>[]>();
    const tituloPorLancamento = new Map<string, { title: string; firstCompetence: string }>();
    for (const linha of recorrentes.results) {
      const entryId = String(linha.id);
      const lista = regrasPorLancamento.get(entryId) ?? [];
      lista.push(linha);
      regrasPorLancamento.set(entryId, lista);
      tituloPorLancamento.set(entryId, {
        title: String(linha.title),
        firstCompetence: String(linha.first_competence),
      });
    }

    const parcelasRecorrentes = [];
    for (const [entryId, linhas] of regrasPorLancamento) {
      const regra = ruleInEffect(linhas.map((linha) => ({
        effectiveFromCompetence: String(linha.effective_from_competence),
        endCompetence: linha.end_competence ? String(linha.end_competence) : null,
        status: String(linha.rule_status),
        mode: String(linha.mode) as "single_competence" | "fixed_monthly" | "percentage",
        fixedAmount: linha.fixed_amount === null ? null : Number(linha.fixed_amount),
        percentage: linha.percentage === null ? null : Number(linha.percentage),
        salaryBaseAmount: linha.salary_base_amount === null ? null : Number(linha.salary_base_amount),
      })), competence);
      if (!regra) continue;

      /* Percentual sem base não vira R$ 0,00: a competência simplesmente não
         materializa a parcela, e o lançamento continua visível como pendência.
         Gravar zero seria inventar um desconto que ninguém decidiu. */
      const valor = advanceAmount(regra);
      if (!valor.ok) continue;

      const dados = tituloPorLancamento.get(entryId)!;
      parcelasRecorrentes.push(d1.prepare(`INSERT INTO fdp_ledger_installments
        (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount, note)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT (workspace_id, entry_id, number) DO NOTHING`)
        .bind(crypto.randomUUID(), workspace.id, entryId, companyId,
          recurringOccurrenceNumber(dados.firstCompetence, competence),
          competence, fromCents(valor.cents), "Ocorrência do lançamento recorrente."));
    }

    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_ledger_batches
        (id, workspace_id, company_id, payroll_cycle_id, competence, status, created_by)
        VALUES (?, ?, ?, ?, ?, 'draft', ?)
        ON CONFLICT (workspace_id, payroll_cycle_id) DO NOTHING`)
        .bind(id, workspace.id, companyId, String(cycle.id), competence, user.id),
      ...parcelasRecorrentes,
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_batch.opened", entityType: "ledger_batch", entityId: id,
        after: { companyId, competence, status: "draft" },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    const batch = await d1.prepare(`SELECT id, status, competence FROM fdp_ledger_batches
      WHERE workspace_id = ? AND payroll_cycle_id = ?`)
      .bind(workspace.id, String(cycle.id)).first<Record<string, unknown>>();
    return Response.json({ batch, created: String(batch?.id) === id }, { status: 201 });
  } catch (error) { return apiError(error); }
}
