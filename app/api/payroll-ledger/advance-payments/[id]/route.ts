import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { competenceDistance, fromCents, isCompetence, toCents } from "@/lib/payroll-ledger";

/**
 * Autorizar, pagar, cancelar e informar a base que faltava.
 *
 * ## "Pago ao colaborador" não é "descontado dele"
 *
 * Registrar o pagamento cria **uma** parcela de recuperação na competência
 * escolhida — e só uma, porque a chave `(entry_id, number)` é única e o número
 * é derivado da distância entre a primeira competência do lançamento e a da
 * recuperação. Pagar duas vezes o mesmo mês não cria duas dívidas; a segunda
 * tentativa esbarra no índice.
 *
 * A parcela nasce **programada**, nunca confirmada: o dinheiro saiu para a
 * pessoa, mas ainda não voltou. Quem confirma a recuperação é a conferência da
 * competência, pela porta de sempre.
 *
 * ## Suspender uma competência é cancelar com motivo
 *
 * Não existe "pular" silencioso. Cancelar exige motivo escrito, e o registro
 * fica — porque "por que o vale de julho não saiu?" é uma pergunta que alguém
 * vai fazer em setembro.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);

    const acao = cleanText(body.action, 20);
    if (!["authorize", "pay", "cancel", "resolve_pending"].includes(acao)) {
      throw ApiError.badRequest("Informe a ação sobre o adiantamento.", "LEDGER_ACTION_REQUIRED");
    }
    /* Autorizar e informar a base são preparação; pagar move dinheiro. Só o
       pagamento exige `ledger.pay`. */
    if (acao === "pay") requireNamedCapability(workspace, "ledger.pay", "registrar o pagamento de um adiantamento");
    else requireNamedCapability(workspace, "ledger.manage", "tratar a programação de um adiantamento");

    const payment = await d1.prepare(`SELECT payment.*, entry.first_competence, entry.modality,
        entry.title AS entry_title, entry.status AS entry_status
      FROM fdp_ledger_advance_payments payment
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = payment.workspace_id AND entry.id = payment.entry_id
      WHERE payment.workspace_id = ? AND payment.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!payment) throw ApiError.notFound("Adiantamento não encontrado.", "LEDGER_ADVANCE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(payment.company_id));

    const atual = String(payment.status);
    if (atual === "paid" && acao !== "cancel") {
      throw ApiError.badRequest("Este adiantamento já foi pago.", "LEDGER_ADVANCE_ALREADY_PAID");
    }
    if (atual === "canceled") {
      throw ApiError.badRequest("Este adiantamento foi cancelado nesta competência.", "LEDGER_ADVANCE_CANCELED");
    }

    const requestId = request.headers.get("x-fila-dp-request-id");

    if (acao === "cancel") {
      const motivo = cleanText(body.cancelReason, 500);
      if (motivo.trim().length < 5) {
        throw ApiError.badRequest("Informe o motivo de suspender o adiantamento nesta competência.", "LEDGER_JUSTIFICATION_REQUIRED");
      }
      if (atual === "paid") {
        throw ApiError.badRequest(
          "Este adiantamento já foi pago. Cancelar não devolve o dinheiro: trate a recuperação pela parcela correspondente.",
          "LEDGER_ADVANCE_ALREADY_PAID",
        );
      }
      await d1.batch([
        d1.prepare(`UPDATE fdp_ledger_advance_payments SET status = 'canceled', cancel_reason = ?, updated_at = now()
          WHERE workspace_id = ? AND id = ? AND status <> 'paid'`).bind(motivo, workspace.id, id),
        d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
          VALUES (?, ?, ?, 'advance_canceled', ?, ?::jsonb, ?)`)
          .bind(crypto.randomUUID(), workspace.id, payment.entry_id, motivo,
            JSON.stringify({ competence: String(payment.competence) }), user.id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "ledger_advance.canceled", entityType: "ledger_advance_payment", entityId: id,
          before: { status: atual }, after: { status: "canceled" },
          metadata: { reason: motivo, competence: String(payment.competence) }, requestId,
        }),
      ]);
      return Response.json({ payment: { id, status: "canceled", cancelReason: motivo } });
    }

    if (acao === "resolve_pending") {
      /* A base salarial que faltava. Sem ela o percentual não calculava, e o
         produto preferiu pendência a um pagamento de R$ 0,00. */
      let cents: number;
      try {
        cents = toCents(typeof body.approvedAmount === "number" || typeof body.approvedAmount === "string" ? body.approvedAmount : "");
      } catch {
        throw ApiError.badRequest("Informe o valor do adiantamento em reais.", "INVALID_LEDGER_AMOUNT");
      }
      if (!(cents > 0)) throw ApiError.badRequest("Informe um valor maior que zero.", "INVALID_LEDGER_AMOUNT");

      await d1.batch([
        d1.prepare(`UPDATE fdp_ledger_advance_payments SET approved_amount = ?, status = 'scheduled',
            pending_reason = '', updated_at = now()
          WHERE workspace_id = ? AND id = ? AND status = 'pending_data'`)
          .bind(fromCents(cents), workspace.id, id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "ledger_advance.resolved", entityType: "ledger_advance_payment", entityId: id,
          before: { status: atual, approvedAmount: Number(payment.approved_amount ?? 0) },
          after: { status: "scheduled", approvedAmount: fromCents(cents) }, requestId,
        }),
      ]);
      return Response.json({ payment: { id, status: "scheduled", approvedAmount: fromCents(cents) } });
    }

    if (acao === "authorize") {
      if (atual !== "scheduled") {
        throw ApiError.badRequest(
          atual === "pending_data"
            ? "Informe o valor do adiantamento antes de autorizar."
            : "Só um adiantamento programado pode ser autorizado.",
          "LEDGER_ADVANCE_NOT_SCHEDULED",
        );
      }
      await d1.batch([
        d1.prepare(`UPDATE fdp_ledger_advance_payments SET status = 'authorized', authorized_by = ?, updated_at = now()
          WHERE workspace_id = ? AND id = ? AND status = 'scheduled'`).bind(user.id, workspace.id, id),
        d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
          VALUES (?, ?, ?, 'advance_authorized', ?, ?::jsonb, ?)`)
          .bind(crypto.randomUUID(), workspace.id, payment.entry_id,
            `Autorizado para ${String(payment.competence)}`, JSON.stringify({}), user.id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "ledger_advance.authorized", entityType: "ledger_advance_payment", entityId: id,
          before: { status: atual }, after: { status: "authorized" }, requestId,
        }),
      ]);
      return Response.json({ payment: { id, status: "authorized" } });
    }

    // acao === "pay"
    if (atual !== "authorized") {
      throw ApiError.badRequest("Um adiantamento é pago depois de autorizado.", "LEDGER_ADVANCE_NOT_AUTHORIZED");
    }
    let paidCents: number;
    try {
      paidCents = toCents(typeof body.paidAmount === "number" || typeof body.paidAmount === "string" ? body.paidAmount : "");
    } catch {
      throw ApiError.badRequest("Informe o valor pago em reais.", "INVALID_LEDGER_AMOUNT");
    }
    if (!(paidCents > 0)) throw ApiError.badRequest("Informe o valor efetivamente pago.", "INVALID_LEDGER_AMOUNT");
    const paidOn = cleanText(body.actualPaymentDate, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
      throw ApiError.badRequest("Informe a data em que o pagamento saiu, no formato AAAA-MM-DD.", "INVALID_LEDGER_DATE");
    }

    /* Em qual competência esse valor volta. O padrão é a própria — o vale de
       setembro é descontado na folha de setembro —, mas o campo existe porque
       nem toda empresa faz assim. */
    const recoveryCompetence = cleanText(body.recoveryCompetence, 7) || String(payment.competence);
    if (!isCompetence(recoveryCompetence)) {
      throw ApiError.badRequest("Informe a competência da recuperação no formato AAAA-MM.", "INVALID_LEDGER_COMPETENCE");
    }

    /* O número da parcela sai da distância entre a primeira competência do
       lançamento e a da recuperação. É determinístico: duas tentativas de pagar
       o mesmo mês produzem o mesmo número, e o índice único
       `(workspace, entry, number)` deixa passar uma. É isto que impede duas
       dívidas pelo mesmo adiantamento. */
    const numero = competenceDistance(String(payment.first_competence), recoveryCompetence) + 1;
    if (numero < 1) {
      throw ApiError.badRequest(
        "A competência da recuperação é anterior ao início do adiantamento.",
        "LEDGER_RECOVERY_BEFORE_START",
      );
    }
    const proof = cleanText(body.proofObjectKey, 500);

    await d1.batch([
      d1.prepare(`UPDATE fdp_ledger_advance_payments
        SET status = 'paid', paid_amount = ?, actual_payment_date = ?, paid_by = ?,
            proof_object_key = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND status = 'authorized'`)
        .bind(fromCents(paidCents), paidOn, user.id, proof, workspace.id, id),
      /* A recuperação: uma parcela programada, nunca confirmada. O dinheiro saiu
         para a pessoa; voltar é outro fato, e ele tem porta própria. */
      d1.prepare(`INSERT INTO fdp_ledger_installments
        (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount, note)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT (workspace_id, entry_id, number) DO NOTHING`)
        .bind(crypto.randomUUID(), workspace.id, payment.entry_id, payment.company_id,
          numero, recoveryCompetence, fromCents(paidCents),
          `Recuperação do adiantamento pago em ${paidOn}`),
      d1.prepare(`INSERT INTO fdp_ledger_events
        (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'advance_paid', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, payment.entry_id,
          `Pago ${fromCents(paidCents).toFixed(2)} em ${paidOn}`,
          JSON.stringify({ competence: String(payment.competence), recoveryCompetence, installmentNumber: numero }), user.id),
      /* O lançamento entra em desconto assim que existe algo a recuperar. */
      d1.prepare(`UPDATE fdp_ledger_entries SET status = 'active', updated_at = now()
        WHERE workspace_id = ? AND id = ? AND status = 'approved'`)
        .bind(workspace.id, payment.entry_id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_advance.paid", entityType: "ledger_advance_payment", entityId: id,
        before: { status: atual, approvedAmount: Number(payment.approved_amount ?? 0) },
        after: { status: "paid", paidAmount: fromCents(paidCents), actualPaymentDate: paidOn },
        metadata: { recoveryCompetence, installmentNumber: numero, entryId: String(payment.entry_id) },
        requestId,
      }),
    ]);

    const recuperacao = await d1.prepare(`SELECT id, number, competence, planned_amount, discounted_amount, status
      FROM fdp_ledger_installments
      WHERE workspace_id = ? AND entry_id = ? AND number = ?`)
      .bind(workspace.id, payment.entry_id, numero).first<Record<string, unknown>>();

    return Response.json({
      payment: { id, status: "paid", paidAmount: fromCents(paidCents), actualPaymentDate: paidOn },
      /* A tela mostra os dois lados: o que saiu e o que ainda precisa voltar. */
      recovery: recuperacao,
    });
  } catch (error) { return apiError(error); }
}
