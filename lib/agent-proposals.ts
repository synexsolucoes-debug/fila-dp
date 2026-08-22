/**
 * Motor determinístico de propostas de agente (§16, §17, §18, §19).
 *
 * A arquitetura obrigatória é esta, e este arquivo é o terceiro degrau dela:
 *
 *     Agente → proposta → motor determinístico → serviço de domínio →
 *     execução → auditoria
 *
 * O agente **propõe**. Ele não executa SQL, não escreve no domínio, não decide
 * regra trabalhista, não aprova remuneração, desligamento ou financeiro, não
 * escreve em ERP e não contorna processo. Nada disso é uma promessa de
 * documentação: o agente não tem função nenhuma aqui que escreva, e a única
 * saída deste módulo é uma **decisão** — quem escreve é
 * `lib/process-instances.ts`, com ator humano identificado, ou ninguém.
 *
 * ## Por que a decisão é uma função pura
 *
 * Porque ela precisa ser auditável e testável sem banco. "Por que o sistema
 * executou isto sozinho?" tem que ter resposta exata, e a resposta é a
 * combinação de ação, confiança, política do workspace e evidência — não o
 * estado de uma conexão no instante em que aconteceu.
 *
 * ## Ação sensível
 *
 * Existe uma classe de ação que **nunca** executa sozinha, qualquer que seja a
 * confiança e qualquer que seja a configuração do workspace (§18, último
 * parágrafo). Salário, desligamento, aprovação financeira, escrita em sistema
 * externo e fechamento estão nela. Um workspace configurado como `trusted` não
 * afrouxa isso; ele apenas deixa de pedir confirmação para o que é rotina.
 */
import { isSensitiveDomainEvent } from "./domain-events.ts";
import { cleanText } from "./registrations.ts";

/** O que um agente pode propor. Fora desta lista, a proposta é recusada. */
export const agentActions = [
  /* Operacionais — podem ser automáticas quando a confiança é alta. */
  "process.start",
  "process.advance",
  "demand.comment",
  "demand.link_evidence",
  "employee.link_external_ref",
  "integration.flag_failure",
  "triage.open",
  /* Sensíveis — nunca automáticas. */
  "movement.request_salary_change",
  "movement.request_termination",
  "approval.record_decision",
  "closing.reopen",
  "erp.write",
] as const;
export type AgentAction = typeof agentActions[number];

/**
 * Ações que exigem humano sempre.
 *
 * A lista é explícita e não derivada de heurística: um erro de classificação
 * aqui é a diferença entre "o robô sugeriu" e "o robô mexeu no salário".
 */
const SENSITIVE_ACTIONS = new Set<AgentAction>([
  "movement.request_salary_change",
  "movement.request_termination",
  "approval.record_decision",
  "closing.reopen",
  "erp.write",
]);

export function isSensitiveAction(action: unknown): action is AgentAction {
  return typeof action === "string" && SENSITIVE_ACTIONS.has(action as AgentAction);
}

/** Contrato da proposta (§17). */
export type AgentProposal = {
  /** Evento de domínio que originou a proposta. Sem ele não há rastro. */
  eventId: string;
  agentKey: string;
  agentVersion: string;
  entityType: string;
  entityId: string;
  processInstanceId: string;
  currentStepId: string;
  proposedAction: AgentAction | string;
  proposedStepId: string;
  reason: string;
  evidenceIds: string[];
  /** 0..1. */
  confidence: number;
  requiresHumanApproval: boolean;
  idempotencyKey: string;
};

export type AgentAutomationPolicy = "off" | "suggest_only" | "trusted";
export const agentAutomationPolicies: readonly AgentAutomationPolicy[] = ["off", "suggest_only", "trusted"];

/**
 * Faixas de confiança (§18).
 *
 * Constantes nomeadas e não números soltos porque elas são regra de produto:
 * mexer nelas é decisão, e uma decisão precisa de um lugar para ser lida.
 */
export const AUTOMATIC_THRESHOLD = 0.85;
export const SUGGESTION_THRESHOLD = 0.5;

export type AgentDecisionKind = "execute" | "suggest" | "triage" | "reject";

export type AgentDecision = {
  decision: AgentDecisionKind;
  /** Código estável para auditoria e tela; nunca texto livre. */
  code: string;
  reason: string;
  /** `true` quando a execução, se acontecer, precisa de um humano no comando. */
  requiresHuman: boolean;
};

const decision = (kind: AgentDecisionKind, code: string, reason: string, requiresHuman: boolean): AgentDecision =>
  ({ decision: kind, code, reason, requiresHuman });

function normalizedConfidence(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, Math.round(number * 100) / 100));
}

/**
 * Sanitiza a proposta antes de qualquer decisão.
 *
 * Um agente é código que lê tela de terceiro; tratar o que ele devolve como
 * confiável é a porta de entrada exata que esta arquitetura existe para fechar.
 */
export function sanitizeAgentProposal(raw: unknown): AgentProposal {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const evidence = Array.isArray(input.evidenceIds)
    ? [...new Set(input.evidenceIds.map((item) => cleanText(item, 200)).filter(Boolean))].slice(0, 20)
    : [];
  return {
    eventId: cleanText(input.eventId, 120),
    agentKey: cleanText(input.agentKey, 60),
    agentVersion: cleanText(input.agentVersion, 40),
    entityType: cleanText(input.entityType, 60),
    entityId: cleanText(input.entityId, 120),
    processInstanceId: cleanText(input.processInstanceId, 120),
    currentStepId: cleanText(input.currentStepId, 160),
    proposedAction: cleanText(input.proposedAction, 60),
    proposedStepId: cleanText(input.proposedStepId, 160),
    reason: cleanText(input.reason, 1000),
    evidenceIds: evidence,
    confidence: normalizedConfidence(input.confidence),
    requiresHumanApproval: Boolean(input.requiresHumanApproval),
    idempotencyKey: cleanText(input.idempotencyKey, 64),
  };
}

/**
 * A decisão.
 *
 * A ordem das recusas é a ordem da desconfiança: primeiro o que torna a
 * proposta inválida, depois o que a torna perigosa, e só no fim a confiança.
 * Inverter isso deixaria uma proposta com nota alta atravessar uma validação
 * que ela nem deveria ter alcançado.
 */
export function decideAgentProposal(input: {
  proposal: AgentProposal;
  policy: AgentAutomationPolicy;
  /** `false` quando o agente está pausado no workspace — o kill switch (§66). */
  agentEnabled: boolean;
  /** Nome do evento de domínio de origem, quando houver: risco vem do catálogo. */
  eventName?: string | null;
}): AgentDecision {
  const { proposal } = input;

  if (!input.agentEnabled) {
    return decision("reject", "AGENT_PAUSED",
      "O agente está pausado neste grupo e nenhuma proposta dele é considerada.", true);
  }
  if (!proposal.agentKey || !proposal.eventId) {
    return decision("reject", "AGENT_PROPOSAL_UNTRACEABLE",
      "A proposta não identifica o agente ou o evento que a originou.", true);
  }
  if (!(agentActions as readonly string[]).includes(proposal.proposedAction)) {
    return decision("reject", "AGENT_ACTION_UNKNOWN",
      "A ação proposta não está no catálogo de ações permitidas a um agente.", true);
  }
  if (proposal.proposedAction === "process.advance" && !proposal.processInstanceId) {
    return decision("reject", "AGENT_INSTANCE_REQUIRED",
      "Avançar etapa exige a instância de processo correspondente.", true);
  }

  /* Não identificou a entidade → triagem (§19). Inventar o vínculo aqui é o
     erro que produz movimentação no colaborador errado, e ele é irreversível
     em folha. */
  if (!proposal.entityId && !proposal.processInstanceId) {
    return decision("triage", "AGENT_ENTITY_UNRESOLVED",
      "O agente não conseguiu identificar com segurança a quem a entrada se refere.", true);
  }

  if (input.policy === "off") {
    return decision("triage", "AGENT_AUTOMATION_OFF",
      "A automação por agente está desligada neste grupo; a entrada vai para triagem.", true);
  }

  const sensitive = isSensitiveAction(proposal.proposedAction)
    || (input.eventName ? isSensitiveDomainEvent(input.eventName) : false);
  if (sensitive) {
    return decision("suggest", "AGENT_SENSITIVE_ACTION",
      "Ação sensível: a decisão é sempre de uma pessoa, qualquer que seja a confiança.", true);
  }
  if (proposal.requiresHumanApproval) {
    return decision("suggest", "AGENT_HUMAN_REQUESTED",
      "O próprio agente pediu validação humana.", true);
  }

  if (proposal.confidence < SUGGESTION_THRESHOLD) {
    return decision("triage", "AGENT_LOW_CONFIDENCE",
      "Confiança baixa: a entrada vai para triagem em vez de virar sugestão.", true);
  }
  if (proposal.confidence < AUTOMATIC_THRESHOLD || input.policy !== "trusted") {
    return decision("suggest", "AGENT_NEEDS_CONFIRMATION",
      input.policy === "trusted"
        ? "Confiança média: vira sugestão para alguém confirmar."
        : "Este grupo exige confirmação humana para toda ação de agente.", true);
  }
  if (proposal.evidenceIds.length === 0) {
    // Executar sozinho sem nada para conferir depois torna o erro invisível.
    return decision("suggest", "AGENT_EVIDENCE_REQUIRED",
      "Sem evidência anexada, a ação automática vira sugestão.", true);
  }

  return decision("execute", "AGENT_AUTOMATIC",
    "Confiança alta, ação de rotina e grupo configurado para automação.", false);
}

/** Estado da proposta depois da decisão — é o que a triagem lista (§19). */
export const agentProposalStatuses = ["pending_triage", "suggested", "accepted", "rejected", "applied", "discarded"] as const;
export type AgentProposalStatus = typeof agentProposalStatuses[number];

export function statusForDecision(kind: AgentDecisionKind): AgentProposalStatus {
  if (kind === "execute") return "accepted";
  if (kind === "suggest") return "suggested";
  if (kind === "triage") return "pending_triage";
  return "rejected";
}
