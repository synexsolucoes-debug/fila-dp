import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import {
  agentProposalStatuses, decideAgentProposal, sanitizeAgentProposal, statusForDecision,
} from "@/lib/agent-proposals";
import { isAgentEnabled, readAgentAutomationPolicy } from "@/lib/agent-runtime";
import { prepareDomainEventEnvelope } from "@/lib/outbox";
import { cleanText } from "@/lib/registrations";

/**
 * Propostas de agente: registrar e listar (§17, §19).
 *
 * O `POST` é a **única** porta pela qual um agente fala com o domínio. Ele não
 * executa nada: registra a proposta, o motor determinístico decide, e a decisão
 * fica gravada com o código que a explica. Se a decisão for `execute`, quem
 * aplica é o serviço de domínio — chamado por
 * `POST /api/agents/proposals/[id]/apply`, com as mesmas validações de
 * transição que valem para uma pessoa.
 *
 * O `GET` é a triagem: o que o sistema não conseguiu classificar com segurança
 * e está esperando alguém dizer de quem é.
 */

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.status.read", "consultar a triagem de agentes");

    const url = new URL(request.url);
    const requestedStatus = cleanText(url.searchParams.get("status"), 30);
    const status = (agentProposalStatuses as readonly string[]).includes(requestedStatus)
      ? requestedStatus
      : "";
    const agentKey = cleanText(url.searchParams.get("agente"), 60);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limite")) || 50));

    const rows = status && agentKey
      ? await d1.prepare(`SELECT * FROM fdp_agent_proposals
          WHERE workspace_id = ? AND status = ? AND agent_key = ?
          ORDER BY created_at DESC LIMIT 200`).bind(workspace.id, status, agentKey).all<Record<string, unknown>>()
      : status
        ? await d1.prepare(`SELECT * FROM fdp_agent_proposals
            WHERE workspace_id = ? AND status = ?
            ORDER BY created_at DESC LIMIT 200`).bind(workspace.id, status).all<Record<string, unknown>>()
        : agentKey
          ? await d1.prepare(`SELECT * FROM fdp_agent_proposals
              WHERE workspace_id = ? AND agent_key = ?
              ORDER BY created_at DESC LIMIT 200`).bind(workspace.id, agentKey).all<Record<string, unknown>>()
          : await d1.prepare(`SELECT * FROM fdp_agent_proposals
              WHERE workspace_id = ? AND status IN ('pending_triage', 'suggested')
              ORDER BY created_at DESC LIMIT 200`).bind(workspace.id).all<Record<string, unknown>>();

    return Response.json({
      proposals: rows.results.slice(0, limit).map(toProposalPayload),
      canResolve: hasCapability(workspace, "integrations.reconcile"),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    /* Registrar proposta de agente é operar integração, não abrir demanda: quem
       não administra integração não injeta trabalho pela porta do robô. */
    requireNamedCapability(workspace, "integrations.execute", "registrar uma proposta de agente");

    const proposal = sanitizeAgentProposal(body);
    if (!proposal.agentKey) {
      throw ApiError.badRequest("A proposta não identifica o agente de origem.", "AGENT_KEY_REQUIRED");
    }
    if (!proposal.idempotencyKey) {
      throw ApiError.badRequest(
        "A proposta não traz chave de idempotência, e sem ela a mesma leitura vira duas propostas.",
        "AGENT_IDEMPOTENCY_REQUIRED",
      );
    }

    const [enabled, policy] = await Promise.all([
      isAgentEnabled(d1, workspace.id, proposal.agentKey),
      readAgentAutomationPolicy(d1, workspace.id),
    ]);
    const eventName = cleanText(body.eventName, 120);
    const outcome = decideAgentProposal({ proposal, policy, agentEnabled: enabled, eventName });
    const status = statusForDecision(outcome.decision);
    const resolvedNow = status === "rejected";

    const id = crypto.randomUUID();
    const inserted = await d1.prepare(`INSERT INTO fdp_agent_proposals
        (id, workspace_id, agent_key, agent_version, event_id, event_name, entity_type, entity_id,
         process_instance_id, current_step_id, proposed_action, proposed_step_id, reason, confidence,
         requires_human_approval, evidence_refs_json, status, decision_code, decision_reason,
         resolved_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key <> '' DO NOTHING
      RETURNING id`)
      .bind(
        id, workspace.id, proposal.agentKey, proposal.agentVersion, proposal.eventId, eventName,
        proposal.entityType, proposal.entityId, proposal.processInstanceId || null, proposal.currentStepId,
        proposal.proposedAction || "unknown", proposal.proposedStepId, proposal.reason,
        Math.round(proposal.confidence * 100), outcome.requiresHuman ? 1 : 0,
        JSON.stringify(proposal.evidenceIds), status, outcome.code, outcome.reason,
        resolvedNow ? new Date().toISOString() : null, proposal.idempotencyKey,
      ).first<{ id: string }>();

    if (!inserted) {
      // A mesma leitura chegou duas vezes. Devolver a proposta que já existe é a
      // resposta certa: o agente reprocessou, não aconteceu nada novo.
      const existing = await d1.prepare(
        "SELECT * FROM fdp_agent_proposals WHERE workspace_id = ? AND idempotency_key = ?",
      ).bind(workspace.id, proposal.idempotencyKey).first<Record<string, unknown>>();
      return Response.json({ proposal: existing ? toProposalPayload(existing) : null, duplicate: true });
    }

    await d1.batch([
      prepareDomainEventEnvelope(d1, {
        name: outcome.decision === "reject" ? "agent.proposal_rejected"
          : outcome.decision === "triage" ? "triage.item_opened"
            : "agent.proposal_created",
        origin: "agent",
        workspaceId: workspace.id,
        entityId: id,
        causationId: proposal.eventId || undefined,
        evidenceRefs: proposal.evidenceIds,
        payload: {
          proposalId: id,
          agentKey: proposal.agentKey,
          proposedAction: proposal.proposedAction,
          confidence: Math.round(proposal.confidence * 100),
          decision: outcome.decision,
          reason: outcome.code,
        },
      }, { actorUserId: user.id, requestId: request.headers.get("x-fila-dp-request-id") }),
      prepareAuditEvent({
        workspaceId: workspace.id,
        actorUserId: user.id,
        actorEmail: auth.user.email,
        actorType: "integration",
        action: "agent.proposal_decided",
        outcome: outcome.decision === "reject" ? "denied" : "success",
        entityType: "agent_proposal",
        entityId: id,
        after: {
          agentKey: proposal.agentKey,
          proposedAction: proposal.proposedAction,
          decision: outcome.decision,
          decisionCode: outcome.code,
          confidence: Math.round(proposal.confidence * 100),
          policy,
        },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({
      proposal: {
        id,
        agentKey: proposal.agentKey,
        proposedAction: proposal.proposedAction,
        status,
        confidence: proposal.confidence,
      },
      decision: outcome,
      duplicate: false,
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

function toProposalPayload(row: Record<string, unknown>) {
  const text = (value: unknown) => (value == null ? "" : String(value));
  const evidence = Array.isArray(row.evidence_refs_json) ? row.evidence_refs_json.map(String) : [];
  return {
    id: text(row.id),
    agentKey: text(row.agent_key),
    agentVersion: text(row.agent_version),
    eventId: text(row.event_id),
    eventName: text(row.event_name),
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
    processInstanceId: text(row.process_instance_id) || null,
    currentStepId: text(row.current_step_id),
    proposedAction: text(row.proposed_action),
    proposedStepId: text(row.proposed_step_id),
    reason: text(row.reason),
    confidence: Number(row.confidence ?? 0) / 100,
    requiresHumanApproval: Number(row.requires_human_approval ?? 1) === 1,
    evidenceIds: evidence,
    status: text(row.status),
    decisionCode: text(row.decision_code),
    decisionReason: text(row.decision_reason),
    resolutionNote: text(row.resolution_note),
    resultType: text(row.result_type),
    resultId: text(row.result_id),
    createdAt: text(row.created_at),
    resolvedAt: text(row.resolved_at) || null,
  };
}
