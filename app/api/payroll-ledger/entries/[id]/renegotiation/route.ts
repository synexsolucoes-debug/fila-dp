import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { fromCents, isCompetence, planInstallments, toCents } from "@/lib/payroll-ledger";
import { MAX_INSTALLMENTS } from "@/lib/payroll-ledger-service";

/**
 * Renegociar o saldo remanescente.
 *
 * Renegociar **não** é editar o lançamento. O original fica: com as parcelas
 * que já foram confirmadas, com o valor que foi acordado na época e com o
 * histórico inteiro. O que nasce é um lançamento novo, apontando para ele por
 * `parent_entry_id`, e cobrindo **apenas o que ainda falta descontar**.
 *
 * Reescrever o total do original seria mais simples e seria errado: o
 * colaborador assinou um acordo de R$ 2.000,00, pagou R$ 800,00, e o documento
 * que comprova isso não pode virar retroativamente um acordo de R$ 1.200,00.
 *
 * O saldo é recalculado aqui, dentro da mesma leitura que decide o valor — não
 * vem do corpo da requisição. Aceitar um saldo informado pelo navegador seria
 * deixar o cliente escolher quanto a pessoa ainda deve.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.manage", "renegociar o saldo de um lançamento");

    const entry = await d1.prepare(`SELECT entry.*,
        COALESCE(balance.planned_total, 0) AS planned_total,
        COALESCE(balance.discounted_total, 0) AS discounted_total
      FROM fdp_ledger_entries entry
      LEFT JOIN LATERAL (
        SELECT
          SUM(CASE WHEN installment.status IN ('canceled', 'rescheduled', 'skipped')
            THEN installment.discounted_amount ELSE installment.planned_amount END) AS planned_total,
          SUM(installment.discounted_amount) AS discounted_total
        FROM fdp_ledger_installments installment
        WHERE installment.workspace_id = entry.workspace_id AND installment.entry_id = entry.id
      ) balance ON true
      WHERE entry.workspace_id = ? AND entry.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!entry) throw ApiError.notFound("Lançamento não encontrado.", "LEDGER_ENTRY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(entry.company_id));

    if (String(entry.modality) === "recurring") {
      throw ApiError.badRequest(
        "Um desconto recorrente não tem saldo a renegociar: altere o valor com vigência futura ou encerre a vigência.",
        "LEDGER_RECURRING_NOT_RENEGOTIABLE",
      );
    }
    if (!["approved", "active", "suspended"].includes(String(entry.status))) {
      throw ApiError.badRequest("Só um lançamento em desconto pode ser renegociado.", "LEDGER_NOT_RENEGOTIABLE");
    }

    const plannedCents = toCents(Number(entry.planned_total ?? 0));
    const discountedCents = toCents(Number(entry.discounted_total ?? 0));
    const remainingCents = plannedCents - discountedCents;
    if (remainingCents <= 0) {
      throw ApiError.badRequest("Este lançamento não tem saldo a renegociar.", "LEDGER_NO_REMAINING_BALANCE");
    }

    const installmentCount = Math.trunc(Number(body.installmentCount ?? 0));
    if (!Number.isInteger(installmentCount) || installmentCount < 1) {
      throw ApiError.badRequest("Informe em quantas parcelas o saldo será renegociado.", "LEDGER_INSTALLMENTS_REQUIRED");
    }
    if (installmentCount > MAX_INSTALLMENTS) {
      throw ApiError.badRequest(`O módulo aceita até ${MAX_INSTALLMENTS} parcelas por lançamento.`, "LEDGER_INSTALLMENTS_LIMIT");
    }
    if (installmentCount > remainingCents) {
      throw ApiError.badRequest("O saldo não se divide na quantidade de parcelas informada.", "LEDGER_INSTALLMENTS_TOO_MANY");
    }

    const firstCompetence = cleanText(body.firstCompetence, 7);
    if (!isCompetence(firstCompetence)) {
      throw ApiError.badRequest("Informe a primeira competência do acordo no formato AAAA-MM.", "INVALID_LEDGER_COMPETENCE");
    }
    const reason = cleanText(body.reason, 1000);
    if (reason.trim().length < 5) {
      throw ApiError.badRequest("Informe o motivo da renegociação.", "LEDGER_JUSTIFICATION_REQUIRED");
    }

    const novoId = crypto.randomUUID();
    const parcelas = planInstallments({ totalCents: remainingCents, count: installmentCount, firstCompetence });
    const requestId = request.headers.get("x-fila-dp-request-id");
    const titulo = cleanText(body.title, 180) || `Renegociação — ${String(entry.title)}`;

    await d1.batch([
      /* O novo lançamento nasce já em desconto: a renegociação é um acordo
         decidido agora, por quem tem `ledger.manage`, sobre uma obrigação que
         já passou por aprovação uma vez. */
      d1.prepare(`INSERT INTO fdp_ledger_entries
        (id, workspace_id, company_id, employee_id, provider_id, employment_type_snapshot,
         department_id, department_label, unit_label, operation_label,
         requester_area_id, responsible_area_id, category, title, description, reason,
         occurred_on, requested_on, requested_by, responsible_user_id,
         total_amount, modality, installment_count, first_competence, expected_end_competence,
         settlement_target, status, movement_id, origin_type, origin_id, parent_entry_id,
         details_json, approved_by, approved_at, created_by, updated_by)
        SELECT ?, workspace_id, company_id, employee_id, provider_id, employment_type_snapshot,
          department_id, department_label, unit_label, operation_label,
          requester_area_id, responsible_area_id, category, ?, description, ?,
          occurred_on, CURRENT_DATE, ?, responsible_user_id,
          ?, 'installments', ?, ?, ?,
          settlement_target, 'active', NULL, 'renegotiation', ?, id,
          details_json, ?, now(), ?, ?
        FROM fdp_ledger_entries WHERE workspace_id = ? AND id = ?`)
        .bind(novoId, titulo, reason, user.id,
          fromCents(remainingCents), installmentCount, firstCompetence, parcelas.at(-1)?.competence ?? firstCompetence,
          id, user.id, user.id, user.id, workspace.id, id),
      ...parcelas.map((parte) => d1.prepare(`INSERT INTO fdp_ledger_installments
        (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, novoId, entry.company_id,
          parte.number, parte.totalCount, parte.competence, fromCents(parte.plannedCents))),
      /* As parcelas do original que ainda não foram tocadas saem da programação.
         As confirmadas ficam exatamente como estão — o trigger recusaria mexer
         nelas, e é essa recusa que preserva o que já foi descontado. */
      d1.prepare(`UPDATE fdp_ledger_installments SET status = 'canceled', note = ?, updated_at = now()
        WHERE workspace_id = ? AND entry_id = ? AND discounted_amount = 0
          AND status NOT IN ('canceled', 'discounted')`)
        .bind(`Renegociado em ${new Date().toISOString().slice(0, 10)}`, workspace.id, id),
      d1.prepare(`UPDATE fdp_ledger_entries SET status = 'renegotiated', updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND status IN ('approved', 'active', 'suspended')`)
        .bind(user.id, workspace.id, id),
      d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'renegotiated', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, reason,
          JSON.stringify({ remainingAmount: fromCents(remainingCents), newEntryId: novoId, installmentCount }), user.id),
      d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'created', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, novoId, titulo,
          JSON.stringify({ parentEntryId: id, totalAmount: fromCents(remainingCents), installmentCount }), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_entry.renegotiated", entityType: "ledger_entry", entityId: id,
        before: { status: String(entry.status), totalAmount: Number(entry.total_amount ?? 0) },
        after: { status: "renegotiated", newEntryId: novoId, renegotiatedAmount: fromCents(remainingCents) },
        metadata: { installmentCount, firstCompetence, reason }, requestId,
      }),
    ]);

    return Response.json({
      entry: {
        id: novoId, parentEntryId: id, totalAmount: fromCents(remainingCents),
        installmentCount, firstCompetence, status: "active",
      },
      /* O que foi preservado é a informação que quem renegocia precisa
         confirmar: nada do que já foi descontado entrou no novo acordo. */
      preserved: { discountedAmount: fromCents(discountedCents) },
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
