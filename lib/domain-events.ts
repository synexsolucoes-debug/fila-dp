/**
 * Catálogo versionado de eventos de domínio.
 *
 * Antes disto cada integração inventava o nome e o formato do que publicava:
 * o Sankhya dizia `sankhya.employee.created`, o Teams não publicava nada e
 * criava a demanda direto, e o Tangerino publicava um evento que ninguém
 * consumia. Três vocabulários para o mesmo fato — "aconteceu algo com uma
 * pessoa" — é o que impede um motor único de decidir o que fazer.
 *
 * O catálogo resolve isso sendo **o** registro: nome, versão de esquema, tipo
 * de entidade, origens aceitas, risco e as chaves que o payload pode carregar.
 * Nada publica um evento que não esteja aqui, e `lib/outbox.ts` deriva desta
 * lista os tipos que um webhook de saída pode assinar — não existe uma segunda
 * lista para desatualizar.
 *
 * O que este módulo **não** faz: decidir. Ele valida o envelope e devolve um
 * objeto. Quem decide o que o evento provoca é o motor determinístico
 * (`lib/process-instances.ts` e `lib/agent-proposals.ts`), nunca o emissor.
 *
 * ## Envelope
 *
 * Todo evento carrega, obrigatoriamente: nome, `schemaVersion`, origem,
 * workspace, `entityType`, `occurredAt`, `receivedAt` e `idempotencyKey`. E,
 * quando conhecido: `entityId`, `externalId`, `correlationId`, `causationId`,
 * `evidenceRefs`.
 *
 * `idempotencyKey` é o campo que impede que a mesma ocorrência produza dois
 * resultados de negócio (§8). Ele é derivado, não sorteado: a mesma entrega do
 * mesmo webhook produz a mesma chave, e o índice único no banco recusa a
 * segunda inserção. Sorteá-lo por execução tornaria a coluna decorativa.
 */
import { createHash } from "node:crypto";

import { ApiError } from "./api-errors.ts";

export const domainEventOrigins = [
  "internal", "teams", "solides", "tangerino", "sankhya", "caju", "agent", "api", "import",
] as const;
export type DomainEventOrigin = typeof domainEventOrigins[number];

/**
 * Risco do evento, não do dado.
 *
 * `sensitive` marca o fato cuja consequência mexe em dinheiro, vínculo ou
 * obrigação legal. O motor nunca executa a consequência de um evento sensível
 * sozinho, qualquer que seja a confiança de quem o emitiu (§18).
 */
export type DomainEventRisk = "routine" | "sensitive";

export type DomainEventDefinition = {
  readonly name: string;
  readonly schemaVersion: number;
  readonly entityType: string;
  readonly origins: readonly DomainEventOrigin[];
  readonly risk: DomainEventRisk;
  readonly description: string;
  /**
   * Chaves aceitas no payload deste evento. Lista vazia significa "usa a
   * allowlist geral do outbox" — é o caso dos eventos que já existiam antes do
   * catálogo e cujo payload não pode mudar sem quebrar assinantes.
   */
  readonly payloadKeys: readonly string[];
};

/**
 * Genérica no nome de propósito: preservar o literal é o que permite derivar a
 * união de tipos do próprio catálogo, em vez de manter uma segunda lista de
 * nomes só para o TypeScript — que é como as duas listas divergiam antes.
 */
const definition = <N extends string>(
  name: N,
  entityType: string,
  origins: readonly DomainEventOrigin[],
  risk: DomainEventRisk,
  description: string,
  payloadKeys: readonly string[] = [],
  schemaVersion = 1,
) => ({ name, schemaVersion, entityType, origins, risk, description, payloadKeys } as const);

/* Chaves comuns a quase todo evento operacional novo. Manter uma constante em
   vez de repetir a lista evita o erro silencioso de um evento aceitar
   `companyId` e o irmão dele não. */
const OPERATIONAL_KEYS = [
  "companyId", "employeeId", "competence", "status", "previousStatus", "occurredAt",
  "processDefinitionId", "processVersionId", "cardId", "sourceLabel", "reason",
] as const;

export const domainEventCatalog = [
  /* ---------------------------------------------------------------------- *
   * Pessoas e admissão
   * ---------------------------------------------------------------------- */
  definition("employee.admitted", "employee", ["solides", "sankhya", "import", "internal"], "sensitive",
    "Pessoa com admissão concluída passou a existir para a operação.",
    [...OPERATIONAL_KEYS, "admissionDate", "externalId"]),
  definition("employee.changed", "employee", ["sankhya", "solides", "import", "internal"], "sensitive",
    "Cadastro do colaborador mudou na origem.",
    [...OPERATIONAL_KEYS, "changedFields", "externalId"]),
  definition("admission.created", "admission", ["solides", "tangerino", "teams"], "routine",
    "Processo de admissão detectado na origem.",
    [...OPERATIONAL_KEYS, "admissionDate", "externalId", "stage"]),
  definition("admission.status_changed", "admission", ["solides", "tangerino"], "routine",
    "Etapa ou situação da admissão mudou na origem.",
    [...OPERATIONAL_KEYS, "normalizedStatus", "rawStatus", "stage", "pendingReason", "externalId"]),
  definition("admission.approved", "admission", ["solides", "tangerino", "teams"], "sensitive",
    "Admissão aprovada na origem.",
    [...OPERATIONAL_KEYS, "admissionDate", "approvedBy", "externalId"]),
  definition("admission.pending_document", "admission", ["solides", "tangerino"], "routine",
    "Admissão parada aguardando documento.",
    [...OPERATIONAL_KEYS, "pendingReason", "externalId"]),
  definition("admission.completed", "admission", ["solides", "tangerino"], "sensitive",
    "Admissão concluída na origem.",
    [...OPERATIONAL_KEYS, "admissionDate", "externalId"]),

  /* ---------------------------------------------------------------------- *
   * Movimentações e aprovações
   * ---------------------------------------------------------------------- */
  definition("salary.change_requested", "employee_movement", ["teams", "api", "internal"], "sensitive",
    "Alguém pediu alteração salarial em um canal reconhecido.",
    [...OPERATIONAL_KEYS, "requestedBy", "effectiveDate", "confidence"]),
  definition("role.change_requested", "employee_movement", ["teams", "api", "internal"], "sensitive",
    "Alguém pediu alteração de cargo ou função.",
    [...OPERATIONAL_KEYS, "requestedBy", "effectiveDate", "confidence"]),
  definition("termination.requested", "employee_movement", ["teams", "api", "internal"], "sensitive",
    "Alguém pediu desligamento.",
    [...OPERATIONAL_KEYS, "requestedBy", "effectiveDate", "confidence"]),
  definition("approval.completed", "approval", ["teams", "api", "internal"], "sensitive",
    "Uma aprovação foi concedida.",
    [...OPERATIONAL_KEYS, "approvedBy", "decidedAt", "movementId", "decision"]),
  definition("approval.rejected", "approval", ["teams", "api", "internal"], "sensitive",
    "Uma aprovação foi recusada.",
    [...OPERATIONAL_KEYS, "approvedBy", "decidedAt", "movementId", "decision"]),

  /* ---------------------------------------------------------------------- *
   * Prestadores PJ, ponto e EPI
   * ---------------------------------------------------------------------- */
  definition("pj.invoice_requested", "contractor_closing", ["internal"], "routine",
    "Aviso de nota fiscal enviado ao prestador.",
    [...OPERATIONAL_KEYS, "providerId", "closingId", "invoiceExpectedAmount"]),
  definition("pj.invoice_received", "contractor_closing", ["internal", "api"], "sensitive",
    "Nota fiscal do prestador recebida e registrada.",
    [...OPERATIONAL_KEYS, "providerId", "closingId", "invoiceReceivedAmount", "invoiceStatus"]),
  definition("time.inconsistency_detected", "time_sheet", ["internal", "tangerino"], "routine",
    "Conferência de ponto encontrou inconsistência relevante.",
    [...OPERATIONAL_KEYS, "timeSheetId", "severity", "inconsistencyType"]),
  definition("epi.delivery_requested", "epi_delivery", ["internal"], "routine",
    "Entrega de EPI solicitada para um colaborador.",
    [...OPERATIONAL_KEYS, "productId", "quantity"]),

  /* ---------------------------------------------------------------------- *
   * Processos
   * ---------------------------------------------------------------------- */
  definition("process.instance_started", "card", ["internal", "agent", "api"], "routine",
    "Uma versão publicada de processo gerou uma demanda.",
    [...OPERATIONAL_KEYS, "processVersionNumber", "currentStepId", "trigger"]),
  definition("process.step_advanced", "card", ["internal", "agent", "api"], "routine",
    "A demanda avançou para outra etapa do processo.",
    [...OPERATIONAL_KEYS, "processVersionNumber", "fromStepId", "currentStepId"]),
  definition("process.instance_completed", "card", ["internal", "agent", "api"], "routine",
    "A demanda chegou ao fim do processo.",
    [...OPERATIONAL_KEYS, "processVersionNumber", "currentStepId"]),

  /* ---------------------------------------------------------------------- *
   * Integrações e agentes
   * ---------------------------------------------------------------------- */
  definition("integration.failed", "integration", ["internal", "sankhya", "tangerino", "solides", "teams", "agent"], "routine",
    "Uma integração passou a falhar.",
    ["integrationId", "connector", "errorCode", "runId", "occurredAt", "reason"]),
  definition("integration.recovered", "integration", ["internal", "sankhya", "tangerino", "solides", "teams", "agent"], "routine",
    "Uma integração que falhava voltou a funcionar.",
    ["integrationId", "connector", "runId", "occurredAt"]),
  definition("source.ui_changed", "integration", ["agent", "tangerino", "sankhya", "solides"], "routine",
    "A tela da origem mudou e o agente não conseguiu ler com segurança (§27).",
    ["integrationId", "connector", "selector", "occurredAt", "reason"]),
  definition("agent.proposal_created", "agent_proposal", ["agent"], "routine",
    "Um agente propôs uma ação ao motor determinístico.",
    ["proposalId", "agentKey", "proposedAction", "confidence", "decision", "occurredAt"]),
  definition("agent.proposal_rejected", "agent_proposal", ["agent", "internal"], "routine",
    "O motor determinístico recusou uma proposta de agente.",
    ["proposalId", "agentKey", "proposedAction", "reason", "occurredAt"]),
  definition("triage.item_opened", "triage", ["agent", "teams", "solides", "tangerino", "internal"], "routine",
    "Uma entrada externa não pôde ser classificada com segurança e foi para triagem (§19).",
    ["proposalId", "agentKey", "reason", "occurredAt", "sourceLabel"]),

  /* ---------------------------------------------------------------------- *
   * Eventos que já existiam antes do catálogo.
   *
   * Estão aqui porque endpoints de webhook de clientes já assinam estes nomes;
   * removê-los para "limpar" quebraria integrações instaladas (§76). O payload
   * deles continua governado pela allowlist geral do outbox — declarar chaves
   * aqui mudaria silenciosamente o que já é entregue.
   * ---------------------------------------------------------------------- */
  definition("psychology_closing.closed", "psychology_closing", ["internal"], "sensitive", "Fechamento de psicologia concluído."),
  definition("psychology_closing.reopened", "psychology_closing", ["internal"], "sensitive", "Fechamento de psicologia reaberto."),
  definition("psychology_payment.registered", "psychology_payment", ["internal"], "sensitive", "Pagamento de psicólogo registrado."),
  definition("contractor_closing.closed", "contractor_closing", ["internal"], "sensitive", "Fechamento PJ concluído."),
  definition("contractor_closing.reopened", "contractor_closing", ["internal"], "sensitive", "Fechamento PJ reaberto."),
  definition("contractor_invoice.registered", "contractor_closing", ["internal"], "sensitive", "Nota do prestador registrada."),
  definition("contractor_complement.updated", "contractor_closing", ["internal"], "sensitive", "Complemento do prestador atualizado."),
  definition("competence.closed", "payroll_cycle", ["internal"], "sensitive", "Competência fechada."),
  definition("time_sheet.approved", "time_sheet", ["internal"], "sensitive", "Folha de ponto aprovada."),
  definition("time_sheet.reopened", "time_sheet", ["internal"], "sensitive", "Folha de ponto reaberta."),
  definition("time_export.prepared", "time_export", ["internal"], "routine", "Exportação de ponto preparada."),
  definition("sankhya.sync.started", "integration", ["sankhya"], "routine", "Sincronização Sankhya iniciada."),
  definition("sankhya.sync.completed", "integration", ["sankhya"], "routine", "Sincronização Sankhya concluída."),
  definition("sankhya.sync.failed", "integration", ["sankhya"], "routine", "Sincronização Sankhya falhou."),
  definition("sankhya.employee.created", "employee", ["sankhya"], "sensitive", "Colaborador criado a partir do Sankhya."),
  definition("sankhya.employee.updated", "employee", ["sankhya"], "sensitive", "Colaborador atualizado a partir do Sankhya."),
  definition("sankhya.connection.failed", "integration", ["sankhya"], "routine", "Conexão Sankhya falhou."),
  definition("tangerino.consultation.started", "admission", ["tangerino"], "routine", "Consulta de admissão iniciada."),
  definition("tangerino.consultation.completed", "admission", ["tangerino"], "routine", "Consulta de admissão concluída."),
  definition("tangerino.consultation.failed", "admission", ["tangerino"], "routine", "Consulta de admissão falhou."),
  definition("tangerino.authentication.required", "integration", ["tangerino"], "routine", "Tangerino pediu autenticação."),
  definition("tangerino.admission.status_changed", "admission", ["tangerino"], "routine", "Situação da admissão mudou no Tangerino."),
] as const satisfies readonly DomainEventDefinition[];

/** União derivada do catálogo: um nome fora dele não compila. */
export type DomainEventName = typeof domainEventCatalog[number]["name"];

const byName = new Map<string, DomainEventDefinition>(domainEventCatalog.map((item) => [item.name, item]));

if (byName.size !== domainEventCatalog.length) {
  // Falha na carga do módulo, e não em produção meses depois: um nome repetido
  // faria dois eventos diferentes compartilharem regra de risco e payload.
  throw new Error("O catálogo de eventos de domínio possui nomes repetidos.");
}

export const domainEventNames: readonly DomainEventName[] =
  domainEventCatalog.map((item) => item.name);

export function findDomainEvent(name: unknown): DomainEventDefinition | null {
  return typeof name === "string" ? byName.get(name) ?? null : null;
}

export function requireDomainEvent(name: unknown): DomainEventDefinition {
  const found = findDomainEvent(name);
  if (!found) {
    throw new ApiError(500, "DOMAIN_EVENT_UNKNOWN",
      `Evento de domínio fora do catálogo: ${typeof name === "string" ? name.slice(0, 80) : "(sem nome)"}.`);
  }
  return found;
}

export function isSensitiveDomainEvent(name: unknown) {
  return findDomainEvent(name)?.risk === "sensitive";
}

/* -------------------------------------------------------------------------- *
 * Envelope
 * -------------------------------------------------------------------------- */

export type DomainEventEnvelope = {
  name: DomainEventName;
  schemaVersion: number;
  origin: DomainEventOrigin;
  workspaceId: string;
  entityType: string;
  entityId: string;
  externalId: string;
  correlationId: string;
  causationId: string;
  occurredAt: string;
  receivedAt: string;
  payload: Record<string, unknown>;
  evidenceRefs: string[];
  idempotencyKey: string;
};

export type DomainEventInputEnvelope = {
  name: DomainEventName;
  origin: DomainEventOrigin;
  workspaceId: string;
  entityId?: string | null;
  externalId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt?: string | Date | null;
  receivedAt?: string | Date | null;
  payload?: Record<string, unknown>;
  evidenceRefs?: readonly string[];
  /** Informe quando a origem já garante a unicidade; senão ela é derivada. */
  idempotencyKey?: string | null;
};

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

function isoTimestamp(value: unknown, fallback: string) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value.toISOString();
  const raw = text(value, 40);
  if (!raw) return fallback;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/**
 * Chave de idempotência derivada.
 *
 * A entrada é o que identifica a **ocorrência**, nunca a execução: workspace,
 * nome do evento, origem, identificador externo e — só quando não há externo —
 * entidade e instante. Incluir `receivedAt` ou um UUID aqui faria a segunda
 * entrega do mesmo webhook gerar uma chave nova, que é exatamente o defeito
 * que a chave existe para impedir.
 */
export function deriveIdempotencyKey(parts: {
  workspaceId: string; name: string; origin: string;
  externalId?: string | null; entityId?: string | null; occurredAt?: string | null;
}) {
  const external = text(parts.externalId, 300);
  const discriminator = external || [text(parts.entityId, 120), text(parts.occurredAt, 40)].join("|");
  const material = [text(parts.workspaceId, 100), text(parts.name, 120), text(parts.origin, 40), discriminator].join(" ");
  return createHash("sha256").update(material).digest("hex").slice(0, 64);
}

/** Referências de evidência: identificadores internos, nunca URL de terceiro com token. */
function sanitizeEvidenceRefs(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 200)).filter(Boolean))].slice(0, 20);
}

/**
 * Monta e valida o envelope.
 *
 * A validação recusa três coisas: evento fora do catálogo, origem que aquele
 * evento não aceita, e workspace ausente. As três seriam bug de programação, e
 * é melhor que apareçam como erro no ponto de emissão do que como um evento
 * órfão que ninguém consegue reprocessar.
 */
export function buildDomainEvent(input: DomainEventInputEnvelope): DomainEventEnvelope {
  const found = requireDomainEvent(input.name);
  const workspaceId = text(input.workspaceId, 100);
  if (!workspaceId) {
    throw new ApiError(500, "DOMAIN_EVENT_SCOPE_MISSING", "Evento de domínio sem workspace de origem.");
  }
  if (!domainEventOrigins.includes(input.origin)) {
    throw new ApiError(500, "DOMAIN_EVENT_ORIGIN_INVALID", `Origem desconhecida para ${found.name}.`);
  }
  if (!found.origins.includes(input.origin)) {
    throw new ApiError(500, "DOMAIN_EVENT_ORIGIN_NOT_ALLOWED",
      `O evento ${found.name} não é publicado pela origem ${input.origin}.`);
  }

  const now = new Date().toISOString();
  const receivedAt = isoTimestamp(input.receivedAt, now);
  const occurredAt = isoTimestamp(input.occurredAt, receivedAt);
  const entityId = text(input.entityId, 120);
  const externalId = text(input.externalId, 300);
  const idempotencyKey = text(input.idempotencyKey, 64) || deriveIdempotencyKey({
    workspaceId, name: found.name, origin: input.origin, externalId, entityId, occurredAt,
  });

  return {
    name: found.name as DomainEventName,
    schemaVersion: found.schemaVersion,
    origin: input.origin,
    workspaceId,
    entityType: found.entityType,
    entityId,
    externalId,
    correlationId: text(input.correlationId, 120) || idempotencyKey,
    causationId: text(input.causationId, 120),
    occurredAt,
    receivedAt,
    payload: input.payload ?? {},
    evidenceRefs: sanitizeEvidenceRefs(input.evidenceRefs),
    idempotencyKey,
  };
}
