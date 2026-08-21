import type { getD1 } from "../db";

import { ApiError } from "./api-errors.ts";
import { cleanText } from "./registrations.ts";

/**
 * Transactional Outbox (§80).
 *
 * O evento de domínio é gravado no mesmo lote da mutação de negócio. Só depois,
 * fora da requisição do usuário, o publicador transforma eventos pendentes em
 * entregas de webhook. Assim não existe evento sem fato nem fato sem evento.
 */
type Database = ReturnType<typeof getD1>;

export const domainEventTypes = [
  "psychology_closing.closed",
  "psychology_closing.reopened",
  "psychology_payment.registered",
  "contractor_closing.closed",
  "contractor_closing.reopened",
  "contractor_invoice.registered",
  "contractor_complement.updated",
  "competence.closed",
  "time_sheet.approved",
  "time_sheet.reopened",
  "time_export.prepared",
  "sankhya.sync.started",
  "sankhya.sync.completed",
  "sankhya.sync.failed",
  "sankhya.employee.created",
  "sankhya.employee.updated",
  "sankhya.connection.failed",
  /* Consulta de admissão no Tangerino (§49).
     `status_changed` é o único que carrega mudança de estado do processo, e é
     de propósito que ele apenas notifica: nesta versão nada no Vinculato anda
     sozinho por causa dele (§50). Ele existe para que a automação futura tenha
     onde se pendurar sem que a decisão de automatizar tenha sido tomada agora. */
  "tangerino.consultation.started",
  "tangerino.consultation.completed",
  "tangerino.consultation.failed",
  "tangerino.authentication.required",
  "tangerino.admission.status_changed",
] as const;
export type DomainEventType = typeof domainEventTypes[number];

export function isDomainEventType(value: unknown): value is DomainEventType {
  return typeof value === "string" && (domainEventTypes as readonly string[]).includes(value);
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

/** Allowlist explícita: o que não está previsto não sai do produto. */
export function sanitizeEventPayload(payload: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedPayloadKeys.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
    else if (typeof value === "string") safe[key] = value.slice(0, 200);
  }
  return safe;
}

/** Statement do evento, para entrar no mesmo `batch` da mutação de negócio. */
export function prepareDomainEvent(d1: Database, input: DomainEventInput) {
  if (!isDomainEventType(input.eventType)) throw new Error(`Evento de domínio desconhecido: ${input.eventType}`);
  return d1.prepare(`INSERT INTO fdp_domain_events (id, workspace_id, event_type, entity_type, entity_id, payload_json, status, actor_user_id, request_id)
    VALUES (?, ?, ?, ?, ?, ?::jsonb, 'pending', ?, ?)`)
    .bind(
      crypto.randomUUID(), input.workspaceId, input.eventType, input.entityType, input.entityId,
      JSON.stringify(sanitizeEventPayload(input.payload)), input.actorUserId ?? null, cleanText(input.requestId, 120),
    );
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
