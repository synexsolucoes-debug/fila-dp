import type { getD1 } from "../db";

import { ApiError } from "./api-errors.ts";
import {
  buildDomainEvent, domainEventNames, findDomainEvent, requireDomainEvent,
  type DomainEventInputEnvelope, type DomainEventName, type DomainEventOrigin,
} from "./domain-events.ts";
import { cleanText } from "./registrations.ts";

/**
 * Transactional Outbox (§80).
 *
 * O evento de domínio é gravado no mesmo lote da mutação de negócio. Só depois,
 * fora da requisição do usuário, o publicador transforma eventos pendentes em
 * entregas de webhook. Assim não existe evento sem fato nem fato sem evento.
 *
 * A lista de tipos deixou de morar aqui: ela é derivada do catálogo em
 * `lib/domain-events.ts`. Duas listas do mesmo vocabulário divergem — bastava
 * alguém publicar um evento novo e esquecer de torná-lo assinável.
 */
type Database = ReturnType<typeof getD1>;

export const domainEventTypes = domainEventNames;
export type DomainEventType = DomainEventName;

export function isDomainEventType(value: unknown): value is DomainEventType {
  return findDomainEvent(value) !== null;
}

export function parseEventTypes(value: unknown): DomainEventType[] {
  const list = Array.isArray(value) ? value : [];
  const selected = [...new Set(list.map((item) => cleanText(item, 80)))].filter(isDomainEventType);
  if (!selected.length) throw ApiError.badRequest("Selecione ao menos um evento suportado.", "WEBHOOK_EVENT_TYPES_REQUIRED");
  return selected;
}

/**
 * Carga do evento: apenas identificadores, estado e valores agregados.
 * Nenhum dado pessoal do colaborador atravessa a fronteira do workspace.
 */
export type DomainEventInput = {
  workspaceId: string;
  eventType: DomainEventType;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  actorUserId?: string | null;
  requestId?: string | null;
};

const allowedPayloadKeys = new Set([
  "competence", "companyId", "providerId", "status", "previousStatus", "netAmount", "grossAmount",
  "invoiceExpectedAmount", "invoiceReceivedAmount", "complementAmount", "cajuAmount", "invoiceStatus",
  "cajuStatus", "reconciliationStatus", "reconciliationDifference", "calcVersion", "sessionsCount",
  "employeesCount", "closingId", "occurredAt", "integrationId", "runId", "foundCount", "importedCount",
  "updatedCount", "ignoredCount", "failedCount", "errorCode",
]);

/**
 * Allowlist explícita: o que não está previsto não sai do produto.
 *
 * Eventos do catálogo que declaram as próprias chaves usam **só** as delas —
 * um evento de admissão não deve conseguir carregar `netAmount` por acidente.
 * Os eventos anteriores ao catálogo declaram lista vazia e continuam sob a
 * allowlist geral, porque restringi-los agora mudaria o corpo já entregue a
 * endpoints de clientes.
 */
export function sanitizeEventPayload(payload: Record<string, unknown>, eventType?: string) {
  const declared = eventType ? findDomainEvent(eventType)?.payloadKeys ?? [] : [];
  const allowed = declared.length ? new Set(declared) : allowedPayloadKeys;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
    else if (typeof value === "string") safe[key] = value.slice(0, 200);
  }
  return safe;
}

/**
 * Statement do evento, para entrar no mesmo `batch` da mutação de negócio.
 *
 * Origem `internal` e chave de idempotência vazia são deliberados: este caminho
 * é o do fato que nasce dentro de uma transação nossa, que já acontece uma vez
 * só. Quem recebe de fora usa `prepareDomainEventEnvelope`, onde a chave existe
 * e o índice único faz o trabalho. O `requestId` vira a correlação, porque é o
 * que liga o evento à requisição que o provocou.
 */
export function prepareDomainEvent(d1: Database, input: DomainEventInput) {
  const definition = requireDomainEvent(input.eventType);
  return d1.prepare(`INSERT INTO fdp_domain_events
      (id, workspace_id, event_type, entity_type, entity_id, payload_json, status, actor_user_id, request_id,
       schema_version, origin, external_id, correlation_id, causation_id, idempotency_key, evidence_refs_json)
    VALUES (?, ?, ?, ?, ?, ?::jsonb, 'pending', ?, ?, ?, 'internal', '', ?, '', '', '[]'::jsonb)`)
    .bind(
      crypto.randomUUID(), input.workspaceId, definition.name, input.entityType, input.entityId,
      JSON.stringify(sanitizeEventPayload(input.payload, definition.name)),
      input.actorUserId ?? null, cleanText(input.requestId, 120),
      definition.schemaVersion, cleanText(input.requestId, 120),
    );
}

/**
 * Statement do evento a partir do envelope completo (§6).
 *
 * É o caminho de quem recebe de fora: o envelope já carrega origem,
 * identificador externo, correlação, causa, evidência e a chave de
 * idempotência derivada. `ON CONFLICT DO NOTHING` sobre
 * `(workspace_id, idempotency_key)` é o que torna a segunda entrega da mesma
 * ocorrência inofensiva **no banco**, e não numa verificação em código que duas
 * requisições simultâneas atravessam juntas (§8).
 */
export function prepareDomainEventFromEnvelope(d1: Database, envelope: {
  name: DomainEventName; schemaVersion: number; origin: DomainEventOrigin; workspaceId: string;
  entityType: string; entityId: string; externalId: string; correlationId: string; causationId: string;
  occurredAt: string; payload: Record<string, unknown>; evidenceRefs: string[]; idempotencyKey: string;
}, actor: { actorUserId?: string | null; requestId?: string | null } = {}) {
  return d1.prepare(`INSERT INTO fdp_domain_events
      (id, workspace_id, event_type, entity_type, entity_id, payload_json, status, actor_user_id, request_id,
       schema_version, origin, external_id, correlation_id, causation_id, idempotency_key, evidence_refs_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?::jsonb, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
    ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key <> '' DO NOTHING`)
    .bind(
      crypto.randomUUID(), envelope.workspaceId, envelope.name, envelope.entityType, envelope.entityId,
      JSON.stringify(sanitizeEventPayload(envelope.payload, envelope.name)),
      actor.actorUserId ?? null, cleanText(actor.requestId, 120),
      envelope.schemaVersion, envelope.origin, envelope.externalId,
      envelope.correlationId, envelope.causationId, envelope.idempotencyKey,
      JSON.stringify(envelope.evidenceRefs), envelope.occurredAt,
    );
}

/** Atalho: monta o envelope validado e devolve o statement pronto para o batch. */
export function prepareDomainEventEnvelope(d1: Database, input: DomainEventInputEnvelope,
  actor: { actorUserId?: string | null; requestId?: string | null } = {}) {
  return prepareDomainEventFromEnvelope(d1, buildDomainEvent(input), actor);
}

/**
 * Converte eventos pendentes em entregas para os endpoints inscritos.
 *
 * A criação da entrega é idempotente por (endpoint, evento): reprocessar o
 * publicador nunca duplica envio.
 */
export async function publishPendingDomainEvents(d1: Database, workspaceId: string, limit = 50) {
  const events = await d1.prepare(`SELECT id, event_type FROM fdp_domain_events
    WHERE workspace_id = ? AND status = 'pending' ORDER BY occurred_at LIMIT ?`)
    .bind(workspaceId, Math.min(Math.max(limit, 1), 200)).all<{ id: string; event_type: string }>();
  if (!events.results.length) return { published: 0, deliveries: 0 };

  const endpoints = await d1.prepare(`SELECT id, event_types_json FROM fdp_webhook_endpoints
    WHERE workspace_id = ? AND status = 'active'`)
    .bind(workspaceId).all<{ id: string; event_types_json: string[] | string }>();
  const subscriptions = endpoints.results.map((row) => ({
    id: String(row.id),
    eventTypes: new Set(Array.isArray(row.event_types_json)
      ? row.event_types_json.map(String)
      : (JSON.parse(String(row.event_types_json || "[]")) as string[]).map(String)),
  }));

  let deliveries = 0;
  for (const event of events.results) {
    const matching = subscriptions.filter((endpoint) => endpoint.eventTypes.has(String(event.event_type)));
    const statements = matching.map((endpoint) => d1.prepare(
      `INSERT INTO fdp_webhook_deliveries (id, workspace_id, endpoint_id, event_id, event_type, status, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, 'pending', now())
       ON CONFLICT (workspace_id, endpoint_id, event_id) DO NOTHING`,
    ).bind(crypto.randomUUID(), workspaceId, endpoint.id, event.id, event.event_type));
    statements.push(d1.prepare(`UPDATE fdp_domain_events SET status = ?, published_at = now(), deliveries_count = ?
      WHERE workspace_id = ? AND id = ? AND status = 'pending'`)
      .bind(matching.length ? "published" : "skipped", matching.length, workspaceId, event.id));
    await d1.batch(statements);
    deliveries += matching.length;
  }
  return { published: events.results.length, deliveries };
}
