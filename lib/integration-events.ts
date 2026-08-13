/**
 * Central de eventos de integração.
 *
 * Todo evento externo que possa gerar trabalho interno entra por aqui antes de
 * gerar qualquer coisa. O serviço existe para responder uma pergunta só, e
 * responder sempre da mesma forma:
 *
 *   "este evento, deste conector, deste workspace, já foi processado?"
 *
 * A resposta vem do banco — do índice único
 * `(workspace_id, integration_id, external_event_id)` — e não de uma verificação
 * em código. A diferença importa: duas entregas simultâneas do mesmo webhook
 * passam pela verificação em código ao mesmo tempo e as duas abrem demanda. Com
 * a constraint, a segunda inserção falha e o `ON CONFLICT DO NOTHING` devolve
 * "já existe", que é a resposta correta mesmo sob concorrência.
 *
 * Estados: `received` → `processing` → `processed` | `ignored` | `error`,
 * com `reprocessed` para a reexecução deliberada de um evento que falhou.
 */
import { ApiError } from "./api-errors.ts";
import { log } from "./observability.ts";

export type IntegrationEventStatus =
  | "received" | "processing" | "processed" | "ignored" | "error" | "reprocessed";

export type IntegrationEventSource = "webhook" | "polling" | "manual" | "retry";

export const integrationEventStatuses: readonly IntegrationEventStatus[] = [
  "received", "processing", "processed", "ignored", "error", "reprocessed",
];

/** Rótulos em português para a tela de logs — o operador não lê o enum. */
export const INTEGRATION_EVENT_STATUS_LABELS: Record<IntegrationEventStatus, string> = {
  received: "Recebido",
  processing: "Processando",
  processed: "Processado",
  ignored: "Ignorado",
  error: "Erro",
  reprocessed: "Reprocessado",
};

type Statement = {
  bind: (...args: unknown[]) => {
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
    run: () => Promise<unknown>;
  };
};
export type EventDatabase = { prepare: (query: string) => Statement };

export type IntegrationEventRow = {
  id: string;
  workspace_id: string;
  integration_id: string;
  connector: string;
  event_type: string;
  external_event_id: string;
  status: IntegrationEventStatus;
  result_type: string;
  result_id: string;
  error_code: string;
  error_message: string;
  retry_count: number;
  received_at: string;
  processed_at: string | null;
};

export type RecordEventInput = {
  workspaceId: string;
  integrationId: string;
  connector: string;
  eventType: string;
  /** Identificador do evento na origem. Vazio faz o serviço recusar: sem ele não há idempotência. */
  externalEventId: string;
  source?: IntegrationEventSource;
  payload?: Record<string, unknown>;
  payloadHash?: string;
};

export type RecordEventResult =
  | { kind: "new"; event: IntegrationEventRow }
  | { kind: "duplicate"; event: IntegrationEventRow };

function trimmed(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Registra o evento e diz se ele é novo.
 *
 * `duplicate` não é erro: é a resposta esperada quando o provedor reentrega o
 * webhook ou o sincronizador roda de novo. Quem chama deve simplesmente não
 * gerar nada e responder 200 — reentrega tratada como falha faz o provedor
 * tentar de novo para sempre.
 */
export async function recordIntegrationEvent(
  d1: EventDatabase,
  input: RecordEventInput,
): Promise<RecordEventResult> {
  const workspaceId = trimmed(input.workspaceId, 100);
  const integrationId = trimmed(input.integrationId, 100);
  const externalEventId = trimmed(input.externalEventId, 300);
  if (!workspaceId || !integrationId) {
    throw new ApiError(500, "INTEGRATION_EVENT_SCOPE_MISSING", "Evento de integração sem workspace ou integração de origem.");
  }
  if (!externalEventId) {
    // Sem identificador estável não existe idempotência possível; quem chama
    // precisa derivar um (hash do payload serve) antes de registrar.
    throw ApiError.badRequest(
      "O evento recebido não traz identificador de origem, e sem ele não é possível evitar duplicidade.",
      "INTEGRATION_EVENT_ID_REQUIRED",
    );
  }

  const id = crypto.randomUUID();
  const inserted = await d1.prepare(
    `INSERT INTO fdp_integration_events
       (id, workspace_id, integration_id, connector, event_type, external_event_id, source, payload_hash, payload_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'received')
     ON CONFLICT (workspace_id, integration_id, external_event_id) DO NOTHING
     RETURNING id, workspace_id, integration_id, connector, event_type, external_event_id, status,
               result_type, result_id, error_code, error_message, retry_count, received_at, processed_at`,
  ).bind(
    id, workspaceId, integrationId,
    trimmed(input.connector, 40), trimmed(input.eventType, 80), externalEventId,
    input.source ?? "webhook", trimmed(input.payloadHash, 128),
    JSON.stringify(input.payload ?? {}),
  ).first<IntegrationEventRow>();

  if (inserted) {
    log("info", "integration.event_received", { workspaceId, connectorId: integrationId }, {
      eventId: inserted.id, connector: inserted.connector, eventType: inserted.event_type, source: input.source ?? "webhook",
    });
    return { kind: "new", event: inserted };
  }

  const existing = await loadEvent(d1, workspaceId, integrationId, externalEventId);
  if (!existing) {
    // Só acontece se a linha sumir entre o conflito e a leitura; tratar como
    // falha explícita é melhor do que seguir com um evento fantasma.
    throw new ApiError(409, "INTEGRATION_EVENT_CONFLICT", "O evento foi registrado por outra execução e não pôde ser lido.");
  }
  log("info", "integration.event_duplicate", { workspaceId, connectorId: integrationId }, {
    eventId: existing.id, connector: existing.connector, eventType: existing.event_type, previousStatus: existing.status,
  });
  return { kind: "duplicate", event: existing };
}

async function loadEvent(d1: EventDatabase, workspaceId: string, integrationId: string, externalEventId: string) {
  return d1.prepare(
    `SELECT id, workspace_id, integration_id, connector, event_type, external_event_id, status,
            result_type, result_id, error_code, error_message, retry_count, received_at, processed_at
       FROM fdp_integration_events
      WHERE workspace_id = ? AND integration_id = ? AND external_event_id = ?`,
  ).bind(workspaceId, integrationId, externalEventId).first<IntegrationEventRow>();
}

/**
 * Marca o evento como em processamento.
 *
 * A condição no `WHERE` é a trava: só sai de `received`, `error` ou
 * `reprocessed`. Um evento já `processed` não volta a processar, e dois
 * trabalhadores que tentem ao mesmo tempo — apenas um consegue a atualização.
 */
export async function claimIntegrationEvent(d1: EventDatabase, workspaceId: string, eventId: string) {
  const row = await d1.prepare(
    `UPDATE fdp_integration_events
        SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND status IN ('received', 'error', 'reprocessed')
      RETURNING id, status`,
  ).bind(workspaceId, eventId).first<{ id: string; status: string }>();
  return Boolean(row);
}

export type EventOutcome =
  | { status: "processed"; resultType: string; resultId: string }
  | { status: "ignored"; reason: string }
  | { status: "error"; code: string; message: string };

/** Fecha o evento com o desfecho e registra o log correspondente. */
export async function completeIntegrationEvent(
  d1: EventDatabase,
  workspaceId: string,
  eventId: string,
  outcome: EventOutcome,
) {
  const isError = outcome.status === "error";
  await d1.prepare(
    `UPDATE fdp_integration_events
        SET status = ?,
            result_type = ?,
            result_id = ?,
            error_code = ?,
            error_message = ?,
            retry_count = retry_count + ?,
            processed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ?`,
  ).bind(
    outcome.status,
    outcome.status === "processed" ? trimmed(outcome.resultType, 40) : "",
    outcome.status === "processed" ? trimmed(outcome.resultId, 100) : "",
    isError ? trimmed(outcome.code, 80) : "",
    // A mensagem já chega sanitizada por `safeIntegrationError`; o corte aqui é
    // só de tamanho, para não estourar a coluna com um erro verborrágico.
    isError ? trimmed(outcome.message, 500) : outcome.status === "ignored" ? trimmed(outcome.reason, 500) : "",
    isError ? 1 : 0,
    workspaceId, eventId,
  ).run();

  log(isError ? "error" : "info", `integration.event_${outcome.status}`, { workspaceId }, {
    eventId,
    ...(outcome.status === "processed" ? { resultType: outcome.resultType, resultId: outcome.resultId } : {}),
    ...(outcome.status === "ignored" ? { reason: outcome.reason } : {}),
    ...(isError ? { errorCode: outcome.code } : {}),
  });
}

/**
 * Executa o trabalho do evento apenas uma vez, com o estado consistente ao final.
 *
 * Concentrar o ciclo aqui evita o defeito clássico: um caminho de erro que
 * esquece de fechar o evento, deixando-o preso em `processing` para sempre e
 * bloqueando qualquer retentativa.
 */
export async function processIntegrationEvent<T>(
  d1: EventDatabase,
  workspaceId: string,
  event: IntegrationEventRow,
  handler: () => Promise<{ outcome: EventOutcome; value: T }>,
): Promise<{ handled: boolean; value: T | null }> {
  const claimed = await claimIntegrationEvent(d1, workspaceId, event.id);
  if (!claimed) return { handled: false, value: null };
  try {
    const { outcome, value } = await handler();
    await completeIntegrationEvent(d1, workspaceId, event.id, outcome);
    return { handled: true, value };
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "EVENT_PROCESSING_FAILED";
    const message = error instanceof Error ? error.message : "Falha ao processar o evento.";
    await completeIntegrationEvent(d1, workspaceId, event.id, { status: "error", code, message });
    throw error;
  }
}

/** Reabre um evento com erro para nova tentativa, preservando a contagem. */
export async function reopenIntegrationEvent(d1: EventDatabase, workspaceId: string, eventId: string) {
  const row = await d1.prepare(
    `UPDATE fdp_integration_events
        SET status = 'reprocessed', error_code = '', error_message = '', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND status IN ('error', 'ignored')
      RETURNING id`,
  ).bind(workspaceId, eventId).first<{ id: string }>();
  if (!row) {
    throw new ApiError(409, "INTEGRATION_EVENT_NOT_RETRYABLE",
      "Só é possível reprocessar eventos que terminaram em erro ou foram ignorados.");
  }
  log("info", "integration.event_reopened", { workspaceId }, { eventId });
  return row;
}

/**
 * Histórico de eventos do workspace.
 *
 * O `workspaceId` entra sempre na cláusula e nunca vem do cliente: quem chama
 * passa o workspace já resolvido pela sessão. Somado à RLS da tabela, são duas
 * barreiras independentes para o mesmo vazamento.
 */
export async function listIntegrationEvents(
  d1: EventDatabase,
  workspaceId: string,
  filters: { integrationId?: string; status?: string; connector?: string; limit?: number } = {},
) {
  const conditions = ["workspace_id = ?"];
  const parameters: unknown[] = [workspaceId];
  if (filters.integrationId) { conditions.push("integration_id = ?"); parameters.push(filters.integrationId); }
  if (filters.status && integrationEventStatuses.includes(filters.status as IntegrationEventStatus)) {
    conditions.push("status = ?");
    parameters.push(filters.status);
  }
  if (filters.connector) { conditions.push("connector = ?"); parameters.push(filters.connector); }
  const limit = Math.max(1, Math.min(200, Math.trunc(filters.limit ?? 50) || 50));

  const rows = await d1.prepare(
    `SELECT id, workspace_id, integration_id, connector, event_type, external_event_id, status,
            result_type, result_id, error_code, error_message, retry_count, received_at, processed_at
       FROM fdp_integration_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY received_at DESC
      LIMIT ${limit}`,
  ).bind(...parameters).all<IntegrationEventRow>();
  return rows.results;
}
