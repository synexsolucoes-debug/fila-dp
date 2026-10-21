import { createHash } from "node:crypto";
import { apiError, text, validDate } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { completeIntegrationEvent, recordIntegrationEvent } from "@/lib/integration-events";
import { loadDemandTarget } from "@/lib/teams-integration";
import { authenticateTeamsForm } from "@/lib/teams-forms";
import { preparePortfolioAssignment } from "@/lib/portfolio-assignment";
import { prepareCutoffEvaluation } from "@/lib/dp-cutoff-service";
import { log, requestIdFrom } from "@/lib/observability";

/**
 * Entrada de demanda pelo Teams (Fase 3): o formulário publicado no canal cria
 * a demanda, atribuída pela carteira e conferida contra a regra de corte.
 *
 * Corpo: `submissionId` (identificador da resposta do formulário, para a
 * reentrega não duplicar), `companyCode` (CODEMP) ou `companyId`,
 * `processType`, `title`, `description`, `requestedFor` (AAAA-MM-DD), `area`,
 * `requesterName`. A resposta traz `withinCutoff` e `notice` — o texto que o
 * fluxo mostra ao solicitante quando o pedido chegou fora do prazo.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const { d1, workspaceId, integrationId, config } = await authenticateTeamsForm(request);
    const raw = await request.text();
    if (raw.length > 32 * 1024) return Response.json({ error: "Formulário excede 32 KB." }, { status: 413 });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { throw ApiError.badRequest("JSON inválido.", "TEAMS_FORM_INVALID"); }

    const title = text(body.title, 180);
    const processType = text(body.processType, 40).toUpperCase();
    if (!title || !processType) throw ApiError.badRequest("Informe o título e o tipo de processo.", "TEAMS_FORM_REQUIRED");
    const requestedFor = validDate(body.requestedFor ?? null);
    const companyCode = text(String(body.companyCode ?? ""), 20).replace(/^0+(?=\d)/u, "");
    const companyId = text(body.companyId, 120);
    const company = companyId || companyCode
      ? await d1.prepare(`SELECT id, COALESCE(NULLIF(trade_name, ''), legal_name) AS name FROM fdp_companies
          WHERE workspace_id = ? AND status = 'active' AND (id = ? OR (? <> '' AND ltrim(external_code, '0') = ?)) LIMIT 1`)
        .bind(workspaceId, companyId, companyCode, companyCode).first<{ id: string; name: string }>()
      : null;
    if ((companyId || companyCode) && !company) throw ApiError.badRequest("Empresa não encontrada.", "TEAMS_FORM_COMPANY_NOT_FOUND");

    const event = await recordIntegrationEvent(d1, {
      workspaceId, integrationId, connector: "teams", eventType: "demand_form", source: "webhook",
      externalEventId: text(body.submissionId, 200) || createHash("sha256").update(raw).digest("hex"),
      payloadHash: createHash("sha256").update(raw).digest("hex"),
      payload: { processType, companyId: company?.id ?? "" },
    });
    if (event.kind === "duplicate" && event.event.result_id) {
      const card = await d1.prepare("SELECT within_cutoff FROM fdp_cards WHERE workspace_id = ? AND id = ?").bind(workspaceId, event.event.result_id).first<{ within_cutoff: boolean | null }>();
      return Response.json({ duplicate: true, cardId: event.event.result_id, withinCutoff: card?.within_cutoff ?? null });
    }

    const target = await loadDemandTarget(d1, workspaceId, config);
    const cardId = crypto.randomUUID();
    const area = text(body.area, 120) || "Teams";
    const requester = text(body.requesterName, 120);
    const portfolio = await preparePortfolioAssignment(d1, { workspaceId, cardId, companyId: company?.id ?? null });
    const cutoff = await prepareCutoffEvaluation(d1, {
      workspaceId, cardId, processType, companyId: company?.id ?? null, competence: null, requestedFor,
      areaLabel: area, actor: "SYSTEM", title,
    });
    const description = [text(body.description, 3500), requester ? `Solicitado por ${requester} (${area}) pelo Teams.` : `Solicitado pelo Teams (${area}).`, cutoff.notice]
      .filter(Boolean).join("\n\n");
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_cards (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority,
          position, source_type, created_by, sla_started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal',
          COALESCE((SELECT MAX(position) FROM fdp_cards WHERE list_id = ? AND archived = 0), 0) + 1000, 'integration', 'integracao:teams', CURRENT_TIMESTAMP)`)
        .bind(cardId, workspaceId, target.boardId, target.listId, title, description, company?.id ?? null, company?.name ?? "", processType, target.listId),
      d1.prepare(`INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position) VALUES (?, ?, ?, 'Analisar solicitação', 0, 1000)`)
        .bind(crypto.randomUUID(), workspaceId, cardId),
      ...portfolio.statements,
      ...cutoff.statements,
    ]);
    await completeIntegrationEvent(d1, workspaceId, event.event.id, { status: "processed", resultType: "card", resultId: cardId });
    const responsible = portfolio.resolution.userId
      ? (await d1.prepare("SELECT name FROM fdp_users WHERE id = ?").bind(portfolio.resolution.userId).first<{ name: string }>())?.name ?? ""
      : "";
    log("info", "integration.teams_form_demand", { workspaceId, connectorId: integrationId, requestId }, { cardId, withinCutoff: cutoff.verdict?.within ?? null });
    return Response.json({
      cardId,
      withinCutoff: cutoff.verdict?.within ?? null,
      deadline: cutoff.verdict?.deadline ?? null,
      notice: cutoff.notice || "Pedido recebido dentro do prazo.",
      responsible,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
