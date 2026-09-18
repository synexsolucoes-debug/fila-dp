import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { competenceDistance, isCompetence } from "@/lib/payroll-ledger";

/**
 * Reprogramar, pular e antecipar uma parcela.
 *
 * As três mexem em **quando** o desconto acontece, nunca em quanto já
 * aconteceu. Parcela com confirmação está congelada — o trigger do banco
 * recusa, e aqui a recusa vira uma frase que diz o caminho: estornar primeiro.
 *
 * Pular não é apagar dívida. A parcela pulada sai da programação daquele mês e
 * o valor dela **não** é empurrado para a parcela seguinte: quem decidir
 * recobrar cria uma parcela nova ou renegocia, explicitamente. Empurrar
 * sozinho é como um desconto vira o dobro no mês seguinte sem ninguém ter
 * decidido isso.
 */
const acoes = ["reschedule", "skip", "anticipate", "restore"] as const;
type Acao = typeof acoes[number];

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.reschedule", "reprogramar, pausar ou antecipar uma parcela");

    const acao = cleanText(body.action, 20) as Acao;
    if (!acoes.includes(acao)) {
      throw ApiError.badRequest("Informe se a parcela será reprogramada, pulada, antecipada ou restaurada.", "LEDGER_ACTION_REQUIRED");
    }
    const justification = cleanText(body.justification, 1000);
    if (justification.trim().length < 5) {
      throw ApiError.badRequest("Informe o motivo da alteração da programação.", "LEDGER_JUSTIFICATION_REQUIRED");
    }

    const installment = await d1.prepare(`SELECT installment.id, installment.entry_id, installment.company_id,
        installment.competence, installment.planned_amount, installment.discounted_amount,
        installment.status, installment.number, entry.status AS entry_status
      FROM fdp_ledger_installments installment
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
      WHERE installment.workspace_id = ? AND installment.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!installment) throw ApiError.notFound("Parcela não encontrada.", "LEDGER_INSTALLMENT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(installment.company_id));

    if (Number(installment.discounted_amount ?? 0) !== 0) {
      throw ApiError.badRequest(
        "Esta parcela já teve desconto confirmado. Estorne a confirmação antes de mexer na programação — o histórico do que foi descontado é preservado.",
        "LEDGER_INSTALLMENT_CONFIRMED",
      );
    }

    const atual = String(installment.competence);
    let proximaCompetencia = atual;
    let proximoStatus = String(installment.status);
    let evento: "installment_rescheduled" | "installment_skipped" = "installment_rescheduled";

    if (acao === "skip") {
      proximoStatus = "skipped";
      evento = "installment_skipped";
    } else if (acao === "restore") {
      if (!["skipped", "rescheduled", "canceled"].includes(String(installment.status))) {
        throw ApiError.badRequest("Esta parcela já está na programação.", "LEDGER_INSTALLMENT_ACTIVE");
      }
      proximoStatus = "scheduled";
    } else {
      const alvo = cleanText(body.competence, 7);
      if (!isCompetence(alvo)) {
        throw ApiError.badRequest("Informe a nova competência no formato AAAA-MM.", "INVALID_LEDGER_COMPETENCE");
      }
      const distancia = competenceDistance(atual, alvo);
      if (distancia === 0) {
        throw ApiError.badRequest("A nova competência é a mesma da parcela.", "LEDGER_SAME_COMPETENCE");
      }
      /* Antecipar é mover para trás, reprogramar é mover para frente. Nomear as
         duas separadamente não é firula: elas têm consequências diferentes para
         quem recebe o desconto, e o histórico precisa dizer qual foi. */
      if (acao === "anticipate" && distancia > 0) {
        throw ApiError.badRequest("Antecipar move a parcela para uma competência anterior.", "LEDGER_NOT_ANTICIPATION");
      }
      if (acao === "reschedule" && distancia < 0) {
        throw ApiError.badRequest("Reprogramar move a parcela para uma competência posterior. Para adiantar, use antecipar.", "LEDGER_NOT_RESCHEDULE");
      }
      proximaCompetencia = alvo;
      proximoStatus = "scheduled";
    }

    const requestId = request.headers.get("x-fila-dp-request-id");
    const moveu = acao === "reschedule" || acao === "anticipate";

    await d1.batch([
      /* O `WHERE` repete o saldo zero: entre a leitura e a escrita alguém pode
         ter confirmado a parcela, e o trigger recusaria com erro de banco. Aqui
         o UPDATE simplesmente não pega linha, e a conferência abaixo explica. */
      d1.prepare(`UPDATE fdp_ledger_installments
        SET competence = ?, status = ?, rescheduled_to_competence = ?, note = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND discounted_amount = 0`)
        .bind(proximaCompetencia, proximoStatus, moveu ? proximaCompetencia : null,
          justification, workspace.id, id),
      d1.prepare(`INSERT INTO fdp_ledger_events
        (id, workspace_id, entry_id, installment_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, installment.entry_id, id, evento, justification,
          JSON.stringify({ action: acao, from: atual, to: proximaCompetencia }), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: `ledger_installment.${acao}`, entityType: "ledger_installment", entityId: id,
        before: { competence: atual, status: String(installment.status) },
        after: { competence: proximaCompetencia, status: proximoStatus },
        metadata: { justification, entryId: String(installment.entry_id) }, requestId,
      }),
    ]);

    const aplicado = await d1.prepare(`SELECT id, competence, status, planned_amount, discounted_amount
      FROM fdp_ledger_installments WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (String(aplicado?.competence) !== proximaCompetencia || String(aplicado?.status) !== proximoStatus) {
      throw new ApiError(409, "LEDGER_INSTALLMENT_CHANGED",
        "A parcela mudou enquanto a alteração era aplicada — provavelmente alguém confirmou o desconto. Recarregue e confira.");
    }

    return Response.json({ installment: aplicado });
  } catch (error) { return apiError(error); }
}
