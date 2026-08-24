import type {
  Connector, ConnectorStatus, IntegrationChannel, IntegrationRun, IntegrationsOverview, Mapping,
  MappingStatus, QueueState, Reconciliation, RunDetail, RunItem, RunJob, RunStatus,
} from "./integrations.types";

export type Row = Record<string, unknown>;
const value = (row: Row, camel: string, snake: string = camel) => row[camel] ?? row[snake];
const text = (input: unknown) => input == null ? "" : String(input);
const number = (input: unknown) => Number(input) || 0;
const bool = (input: unknown) => input === true || input === 1 || input === "1" || input === "true";
const object = (input: unknown): Row => {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Row;
  if (typeof input === "string") {
    try { const parsed = JSON.parse(input); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {}; }
    catch { return {}; }
  }
  return {};
};

/* Os canais que o servidor pode mandar. `tangerino_browser` faltava, e a
   consequência não era o campo sumir: o canal desconhecido caía no `"erp"` da
   normalização abaixo, e o Agente Tangerino chegava à tela **como se fosse o
   conector de ERP** — com o formulário genérico pedindo endpoint obrigatório e
   sem oferecer usuário e senha. */
const channels = new Set(["email", "whatsapp", "teams", "drive", "onedrive", "solides", "tangerino", "erp", "sankhya_browser", "tangerino_browser"]);
const connectorStatuses = new Set(["connected", "needs_credentials", "paused", "error", "requires_user_action"]);
const mappingStatuses = new Set(["draft", "active", "archived"]);
const runStatuses = new Set(["queued", "running", "authenticating", "navigating", "processing", "extracting", "importing", "succeeded", "partial", "failed", "requires_user_action", "canceled"]);

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.message || payload.error || "Não foi possível concluir a operação.");
  return payload;
}

export function normalizeConnector(row: Row): Connector {
  const rawChannel = text(row.channel);
  const rawStatus = text(row.status);
  return {
    id: text(row.id),
    /* Canal desconhecido fica como veio, e não vira "erp".
       Trocar um canal por outro real é o pior desfecho possível: a tela passa a
       oferecer o formulário de outro conector, com outra regra, e ninguém vê
       erro nenhum — foi exatamente assim que o Agente Tangerino passou meses
       pedindo endpoint. Um canal estranho na tela é visível; um canal
       silenciosamente trocado é uma armadilha. */
    channel: (channels.has(rawChannel) ? rawChannel : rawChannel || "erp") as IntegrationChannel,
    displayName: text(value(row, "displayName", "display_name")),
    status: (connectorStatuses.has(rawStatus) ? rawStatus : "needs_credentials") as ConnectorStatus,
    lastSyncAt: text(value(row, "lastSyncAt", "last_sync_at")),
    lastError: text(value(row, "lastError", "last_error")),
    updatedAt: text(value(row, "updatedAt", "updated_at")),
    hasCredentials: bool(value(row, "hasCredentials", "has_credentials")),
    hasWebhookSecret: bool(value(row, "hasWebhookSecret", "has_webhook_secret")),
    credentialId: text(value(row, "credentialId", "credential_id")),
    fingerprint: text(row.fingerprint),
    keyVersion: number(value(row, "keyVersion", "key_version")),
    verifiedAt: text(value(row, "verifiedAt", "verified_at")),
    expiresAt: text(value(row, "expiresAt", "expires_at")),
    publicHint: text(value(row, "publicHint", "public_hint")),
    config: row.config && typeof row.config === "object" ? row.config as Connector["config"] : null,
    lastConnectionAt: text(value(row, "lastConnectionAt", "last_connection_at")),
    lastSuccessfulSyncAt: text(value(row, "lastSuccessfulSyncAt", "last_successful_sync_at")),
    nextSyncAt: text(value(row, "nextSyncAt", "next_sync_at")),
    scheduleEnabled: bool(value(row, "scheduleEnabled", "schedule_enabled")),
    connectorVersion: text(value(row, "connectorVersion", "connector_version")),
  };
}

export function normalizeMapping(row: Row): Mapping {
  const rawStatus = text(row.status);
  return {
    id: text(row.id), integrationId: text(value(row, "integrationId", "integration_id")),
    resourceType: text(value(row, "resourceType", "resource_type")), direction: text(row.direction),
    version: number(row.version), status: (mappingStatuses.has(rawStatus) ? rawStatus : "draft") as MappingStatus,
    checksum: text(row.checksum), publishedAt: text(value(row, "publishedAt", "published_at")),
    createdAt: text(value(row, "createdAt", "created_at")),
  };
}

export function normalizeRun(row: Row): IntegrationRun {
  const rawStatus = text(row.status);
  return {
    id: text(row.id), integrationId: text(value(row, "integrationId", "integration_id")), displayName: text(value(row, "displayName", "display_name")),
    mappingId: text(value(row, "mappingId", "mapping_id")), triggerType: text(value(row, "triggerType", "trigger_type")),
    status: (runStatuses.has(rawStatus) ? rawStatus : "queued") as RunStatus, attempt: number(row.attempt),
    receivedCount: number(value(row, "receivedCount", "received_count")), processedCount: number(value(row, "processedCount", "processed_count")),
    skippedCount: number(value(row, "skippedCount", "skipped_count")), conflictCount: number(value(row, "conflictCount", "conflict_count")),
    failedCount: number(value(row, "failedCount", "failed_count")), errorCode: text(value(row, "errorCode", "error_code")),
    updatedCount: number(value(row, "updatedCount", "updated_count")), unchangedCount: number(value(row, "unchangedCount", "unchanged_count")),
    durationMs: number(value(row, "durationMs", "duration_ms")), summary: text(row.summary),
    errorMessage: text(value(row, "errorMessage", "error_message")), startedAt: text(value(row, "startedAt", "started_at")),
    completedAt: text(value(row, "completedAt", "completed_at")), createdAt: text(value(row, "createdAt", "created_at")),
  };
}

export function normalizeReconciliation(row: Row): Reconciliation {
  const differences = object(value(row, "differences", "differences_json"));
  const declaredFields = [differences.fields, differences.missingFields, differences.missing_fields]
    .flatMap((entry) => Array.isArray(entry) ? entry : [])
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .map((entry) => entry.trim());
  const structuralKeys = new Set(["fields", "missingFields", "missing_fields"]);
  const namedKeys = Object.keys(differences).filter((key) => !structuralKeys.has(key));
  return {
    id: text(row.id), integrationId: text(value(row, "integrationId", "integration_id")), runId: text(value(row, "runId", "run_id")),
    displayName: text(value(row, "displayName", "display_name")), entityType: text(value(row, "entityType", "entity_type")),
    externalId: text(value(row, "externalId", "external_id")), internalId: text(value(row, "internalId", "internal_id")),
    status: text(row.status) === "conflict" ? "conflict" : "unmatched",
    differenceFields: [...new Set([...declaredFields, ...namedKeys])].slice(0, 20),
    createdAt: text(value(row, "createdAt", "created_at")),
  };
}

export function normalizeOverview(payload: Row): IntegrationsOverview {
  const permissions = object(payload.permissions);
  return {
    connectors: Array.isArray(payload.connectors) ? payload.connectors.map((row) => normalizeConnector(row as Row)) : [],
    mappings: Array.isArray(payload.mappings) ? payload.mappings.map((row) => normalizeMapping(row as Row)) : [],
    runs: Array.isArray(payload.runs) ? payload.runs.map((row) => normalizeRun(row as Row)) : [],
    reconciliations: Array.isArray(payload.reconciliations) ? payload.reconciliations.map((row) => normalizeReconciliation(row as Row)) : [],
    queue: Array.isArray(payload.queue) ? payload.queue.map((row) => ({ status: text((row as Row).status), count: number((row as Row).count) } as QueueState)) : [],
    permissions: {
      manage: bool(permissions.manage), run: bool(permissions.run), reconcile: bool(permissions.reconcile), view: bool(permissions.view),
      credentialsManage: bool(permissions.credentialsManage), execute: bool(permissions.execute), logsView: bool(permissions.logsView),
    },
    sankhyaEnabled: bool(payload.sankhyaEnabled),
    companies: Array.isArray(payload.companies) ? payload.companies.map((row) => {
      const company = row as Row;
      return { id: text(company.id), legalName: text(value(company, "legalName", "legal_name")), tradeName: text(value(company, "tradeName", "trade_name")) };
    }) : [],
    solidesBoundary: text(value(payload, "solidesBoundary", "solides_boundary")),
  };
}

function metadataKeys(input: unknown) {
  const metadata = object(input);
  const declared = Array.isArray(metadata.mappedFields) ? metadata.mappedFields.filter((item): item is string => typeof item === "string") : [];
  const missing = Array.isArray(metadata.missingFields) ? metadata.missingFields.filter((item): item is string => typeof item === "string") : [];
  return [...new Set([...declared, ...missing, ...Object.keys(metadata)])].slice(0, 24);
}

function normalizeItem(row: Row): RunItem {
  return {
    id: text(row.id), itemKey: text(value(row, "itemKey", "item_key")), direction: text(row.direction), status: text(row.status),
    targetType: text(value(row, "targetType", "target_type")), errorCode: text(value(row, "errorCode", "error_code")),
    errorMessage: text(value(row, "errorMessage", "error_message")), processedAt: text(value(row, "processedAt", "processed_at")),
    createdAt: text(value(row, "createdAt", "created_at")), metadataFields: metadataKeys(value(row, "metadata", "metadata_json")),
  };
}

function normalizeJob(row: Row): RunJob {
  return {
    id: text(row.id), jobType: text(value(row, "jobType", "job_type")), status: text(row.status), attempt: number(row.attempt),
    maxAttempts: number(value(row, "maxAttempts", "max_attempts")), availableAt: text(value(row, "availableAt", "available_at")),
    lastErrorCode: text(value(row, "lastErrorCode", "last_error_code")), lastErrorMessage: text(value(row, "lastErrorMessage", "last_error_message")),
    completedAt: text(value(row, "completedAt", "completed_at")), createdAt: text(value(row, "createdAt", "created_at")),
  };
}

export function normalizeRunDetail(payload: Row): RunDetail {
  const runRow = object(payload.run);
  return {
    run: {
      ...normalizeRun(runRow), channel: text(runRow.channel), resourceType: text(value(runRow, "resourceType", "resource_type")),
      direction: text(runRow.direction), mappingVersion: number(value(runRow, "mappingVersion", "mapping_version")),
    },
    items: Array.isArray(payload.items) ? payload.items.map((row) => normalizeItem(row as Row)) : [],
    jobs: Array.isArray(payload.jobs) ? payload.jobs.map((row) => normalizeJob(row as Row)) : [],
  };
}
