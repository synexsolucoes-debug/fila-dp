import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { confirmationKey, fromCents, isCompetence, toCents } from "@/lib/payroll-ledger";

/**
 * Confirmar o desconto — e desfazê-lo.
 *
 * Esta é a única porta por onde "foi descontado" entra no sistema. A competência
 * ter passado não desconta, a exportação não desconta, fechar o mês não
 * desconta. Alguém confirma, com nome, hora e referência, ou não aconteceu.
 *
 * ## Três operações, três permissões
 *
 * * `confirmation` — `ledger.confirm`. Registra o que a folha efetivamente
 *   descontou. Aceita valor menor que o previsto: desconto parcial é normal, e
 *   o saldo continua visível sem ser recobrado sozinho.
 * * `authorized_override` — `ledger.override`. O "ajuste explicitamente
 *   autorizado e documentado": desconta acima do saldo da parcela, com
 *   justificativa obrigatória. É a única forma de ultrapassar o previsto, e o
 *   trigger do banco recusa qualquer outra.
 * * `reversal` — `ledger.reverse`. Corrige por estorno rastreável. A linha
 *   original permanece; nada é apagado.
 *
 * ## Por que a chave de idempotência é determinística
 *
 * A mesma pessoa confirmando a mesma parcela, na mesma competência, pelo mesmo
 * valor produz a mesma chave — e o índice único do banco deixa passar a
 * primeira. É o que sobrevive a um duplo clique e a dois analistas conferindo
 * o mesmo lote ao mesmo tempo. Quando a chave colide, a resposta é 200 com o
 * registro que já existia, e não um erro: a segunda tentativa **quis** o mesmo
 * efeito, e ele já aconteceu.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);

    const kind = cleanText(body.kind, 30) || "confirmation";
    if (!["confirmation", "authorized_override", "reversal"].includes(kind)) {
      throw ApiError.badRequest("Tipo de confirmação inválido.", "LEDGER_CONFIRMATION_KIND");
    }
    if (kind === "confirmation") requireNamedCapability(workspace, "ledger.confirm", "confirmar um desconto");
    if (kind === "authorized_override") requireNamedCapability(workspace, "ledger.override", "autorizar desconto acima do saldo");
    if (kind === "reversal") requireNamedCapability(workspace, "ledger.reverse", "estornar um desconto confirmado");

    const installment = await d1.prepare(`SELECT installment.id, installment.entry_id, installment.company_id,
        installment.competence, installment.planned_amount, installment.discounted_amount, installment.status,
        installment.batch_id, entry.status AS entry_status, entry.title AS entry_title
      FROM fdp_ledger_installments installment
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
      WHERE installment.workspace_id = ? AND installment.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!installment) throw ApiError.notFound("Parcela não encontrada.", "LEDGER_INSTALLMENT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(installment.company_id));

    /* Confirmar desconto de um lançamento que ninguém aprovou seria descontar
       do salário de alguém sem autorização registrada. */
    if (!["approved", "active", "suspended"].includes(String(installment.entry_status))) {
      throw ApiError.badRequest(
        "Este lançamento ainda não foi aprovado. Um desconto só é confirmado depois que a obrigação foi autorizada.",
        "LEDGER_ENTRY_NOT_APPROVED",
      );
    }

    const competence = cleanText(body.competence, 7) || String(installment.competence);
    if (!isCompetence(competence)) {
      throw ApiError.badRequest("Informe a competência no formato AAAA-MM.", "INVALID_LEDGER_COMPETENCE");
    }

    let amountCents: number;
    try {
      amountCents = toCents(typeof body.amount === "number" || typeof body.amount === "string" ? body.amount : "");
    } catch {
      throw ApiError.badRequest("Informe o valor como um número em reais.", "INVALID_LEDGER_AMOUNT");
    }
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw ApiError.badRequest("Informe um valor maior que zero.", "INVALID_LEDGER_AMOUNT");
    }

    const justification = cleanText(body.justification, 1000);
    if (kind !== "confirmation" && justification.trim().length < 5) {
      throw ApiError.badRequest(
        kind === "reversal"
          ? "Informe o motivo do estorno."
          : "Informe a autorização que permite descontar acima do saldo.",
        "LEDGER_JUSTIFICATION_REQUIRED",
      );
    }

    const planned = toCents(Number(installment.planned_amount ?? 0));
    const discounted = toCents(Number(installment.discounted_amount ?? 0));

    if (kind === "reversal" && amountCents > discounted) {
      throw ApiError.badRequest(
        `O estorno é maior do que os ${fromCents(discounted).toFixed(2)} já confirmados nesta parcela.`,
        "LEDGER_REVERSAL_TOO_LARGE",
      );
    }
    /* O limite existe no trigger; aqui ele vira o número que falta, para a tela
       poder dizer "cabem R$ 50,00" em vez de devolver erro de banco. */
    if (kind === "confirmation" && discounted + amountCents > planned) {
      const livre = Math.max(0, planned - discounted);
      throw ApiError.badRequest(
        livre > 0
          ? `Esta parcela ainda comporta ${fromCents(livre).toFixed(2)}. Para descontar mais, é preciso um ajuste autorizado.`
          : "Esta parcela já está integralmente descontada. Para descontar mais, é preciso um ajuste autorizado.",
        "LEDGER_EXCEEDS_BALANCE",
      );
    }
    if (kind === "authorized_override" && !hasCapability(workspace, "ledger.override")) {
      throw ApiError.forbidden("Você não tem permissão para autorizar desconto acima do saldo.", "CAPABILITY_REQUIRED");
    }

    const signedCents = kind === "reversal" ? -amountCents : amountCents;
    const idempotencyKey = cleanText(body.idempotencyKey, 200) || confirmationKey({
      installmentId: id, competence, amountCents: signedCents, kind,
      batchId: installment.batch_id ? String(installment.batch_id) : "",
    });

    const existing = await d1.prepare(`SELECT id, amount, kind, competence FROM fdp_ledger_confirmations
      WHERE workspace_id = ? AND idempotency_key = ?`)
      .bind(workspace.id, idempotencyKey).first<Record<string, unknown>>();
    if (existing) {
      /* Já aconteceu. Devolver o registro existente é mais honesto que recusar:
         quem repetiu a chamada queria este efeito, e ele está aplicado. */
      return Response.json({ confirmation: existing, deduplicated: true });
    }

    const reversesId = cleanText(body.reversesConfirmationId, 120) || null;
    if (kind === "reversal" && reversesId) {
      const alvo = await d1.prepare(`SELECT id FROM fdp_ledger_confirmations
        WHERE workspace_id = ? AND id = ? AND installment_id = ?`)
        .bind(workspace.id, reversesId, id).first<{ id: string }>();
      if (!alvo) throw ApiError.badRequest("A confirmação a estornar não pertence a esta parcela.", "LEDGER_REVERSAL_TARGET");
    }

    const confirmationId = crypto.randomUUID();
    const source = cleanText(body.source, 20) === "return_import" ? "return_import" : "manual";
    const reference = cleanText(body.reference, 200);
    const requestId = request.headers.get("x-fila-dp-request-id");

    await d1.batch([
      /* O trigger `fdp_ledger_confirmations_apply` toma o lock da parcela e
         recalcula o saldo. Duas confirmações simultâneas são serializadas por
         ele: a segunda enxerga o total da primeira. */
      d1.prepare(`INSERT INTO fdp_ledger_confirmations
        (id, workspace_id, installment_id, entry_id, competence, amount, kind, source, reference,
         justification, reverses_confirmation_id, batch_id, confirmed_by, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(confirmationId, workspace.id, id, installment.entry_id, competence, fromCents(signedCents),
          kind, source, reference, justification, reversesId,
          installment.batch_id ?? null, user.id, idempotencyKey),
      d1.prepare(`INSERT INTO fdp_ledger_events
        (id, workspace_id, entry_id, installment_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, installment.entry_id, id,
          kind === "reversal" ? "reversed" : kind === "authorized_override" ? "override_authorized" : "confirmed",
          justification || `${fromCents(amountCents).toFixed(2)} em ${competence}`,
          JSON.stringify({ amount: fromCents(signedCents), competence, reference }), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: kind === "reversal" ? "ledger_confirmation.reversed" : "ledger_confirmation.created",
        entityType: "ledger_installment", entityId: id,
        before: { discountedAmount: fromCents(discounted) },
        after: { discountedAmount: fromCents(discounted + signedCents) },
        metadata: { kind, competence, reference, entryId: String(installment.entry_id) },
        requestId,
      }),
    ]);

    const updated = await d1.prepare(`SELECT id, planned_amount, discounted_amount, status
      FROM fdp_ledger_installments WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();

    /* O lançamento vira `settled` quando nada mais resta a descontar. É leitura
       do saldo, não um estado digitado — e por isso é recalculado aqui em vez
       de ser marcado à mão por quem confirmou a última parcela. */
    await d1.prepare(`UPDATE fdp_ledger_entries entry SET status = 'settled', updated_at = now()
      WHERE entry.workspace_id = ? AND entry.id = ? AND entry.status = 'active'
        AND entry.modality <> 'recurring'
        AND NOT EXISTS (
          SELECT 1 FROM fdp_ledger_installments open_installment
          WHERE open_installment.workspace_id = entry.workspace_id
            AND open_installment.entry_id = entry.id
            AND open_installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
            AND open_installment.discounted_amount < open_installment.planned_amount
        )`).bind(workspace.id, installment.entry_id).run();

    return Response.json({
      confirmation: { id: confirmationId, kind, amount: fromCents(signedCents), competence },
      installment: updated,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
