import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import {
  advanceAmount, advancePaymentKey, competenceDistance, fromCents, isCompetence, ruleInEffect,
} from "@/lib/payroll-ledger";
import { MAX_LEDGER_RECORDS } from "@/lib/payroll-ledger-service";

/** Os adiantamentos previstos e pagos da competência. */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.read", "consultar os adiantamentos da competência");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const conditions = ["payment.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      if (ids.length) { conditions.push(`payment.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
      else conditions.push("false");
    }
    if (companyId) { conditions.push("payment.company_id = ?"); values.push(companyId); }
    const competence = cleanText(url.searchParams.get("competence"), 7);
    if (isCompetence(competence)) { conditions.push("payment.competence = ?"); values.push(competence); }
    const status = cleanText(url.searchParams.get("status"), 30);
    if (["scheduled", "pending_data", "authorized", "paid", "canceled"].includes(status)) {
      conditions.push("payment.status = ?"); values.push(status);
    }

    const result = await d1.prepare(`SELECT payment.*,
        entry.title AS entry_title, entry.modality, entry.employee_id,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name,
        employee.full_name AS employee_name, employee.registration_number,
        entry.unit_label, entry.department_label,
        recovery.discounted_amount AS recovered_amount,
        recovery.planned_amount AS recovery_planned_amount,
        recovery.competence AS recovery_competence,
        recovery.status AS recovery_status
      FROM fdp_ledger_advance_payments payment
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = payment.workspace_id AND entry.id = payment.entry_id
      JOIN fdp_companies company
        ON company.workspace_id = payment.workspace_id AND company.id = payment.company_id
      LEFT JOIN fdp_employees employee
        ON employee.workspace_id = entry.workspace_id AND employee.id = entry.employee_id
      LEFT JOIN fdp_ledger_installments recovery
        ON recovery.workspace_id = payment.workspace_id AND recovery.entry_id = payment.entry_id
        AND recovery.competence = payment.competence
      WHERE ${conditions.join(" AND ")}
      ORDER BY payment.competence DESC, employee.full_name
      LIMIT ?`).bind(...values, MAX_LEDGER_RECORDS + 1).all<Record<string, unknown>>();

    const rows = result.results.slice(0, MAX_LEDGER_RECORDS);
    return Response.json({
      payments: rows.map((row) => ({
        id: String(row.id),
        entryId: String(row.entry_id),
        entryTitle: String(row.entry_title ?? ""),
        companyId: String(row.company_id),
        companyName: String(row.company_name ?? ""),
        employeeId: row.employee_id ? String(row.employee_id) : "",
        employeeName: String(row.employee_name ?? ""),
        registrationNumber: String(row.registration_number ?? ""),
        unitLabel: String(row.unit_label ?? ""),
        departmentLabel: String(row.department_label ?? ""),
        competence: String(row.competence),
        approvedAmount: Number(row.approved_amount ?? 0),
        paidAmount: Number(row.paid_amount ?? 0),
        expectedPaymentDate: row.expected_payment_date ? String(row.expected_payment_date) : "",
        actualPaymentDate: row.actual_payment_date ? String(row.actual_payment_date) : "",
        status: String(row.status),
        pendingReason: String(row.pending_reason ?? ""),
        cancelReason: String(row.cancel_reason ?? ""),
        /* O outro lado do mesmo lançamento: o que foi recuperado desta pessoa
           na competência. "Pago" e "descontado" aparecem lado a lado porque a
           confusão entre os dois é o defeito que este módulo existe para
           resolver. */
        recoveryPlannedAmount: Number(row.recovery_planned_amount ?? 0),
        recoveredAmount: Number(row.recovered_amount ?? 0),
        recoveryCompetence: row.recovery_competence ? String(row.recovery_competence) : "",
        recoveryStatus: row.recovery_status ? String(row.recovery_status) : "",
      })),
      truncated: result.results.length > MAX_LEDGER_RECORDS,
    });
  } catch (error) { return apiError(error); }
}

/**
 * Gera a programação mensal dos adiantamentos recorrentes de uma competência.
 *
 * Gerar **não** paga e **não** desconta. O que nasce aqui é uma linha
 * `scheduled` — ou `pending_data`, quando a regra é percentual e ninguém
 * informou a base salarial. A recorrência produz a previsão; o dinheiro exige
 * alguém autorizar e alguém registrar que saiu.
 *
 * A operação é idempotente: `(workspace, entry, competence)` é único no banco,
 * então rodar a geração duas vezes no mesmo mês não produz dois pagamentos. A
 * resposta diz quantos foram criados e quantos já existiam, em vez de fingir
 * que criou tudo de novo.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.manage", "gerar a programação de adiantamentos da competência");

    const companyId = cleanText(body.companyId, 120);
    if (!companyId) throw ApiError.badRequest("Selecione a empresa.", "LEDGER_COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const competence = cleanText(body.competence, 7);
    if (!isCompetence(competence)) {
      throw ApiError.badRequest("Informe a competência no formato AAAA-MM.", "INVALID_LEDGER_COMPETENCE");
    }
    const expectedPaymentDate = cleanText(body.expectedPaymentDate, 10) || null;
    if (expectedPaymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedPaymentDate)) {
      throw ApiError.badRequest("Informe a data prevista no formato AAAA-MM-DD.", "INVALID_LEDGER_DATE");
    }

    const candidatos = await d1.prepare(`SELECT entry.id, entry.first_competence, entry.recurrence_end_competence,
        entry.modality, entry.employee_id, entry.title
      FROM fdp_ledger_entries entry
      WHERE entry.workspace_id = ? AND entry.company_id = ? AND entry.category = 'salary_advance'
        AND entry.status IN ('approved', 'active')
        AND entry.first_competence <= ?
        AND (entry.recurrence_end_competence IS NULL OR entry.recurrence_end_competence >= ?)`)
      .bind(workspace.id, companyId, competence, competence).all<Record<string, unknown>>();

    const regras = await d1.prepare(`SELECT rule.entry_id, rule.mode, rule.fixed_amount, rule.percentage,
        rule.salary_base_amount, rule.effective_from_competence, rule.end_competence, rule.status
      FROM fdp_ledger_advance_rules rule
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = rule.workspace_id AND entry.id = rule.entry_id
      WHERE rule.workspace_id = ? AND entry.company_id = ? AND entry.category = 'salary_advance'`)
      .bind(workspace.id, companyId).all<Record<string, unknown>>();

    const porLancamento = new Map<string, Record<string, unknown>[]>();
    for (const regra of regras.results) {
      const lista = porLancamento.get(String(regra.entry_id)) ?? [];
      lista.push(regra);
      porLancamento.set(String(regra.entry_id), lista);
    }

    const statements = [];
    let criados = 0;
    let pendentes = 0;
    const semRegra: string[] = [];

    for (const lancamento of candidatos.results) {
      const entryId = String(lancamento.id);
      /* Lançamento único só produz a ocorrência da própria competência; o
         recorrente produz uma por mês enquanto a vigência valer. */
      if (String(lancamento.modality) !== "recurring"
        && competenceDistance(String(lancamento.first_competence), competence) !== 0) continue;

      const regra = ruleInEffect(
        (porLancamento.get(entryId) ?? []).map((linha) => ({
          effectiveFromCompetence: String(linha.effective_from_competence),
          endCompetence: linha.end_competence ? String(linha.end_competence) : null,
          status: String(linha.status),
          mode: String(linha.mode) as "single_competence" | "fixed_monthly" | "percentage",
          fixedAmount: linha.fixed_amount === null ? null : Number(linha.fixed_amount),
          percentage: linha.percentage === null ? null : Number(linha.percentage),
          salaryBaseAmount: linha.salary_base_amount === null ? null : Number(linha.salary_base_amount),
        })),
        competence,
      );
      if (!regra) { semRegra.push(String(lancamento.title)); continue; }

      const valor = advanceAmount(regra);
      const pendente = !valor.ok;
      if (pendente) pendentes += 1; else criados += 1;

      statements.push(d1.prepare(`INSERT INTO fdp_ledger_advance_payments
        (id, workspace_id, entry_id, company_id, competence, approved_amount, expected_payment_date,
         status, pending_reason, idempotency_key, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, entry_id, competence) DO NOTHING`)
        .bind(crypto.randomUUID(), workspace.id, entryId, companyId, competence,
          valor.ok ? fromCents(valor.cents) : 0, expectedPaymentDate,
          valor.ok ? "scheduled" : "pending_data",
          valor.ok ? "" : valor.pendingReason,
          advancePaymentKey(entryId, competence), user.id));

      statements.push(d1.prepare(`INSERT INTO fdp_ledger_events
        (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'advance_scheduled', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, entryId,
          `Programado para ${competence}`,
          JSON.stringify({ competence, pending: pendente }), user.id));
    }

    if (!statements.length) {
      return Response.json({
        created: 0, pending: 0, skipped: semRegra,
        message: "Nenhum adiantamento vigente nesta competência.",
      });
    }

    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "ledger_advance.scheduled", entityType: "payroll_cycle", entityId: null,
      after: { companyId, competence, created: criados, pending: pendentes },
      metadata: { withoutRule: semRegra.length }, requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    await d1.batch(statements);

    /* A contagem real vem do banco, e não do laço: o `ON CONFLICT DO NOTHING`
       significa que parte das linhas pode já existir, e relatar "criei 40"
       quando 38 já estavam lá seria mentir sobre o que aconteceu. */
    const total = await d1.prepare(`SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending_data')::int AS pending
      FROM fdp_ledger_advance_payments
      WHERE workspace_id = ? AND company_id = ? AND competence = ?`)
      .bind(workspace.id, companyId, competence).first<Record<string, unknown>>();

    return Response.json({
      competence,
      scheduled: Number(total?.total ?? 0),
      pending: Number(total?.pending ?? 0),
      skipped: semRegra,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
