import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import {
  confidenceBand, originLabel, proposalLabel, summarizePayload, triageResolveHref,
  uncertaintyExplanation, type TriageItem,
} from "@/lib/triage";
import { cleanText } from "@/lib/registrations";

/**
 * Central de Triagem (§13 a §19).
 *
 * Uma leitura só sobre as duas filas de incerteza que já existem: as propostas
 * de agente que o motor determinístico não autorizou, e as movimentações que a
 * leitura do Teams reconheceu sem os dados obrigatórios. Nada é migrado, nada é
 * fundido — cada item continua sendo resolvido pela rota dona dele (§17).
 *
 * ## Escopo
 *
 * O recorte por empresa é feito **no SQL** (§50): uma proposta que aponta para
 * uma demanda de empresa fora do alcance da pessoa não sai do banco. Item ainda
 * sem empresa identificada continua aparecendo para quem tem a capacidade — é
 * exatamente o que falta descobrir, e escondê-lo o tornaria invisível para
 * todo mundo.
 *
 * ## Paginação
 *
 * Cursor pelo instante de criação, e não página numerada: a fila cresce por
 * cima, e a "página 2" de um minuto atrás não é a página 2 de agora. Como são
 * duas origens, cada uma é consultada com o mesmo cursor e o corte final é
 * feito depois da mesclagem — o cursor devolvido é o instante do último item
 * realmente entregue.
 */

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

const text = (value: unknown) => (value == null ? "" : String(value));

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.status.read", "consultar a triagem");

    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(MAX_PAGE, Number(url.searchParams.get("limite")) || DEFAULT_PAGE));
    const cursor = cleanText(url.searchParams.get("cursor"), 40);
    const origin = cleanText(url.searchParams.get("origem"), 40);
    const resolved = url.searchParams.get("situacao") === "resolvidos";
    const mine = url.searchParams.get("escopo") === "meus";

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    /* O recorte por empresa entra como **parâmetro**, e não como um `IN` montado
       por concatenação: a consulta fica com texto fixo, e texto fixo pode ser
       preparado contra o schema real na verificação de SQL. Uma consulta que só
       existe montada em tempo de execução é uma consulta que ninguém confere
       até um cliente encontrá-la quebrada. */
    const unrestricted = access.unrestricted;
    const companyList = JSON.stringify(unrestricted ? [] : [...access.companyIds]);

    const proposalParameters: unknown[] = [
      workspace.id,
      resolved, resolved,
      unrestricted, companyList,
      origin, origin, origin,
      mine ? user.id : "", mine ? user.id : "",
      cursor, cursor, limit + 1,
    ];

    const [proposals, suggestions, counts] = await Promise.all([
      d1.prepare(`SELECT p.id, p.agent_key, p.agent_version, p.event_name, p.entity_type, p.entity_id,
            p.process_instance_id, p.current_step_id, p.proposed_action, p.proposed_step_id, p.reason,
            p.confidence, p.evidence_refs_json, p.status, p.decision_code, p.decision_reason,
            p.resolution_note, p.result_type, p.result_id, p.resolved_at, p.assigned_to, p.assignment_note,
            p.created_at,
            resolver.name AS resolved_by_name, assignee.name AS assigned_to_name,
            card.title AS card_title, card.company_id, card.current_step_id AS card_step,
            company.trade_name, company.legal_name
          FROM fdp_agent_proposals p
          LEFT JOIN fdp_users resolver ON resolver.id = p.resolved_by
          LEFT JOIN fdp_users assignee ON assignee.id = p.assigned_to
          LEFT JOIN fdp_cards card ON card.workspace_id = p.workspace_id AND card.id = p.process_instance_id
          LEFT JOIN fdp_companies company ON company.workspace_id = p.workspace_id AND company.id = card.company_id
        WHERE p.workspace_id = ?
          AND ((?::boolean AND p.status IN ('applied', 'rejected', 'discarded'))
            OR (NOT ?::boolean AND p.status IN ('pending_triage', 'suggested')))
          -- Sem nenhuma empresa liberada sobra o que ainda não tem empresa, que
          -- é justamente o que a triagem existe para identificar.
          AND (?::boolean OR p.process_instance_id IS NULL OR EXISTS (
            SELECT 1 FROM fdp_cards c
            WHERE c.workspace_id = p.workspace_id AND c.id = p.process_instance_id
              AND (c.company_id IS NULL OR c.company_id IN (SELECT jsonb_array_elements_text(?::jsonb)))))
          AND (? = '' OR p.agent_key = ? OR (? = 'sankhya_browser' AND p.agent_key = 'sankhya'))
          AND (? = '' OR p.assigned_to = ?)
          -- NULLIF antes do cast: '' não é um instante, e a conversão falha mesmo
          -- com a condição à esquerda verdadeira.
          AND (NULLIF(?, '') IS NULL OR p.created_at < NULLIF(?, '')::timestamptz)
        ORDER BY p.created_at DESC LIMIT ?`)
        .bind(...proposalParameters).all<Record<string, unknown>>(),

      /* A sugestão do Teams não tem responsável nem empresa: ela nasce de uma
         mensagem. Quando o recorte pessoal está ligado, ela sai da lista em vez
         de aparecer sem dono — "meus itens" precisa significar o que diz. */
      mine || (origin && origin !== "teams")
        ? Promise.resolve({ results: [] as Record<string, unknown>[] })
        : d1.prepare(`SELECT s.id, s.integration_id, s.movement_kind, s.status, s.confidence,
              s.employee_name, s.employee_id, s.previous_salary_cents, s.new_salary_cents,
              s.previous_role, s.new_role, s.effective_date, s.requested_by_name, s.team_name,
              s.channel_name, s.message_url, s.missing_fields_json, s.card_id, s.created_at
            FROM fdp_movement_suggestions s
          WHERE s.workspace_id = ?
            AND ((?::boolean AND s.status IN ('confirmed', 'rejected', 'superseded'))
              OR (NOT ?::boolean AND s.status = 'pending'))
            AND (NULLIF(?, '') IS NULL OR s.created_at < NULLIF(?, '')::timestamptz)
          ORDER BY s.created_at DESC LIMIT ?`)
          .bind(workspace.id, resolved, resolved, cursor, cursor, limit + 1).all<Record<string, unknown>>(),

      /* Contadores agregados no servidor (§11): calcular no navegador exigiria
         trazer a fila inteira só para contá-la. */
      d1.prepare(`SELECT
            (SELECT count(*)::int FROM fdp_agent_proposals a
              WHERE a.workspace_id = ? AND a.status = 'pending_triage') AS pending_triage,
            (SELECT count(*)::int FROM fdp_agent_proposals a
              WHERE a.workspace_id = ? AND a.status = 'suggested') AS suggested,
            (SELECT count(*)::int FROM fdp_agent_proposals a
              WHERE a.workspace_id = ? AND a.assigned_to = ? AND a.status IN ('pending_triage', 'suggested')) AS mine,
            (SELECT count(*)::int FROM fdp_movement_suggestions m
              WHERE m.workspace_id = ? AND m.status = 'pending') AS movements`)
        .bind(workspace.id, workspace.id, workspace.id, user.id, workspace.id)
        .first<Record<string, unknown>>(),
    ]);

    const items: TriageItem[] = [
      ...proposals.results.slice(0, limit + 1).map((row): TriageItem => {
        const code = text(row.decision_code);
        const agentKey = text(row.agent_key);
        const evidence = Array.isArray(row.evidence_refs_json) ? row.evidence_refs_json.map(String) : [];
        const resolvedAt = text(row.resolved_at);
        return {
          id: `agent_proposal:${text(row.id)}`,
          source: "agent_proposal",
          sourceId: text(row.id),
          origin: agentKey,
          originLabel: originLabel(agentKey),
          eventName: text(row.event_name),
          title: text(row.card_title) || text(row.entity_id) || "Entrada não identificada",
          proposal: proposalLabel(text(row.proposed_action)),
          status: text(row.status),
          confidence: confidenceBand(Number(row.confidence ?? 0) / 100),
          uncertainty: uncertaintyExplanation(code, text(row.decision_reason)),
          likely: {
            employeeId: text(row.entity_type) === "employee" ? text(row.entity_id) : "",
            employeeName: "",
            companyId: text(row.company_id),
            companyName: text(row.trade_name) || text(row.legal_name),
            processId: text(row.process_instance_id),
            processStep: text(row.card_step) || text(row.current_step_id),
          },
          fields: summarizePayload({
            agente: `${originLabel(agentKey)}${text(row.agent_version) ? ` ${text(row.agent_version)}` : ""}`,
            evento: text(row.event_name),
            entidade: text(row.entity_type),
            identificadorNaOrigem: text(row.entity_id),
            acaoProposta: proposalLabel(text(row.proposed_action)),
            etapaDestino: text(row.proposed_step_id),
            leitura: text(row.reason),
            encaminhamento: text(row.assignment_note),
          }),
          evidenceIds: evidence,
          resolveHref: triageResolveHref({ source: "agent_proposal", sourceId: text(row.id) }),
          createdAt: text(row.created_at),
          resolution: resolvedAt ? {
            decidedBy: text(row.resolved_by_name),
            decidedAt: resolvedAt,
            decision: text(row.status),
            note: text(row.resolution_note),
            resultType: text(row.result_type),
            resultId: text(row.result_id),
            failure: "",
          } : null,
        };
      }),
      ...suggestions.results.slice(0, limit + 1).map((row): TriageItem => {
        const missing = Array.isArray(row.missing_fields_json) ? row.missing_fields_json.map(String) : [];
        const kind = text(row.movement_kind);
        const resolvedStatus = text(row.status);
        return {
          id: `movement_suggestion:${text(row.id)}`,
          source: "movement_suggestion",
          sourceId: text(row.id),
          origin: "teams",
          originLabel: originLabel("teams"),
          eventName: kind === "salary_change" ? "movement.salary_change" : "movement.role_change",
          title: text(row.employee_name) || "Colaborador não identificado",
          proposal: kind === "salary_change" ? "Abrir movimentação de alteração salarial" : "Abrir movimentação de cargo",
          status: resolvedStatus,
          confidence: confidenceBand(Number(row.confidence ?? 0) / 100),
          uncertainty: uncertaintyExplanation(missing.length ? "MOVEMENT_INCOMPLETE" : "AGENT_NEEDS_CONFIRMATION"),
          likely: {
            employeeId: text(row.employee_id),
            employeeName: text(row.employee_name),
            companyId: "", companyName: "",
            processId: text(row.card_id), processStep: "",
          },
          fields: summarizePayload({
            solicitante: text(row.requested_by_name),
            equipe: [text(row.team_name), text(row.channel_name)].filter(Boolean).join(" › "),
            employeeName: text(row.employee_name),
            previousSalary: row.previous_salary_cents == null ? "" : (Number(row.previous_salary_cents) / 100).toFixed(2),
            newSalary: row.new_salary_cents == null ? "" : (Number(row.new_salary_cents) / 100).toFixed(2),
            previousRole: text(row.previous_role),
            newRole: text(row.new_role),
            effectiveDate: text(row.effective_date),
            faltando: missing.join(", "),
          }),
          evidenceIds: text(row.message_url) ? [text(row.message_url)] : [],
          resolveHref: triageResolveHref({ source: "movement_suggestion", sourceId: text(row.id) }),
          createdAt: text(row.created_at),
          resolution: resolvedStatus === "pending" ? null : {
            decidedBy: "", decidedAt: "", decision: resolvedStatus, note: "",
            resultType: text(row.card_id) ? "card" : "", resultId: text(row.card_id), failure: "",
          },
        };
      }),
    ].sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));

    const page = items.slice(0, limit);

    return Response.json({
      items: page,
      counts: {
        pendingTriage: Number(counts?.pending_triage ?? 0),
        suggested: Number(counts?.suggested ?? 0),
        mine: Number(counts?.mine ?? 0),
        movements: Number(counts?.movements ?? 0),
        total: Number(counts?.pending_triage ?? 0) + Number(counts?.suggested ?? 0) + Number(counts?.movements ?? 0),
      },
      nextCursor: items.length > limit ? (page[page.length - 1]?.createdAt ?? "") : "",
      permissions: {
        resolve: hasCapability(workspace, "integrations.reconcile"),
        confirmMovement: hasCapability(workspace, "cards.write"),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
