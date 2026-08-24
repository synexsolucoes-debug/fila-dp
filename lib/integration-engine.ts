import { createHash } from "node:crypto";
import { getD1 } from "@/db";
import { prepareAgentOutcome } from "./agent-scheduler";
import { prepareActivity } from "./fila-dp-db";
import { ApiError } from "./api-errors";
import { computeSlaStatus } from "./fila-dp-api";
import { addBusinessDays } from "./fila-dp-relations";
import { workingDayMinutes } from "./fila-dp-sla";
import { admissionIsComplete } from "./admissions";
import { completeIntegrationEvent, recordIntegrationEvent } from "./integration-events";
import { log } from "./observability";
import { admissionTaskDraft as solidesTaskDraft, normalizeSolidesAdmission, solidesAdmissionsUrl, solidesAuthorization } from "./solides";
import { admissionTaskDraft as tangerinoTaskDraft, normalizeTangerinoAdmission, tangerinoAuthorization, tangerinoEmployeesUrl, tangerinoErpReadiness, tangerinoRecords, tangerinoSkipReason } from "./tangerino";
import {
  mappingDirection,
  mappingResource,
  openCredentials,
  retryDelaySeconds,
  safeIntegrationError,
  sanitizeMapping,
  stableJson,
  validateConnectorEndpoint,
  type MappingField,
} from "./integrations";

type Database = ReturnType<typeof getD1>;
type CredentialRow = {
  id: string;
  encrypted_value: string;
  initialization_vector: string;
  auth_tag: string;
  key_version: number;
};
type IntegrationRow = { id: string; channel: string; status: string; config_json: string };
type MappingRow = { id: string; resource_type: string; direction: string; mapping_json: Record<string, unknown> | string };
type JobRow = { id: string; integration_id: string; run_id: string; attempt: number; max_attempts: number; lease_token: string };

function text(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try { return asRecord(JSON.parse(value)); } catch { return {}; }
}

function readPath(source: Record<string, unknown>, path: string) {
  return path.split(".").reduce<unknown>((current, segment) => asRecord(current)[segment], source);
}

function transformValue(value: unknown, transform: string) {
  if (value === null || value === undefined) return "";
  if (transform === "trim") return String(value).trim();
  if (transform === "uppercase") return String(value).trim().toUpperCase();
  if (transform === "lowercase") return String(value).trim().toLowerCase();
  if (transform === "date") {
    const candidate = String(value).trim();
    const parsed = new Date(candidate);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  }
  if (transform === "number" || transform === "integer") {
    const normalized = typeof value === "string" ? value.replace(/\./gu, "").replace(",", ".") : value;
    const number = Number(normalized);
    return Number.isFinite(number) ? (transform === "integer" ? Math.round(number) : number) : 0;
  }
  if (transform === "boolean") return value === true || value === 1 || ["true", "1", "sim", "yes"].includes(String(value).toLowerCase());
  return typeof value === "object" ? "" : value;
}

function mapRecord(record: Record<string, unknown>, fields: MappingField[]) {
  const mapped: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const value = transformValue(readPath(record, field.source), field.transform);
    if (field.required && (value === "" || value === null || value === undefined)) missing.push(field.target);
    mapped[field.target] = value;
  }
  return { mapped, missing };
}

function providerRecords(payload: Record<string, unknown>) {
  const responseBody = asRecord(payload.responseBody);
  // A Sólides DP responde com o envelope `Page` do Spring: os registros vêm em `content`.
  const fromPage = tangerinoRecords(payload);
  if (fromPage.length) return fromPage.slice(0, 500);
  const records = Array.isArray(payload.items) ? payload.items
    : Array.isArray(payload.value) ? payload.value
      : Array.isArray(payload.records) ? payload.records
        : Array.isArray(responseBody.records) ? responseBody.records : [];
  return records.slice(0, 500).map(asRecord);
}

async function microsoftAccessToken(channel: string, credentials: Record<string, string>) {
  if (credentials.token) return credentials.token;
  if (!["teams", "onedrive"].includes(channel) || !credentials.clientId || !credentials.clientSecret || !credentials.tenantId) return "";
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new ApiError(502, "PROVIDER_AUTH_FAILED", "O provedor recusou a autenticação do conector.");
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new ApiError(502, "PROVIDER_AUTH_FAILED", "O provedor não retornou um token de acesso.");
  return payload.access_token;
}

async function requestProvider(integration: IntegrationRow, credential: CredentialRow) {
  const config = parseJsonObject(integration.config_json);
  const endpoint = validateConnectorEndpoint(integration.channel, config.endpoint);
  const credentials = openCredentials(integration.channel, {
    encryptedValue: credential.encrypted_value,
    initializationVector: credential.initialization_vector,
    authTag: credential.auth_tag,
    keyVersion: Number(credential.key_version),
  });
  const token = await microsoftAccessToken(integration.channel, credentials) || credentials.token || credentials.apiKey;
  if (!token) throw new ApiError(409, "INTEGRATION_CREDENTIAL_INCOMPLETE", "A credencial armazenada não possui um token utilizável.");
  const solides = integration.channel === "solides";
  const tangerino = integration.channel === "tangerino";
  // Cada produto da Sólides tem filtro próprio: Gestão corta por data de admissão,
  // DP/Tangerino corta por data de atualização (epoch em milissegundos).
  const requestUrl = solides
    ? solidesAdmissionsUrl(endpoint, { since: config.admissionsSince, pageSize: Number(config.pageSize) || 150, includeInactive: config.includeInactive === true })
    : tangerino
      ? tangerinoEmployeesUrl(endpoint, { since: config.admissionsSince, pageSize: Number(config.pageSize) || 100, includeFired: false })
      : endpoint;
  const rawBody = integration.channel === "erp" ? config.requestBody : undefined;
  const requestBody = rawBody && typeof rawBody === "object" ? stableJson(rawBody) : typeof rawBody === "string" && rawBody.trim() ? rawBody.slice(0, 32_000) : undefined;
  const response = await fetch(requestUrl, {
    method: requestBody ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      Authorization: solides ? solidesAuthorization(token) : tangerino ? tangerinoAuthorization(token) : `Bearer ${token}`,
      ...(credentials.xToken ? { "X-Token": credentials.xToken } : {}),
      ...(requestBody ? { "Content-Type": "application/json" } : {}),
    },
    body: requestBody,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new ApiError(502, "PROVIDER_REQUEST_REJECTED", `O provedor respondeu com status ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 2 * 1024 * 1024) throw new ApiError(502, "PROVIDER_RESPONSE_TOO_LARGE", "A resposta do provedor excedeu 2 MB.");
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > 2 * 1024 * 1024) throw new ApiError(502, "PROVIDER_RESPONSE_TOO_LARGE", "A resposta do provedor excedeu 2 MB.");
  // A Sólides responde com um array na raiz; os demais conectores respondem com objeto.
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? { items: parsed } : asRecord(parsed);
  } catch { throw new ApiError(502, "PROVIDER_RESPONSE_INVALID", "O provedor retornou uma resposta JSON inválida."); }
}

export async function queueIntegrationRun(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  mappingId?: string;
  triggerType?: "manual" | "scheduled" | "webhook" | "retry";
  requestedBy?: string | null;
  idempotencyKey: string;
}) {
  const key = input.idempotencyKey.trim().slice(0, 180);
  if (key.length < 8) throw ApiError.badRequest("Informe uma chave de idempotência com ao menos 8 caracteres.", "IDEMPOTENCY_KEY_REQUIRED");
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const row = await d1.prepare(`WITH selected AS (
      SELECT i.id AS integration_id, COALESCE((
        SELECT requested.id FROM fdp_integration_mappings requested
        WHERE requested.workspace_id = i.workspace_id AND requested.integration_id = i.id AND requested.id = ? AND requested.status = 'active'
      ), (
        SELECT m.id FROM fdp_integration_mappings m WHERE m.workspace_id = i.workspace_id AND m.integration_id = i.id AND m.status = 'active' ORDER BY m.published_at DESC NULLS LAST, m.created_at DESC LIMIT 1
      )) AS mapping_id
      FROM fdp_integrations i WHERE i.workspace_id = ? AND i.id = ? AND i.status = 'connected'
    ), inserted_run AS (
      INSERT INTO fdp_integration_sync_runs (id, workspace_id, integration_id, mapping_id, trigger_type, status, idempotency_key, requested_by)
      SELECT ?, ?, selected.integration_id, selected.mapping_id, ?, 'queued', ?, ? FROM selected WHERE selected.mapping_id IS NOT NULL
      ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING RETURNING *
    ), chosen_run AS (
      SELECT * FROM inserted_run UNION ALL
      SELECT existing.* FROM fdp_integration_sync_runs existing
      JOIN selected ON selected.integration_id = existing.integration_id
      WHERE existing.workspace_id = ? AND existing.idempotency_key = ? AND NOT EXISTS (SELECT 1 FROM inserted_run) LIMIT 1
    ), inserted_job AS (
      INSERT INTO fdp_integration_jobs (id, workspace_id, integration_id, run_id, idempotency_key, payload_json)
      SELECT ?, ?, chosen_run.integration_id, chosen_run.id, 'run:' || chosen_run.id, jsonb_build_object('runId', chosen_run.id) FROM chosen_run
      -- Um agente por vez (§31). O índice único parcial garante a invariante no
      -- banco; esta condição faz com que a segunda chamada simplesmente não
      -- insira, em vez de estourar erro de restrição em quem só reenviou.
      WHERE NOT EXISTS (
        SELECT 1 FROM fdp_integration_jobs active
        WHERE active.workspace_id = chosen_run.workspace_id AND active.integration_id = chosen_run.integration_id
          AND active.status IN ('queued', 'leased')
      )
      ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING
    ) SELECT id, integration_id, mapping_id, trigger_type, status, idempotency_key, created_at FROM chosen_run`)
    .bind(input.mappingId || null, input.workspaceId, input.integrationId, runId, input.workspaceId, input.triggerType ?? "manual", key, input.requestedBy ?? null, input.workspaceId, key, jobId, input.workspaceId)
    .first<Record<string, unknown>>();
  if (!row) throw new ApiError(409, "INTEGRATION_NOT_READY", "Verifique a conexão e ative um mapeamento antes de sincronizar.");
  return row;
}

/** Processo do Vinculato que recebe as admissões concluídas na Sólides. A admissão digital continua na Sólides. */
const admissionProcessType = "CONCILIAÇÃO CADASTRAL";

type AdmissionContext = {
  /** Data de corte configurada; o Tangerino precisa dela para separar admissão de atualização. */
  since: string;
  boardId: string;
  listId: string;
  slaBehavior: string;
  companyId: string | null;
  companyName: string;
  dueAt: string;
  slaTargetMinutes: number;
  templateId: string | null;
};

type ItemInput = {
  workspaceId: string; integrationId: string; runId: string; mappingId: string; itemKey: string; externalId: string;
  payloadHash: string; resource: string; mapped: Record<string, unknown>; missing: string[];
  raw: Record<string, unknown>; admission: AdmissionContext | null; channel: string;
};

/**
 * Resolve uma vez por execução o quadro, a coluna de entrada, a empresa e o prazo das
 * tarefas de conciliação, em vez de repetir as consultas a cada colaborador recebido.
 */
async function loadAdmissionContext(d1: Database, workspaceId: string, config: Record<string, unknown>): Promise<AdmissionContext> {
  const requestedBoardId = text(config.boardId, 80);
  const requestedCompanyId = text(config.companyId, 80);
  const [target, settings, holidays, policy, template, company] = await Promise.all([
    d1.prepare(`SELECT board.id AS board_id, list.id AS list_id, list.sla_behavior FROM fdp_boards board
      JOIN fdp_lists list ON list.workspace_id = board.workspace_id AND list.board_id = board.id AND list.kind = 'new'
      WHERE board.workspace_id = ? AND (? = '' OR board.id = ?) ORDER BY board.created_at, board.name LIMIT 1`)
      .bind(workspaceId, requestedBoardId, requestedBoardId).first<{ board_id: string; list_id: string; sla_behavior: string }>(),
    d1.prepare("SELECT business_days_json, day_start, day_end FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspaceId).first<{ business_days_json: string; day_start: string; day_end: string }>(),
    d1.prepare("SELECT holiday_date FROM fdp_business_holidays WHERE workspace_id = ?").bind(workspaceId).all<{ holiday_date: string }>(),
    d1.prepare("SELECT target_business_days FROM fdp_sla_policies WHERE workspace_id = ? AND process_type = ? AND active = 1").bind(workspaceId, admissionProcessType).first<{ target_business_days: number }>(),
    d1.prepare("SELECT id, default_sla_days FROM fdp_process_templates WHERE workspace_id = ? AND process_type = ? AND active = 1 ORDER BY position LIMIT 1").bind(workspaceId, admissionProcessType).first<{ id: string; default_sla_days: number }>(),
    requestedCompanyId
      ? d1.prepare("SELECT id, trade_name, legal_name FROM fdp_companies WHERE workspace_id = ? AND id = ?").bind(workspaceId, requestedCompanyId).first<{ id: string; trade_name: string; legal_name: string }>()
      : Promise.resolve(null),
  ]);
  if (!target) {
    throw new ApiError(409, "INTEGRATION_TARGET_BOARD_MISSING", "Configure um quadro com coluna de entrada para receber as conciliações da Sólides.");
  }
  if (requestedCompanyId && !company) {
    throw new ApiError(409, "INTEGRATION_TARGET_COMPANY_MISSING", "A empresa configurada para as conciliações da Sólides não existe neste workspace.");
  }
  const businessDays = settings ? (JSON.parse(settings.business_days_json) as number[]) : [1, 2, 3, 4, 5];
  const holidaySet = new Set(holidays.results.map((item) => item.holiday_date));
  const dayEnd = settings?.day_end ?? "18:00";
  const targetDays = Number(template?.default_sla_days ?? policy?.target_business_days ?? 2);
  return {
    since: text(config.admissionsSince, 10),
    boardId: target.board_id,
    listId: target.list_id,
    slaBehavior: target.sla_behavior,
    companyId: company?.id ?? null,
    companyName: company ? (company.trade_name || company.legal_name) : "",
    dueAt: `${addBusinessDays(new Date().toISOString().slice(0, 10), targetDays, businessDays, holidaySet)}T${dayEnd}`,
    slaTargetMinutes: targetDays * workingDayMinutes({ dayStart: settings?.day_start ?? "08:00", dayEnd }),
    templateId: template?.id ?? null,
  };
}

async function insertGenericItem(d1: Database, input: {
  workspaceId: string; integrationId: string; runId: string; mappingId: string; itemKey: string; externalId: string;
  payloadHash: string; resource: string; mapped: Record<string, unknown>; missing: string[];
}) {
  const itemId = crypto.randomUUID();
  const reconciliationId = crypto.randomUUID();
  const status = input.missing.length ? "failed" : "conflict";
  const row = await d1.prepare(`WITH inserted AS (
      INSERT INTO fdp_integration_sync_items (id, workspace_id, integration_id, run_id, mapping_id, item_key, external_id, status, payload_hash, target_type, metadata_json, error_code, error_message, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, integration_id, mapping_id, external_id, payload_hash) DO NOTHING RETURNING id
    ), reconciled AS (
      INSERT INTO fdp_integration_reconciliations (id, workspace_id, integration_id, run_id, item_id, entity_type, external_id, status, differences_json)
      SELECT ?, ?, ?, ?, inserted.id, ?, ?, ?, ?::jsonb FROM inserted RETURNING id
    ) SELECT id FROM inserted`)
    .bind(itemId, input.workspaceId, input.integrationId, input.runId, input.mappingId, input.itemKey, input.externalId, status, input.payloadHash, input.resource,
      JSON.stringify({ mappedFields: Object.keys(input.mapped), missingFields: input.missing }), input.missing.length ? "MAPPING_REQUIRED_FIELD_MISSING" : "RECONCILIATION_REQUIRED",
      input.missing.length ? "Campos obrigatórios ausentes no payload externo." : "Item aguardando conciliação.", reconciliationId, input.workspaceId, input.integrationId, input.runId,
      input.resource === "employees" || input.resource === "admissions" ? "employee" : input.resource === "hr_metrics" ? "hr_metric" : input.resource === "files" ? "file" : "inbox",
      input.externalId, input.missing.length ? "conflict" : "unmatched", JSON.stringify({ fields: Object.keys(input.mapped), missingFields: input.missing }))
    .first<{ id: string }>();
  return row ? { processed: 0, skipped: 0, conflict: 1, failed: input.missing.length ? 1 : 0 } : { processed: 0, skipped: 1, conflict: 0, failed: 0 };
}

async function insertInboxItem(d1: Database, input: Parameters<typeof insertGenericItem>[1]) {
  if (input.missing.length) return insertGenericItem(d1, input);
  const senderName = text(input.mapped.senderName, 160) || "Solicitante externo";
  const subject = text(input.mapped.subject, 240) || "Atualização recebida";
  const body = text(input.mapped.body, 5000);
  if (!body) return insertGenericItem(d1, { ...input, missing: ["body"] });
  const itemId = crypto.randomUUID();
  const inboxId = crypto.randomUUID();
  const row = await d1.prepare(`WITH inserted AS (
      INSERT INTO fdp_integration_sync_items (id, workspace_id, integration_id, run_id, mapping_id, item_key, external_id, status, payload_hash, target_type, target_id, metadata_json, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'processed', ?, 'inbox', ?, ?::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, integration_id, mapping_id, external_id, payload_hash) DO NOTHING RETURNING id
    ), created AS (
      INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status)
      SELECT ?, ?, 'integration', ?, ?, ?, 'new' FROM inserted RETURNING id
    ) SELECT id FROM inserted`)
    .bind(itemId, input.workspaceId, input.integrationId, input.runId, input.mappingId, input.itemKey, input.externalId, input.payloadHash, inboxId,
      JSON.stringify({ mappedFields: Object.keys(input.mapped) }), inboxId, input.workspaceId, senderName, subject, body)
    .first<{ id: string }>();
  return row ? { processed: 1, skipped: 0, conflict: 0, failed: 0 } : { processed: 0, skipped: 1, conflict: 0, failed: 0 };
}

/**
 * Abre no Vinculato a tarefa de conciliação de um colaborador já admitido na Sólides.
 * O Vinculato não executa admissão digital: ele recebe o que a Sólides concluiu.
 * Uma admissão repetida reaproveita a tarefa existente em vez de duplicar trabalho.
 */
async function insertAdmissionItem(d1: Database, input: ItemInput) {
  const context = input.admission;
  if (!context) throw new ApiError(409, "INTEGRATION_TARGET_BOARD_MISSING", "Configure o destino das conciliações da Sólides antes de sincronizar.");
  const tangerino = input.channel === "tangerino";
  const admission = tangerino ? normalizeTangerinoAdmission(input.raw) : normalizeSolidesAdmission(input.raw);
  const incomplete = admissionIsComplete(admission);
  // No Tangerino, ausência desses campos também pode ser apenas uma ficha ainda
  // em preenchimento e será tratada pela regra de prontidão logo abaixo.
  if (incomplete.length && !tangerino) return insertGenericItem(d1, { ...input, missing: [...input.missing, ...incomplete] });
  // O filtro oficial do Tangerino é por atualização, não por admissão: desligamento
  // e correção de cadastro chegam na mesma janela e não podem virar conciliação.
  const skipReason = tangerino ? tangerinoSkipReason(input.raw, admission, context.since) : "";
  if (skipReason) {
    await d1.prepare(`INSERT INTO fdp_integration_sync_items (id, workspace_id, integration_id, run_id, mapping_id, item_key, external_id, status, payload_hash, target_type, metadata_json, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, integration_id, mapping_id, external_id, payload_hash) DO NOTHING`)
      .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.runId, input.mappingId, input.itemKey, input.externalId, input.payloadHash, input.resource,
        JSON.stringify({ source: input.channel, skipped: skipReason })).run();
    return { processed: 0, skipped: 1, conflict: 0, failed: 0 };
  }

  // O endpoint de colaboradores não expõe a etapa visual da Admissão Digital.
  // Para a Sólides DP, a demanda nasce somente quando os dados contratuais que o
  // ERP precisa já estão presentes. Ficha incompleta é espera normal, não falha.
  const waitingFor = tangerino ? tangerinoErpReadiness(admission) : [];
  if (waitingFor.length) {
    await d1.prepare(`INSERT INTO fdp_integration_sync_items (id, workspace_id, integration_id, run_id, mapping_id, item_key, external_id, status, payload_hash, target_type, metadata_json, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, integration_id, mapping_id, external_id, payload_hash) DO NOTHING`)
      .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.runId, input.mappingId, input.itemKey, input.externalId, input.payloadHash, input.resource,
        JSON.stringify({ source: input.channel, skipped: "aguardando dados contratuais para o ERP", missingFields: waitingFor })).run();
    return { processed: 0, skipped: 1, conflict: 0, failed: 0 };
  }

  // A mesma pessoa pode ser readmitida. O identificador da demanda combina o
  // colaborador e a data de admissão; registros antigos sem a chave composta são
  // reconhecidos pelo admissionDate guardado no metadata para não duplicar cartão.
  const demandExternalId = tangerino ? `${admission.externalId}:${admission.admissionDate}` : input.externalId;
  const demandItemKey = `${demandExternalId}:${input.payloadHash.slice(0, 16)}`;

  // A admissão entra na central de eventos antes de virar demanda. É a mesma
  // porta que o Teams atravessa, e é ela que dá a garantia de idempotência no
  // banco: a chave (workspace, integração, evento externo) é única, então uma
  // segunda execução do sincronizador não consegue sequer registrar o evento de
  // novo — e portanto não chega a abrir a segunda demanda.
  //
  // A conferência por cartão logo abaixo continua existindo: ela cobre as bases
  // que já sincronizavam antes desta central passar a existir.
  const event = await recordIntegrationEvent(d1, {
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    connector: input.channel,
    eventType: "admission",
    externalEventId: `admission:${demandExternalId}`,
    source: "polling",
    payloadHash: input.payloadHash,
    payload: { admissionDate: admission.admissionDate, externalId: admission.externalId },
  });
  if (event.kind === "duplicate" && event.event.status === "processed" && event.event.result_id) {
    await d1.prepare(`INSERT INTO fdp_integration_sync_items (id, workspace_id, integration_id, run_id, mapping_id, item_key, external_id, status, payload_hash, target_type, target_id, metadata_json, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, 'card', ?, ?::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, integration_id, mapping_id, external_id, payload_hash) DO NOTHING`)
      .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.runId, input.mappingId, demandItemKey, demandExternalId, input.payloadHash,
        event.event.result_id, JSON.stringify({ source: input.channel, skipped: "admissão já processada", eventId: event.event.id })).run();
    return { processed: 0, skipped: 1, conflict: 0, failed: 0 };
  }

  const previous = await d1.prepare(`SELECT target_id FROM fdp_integration_sync_items
    WHERE workspace_id = ? AND integration_id = ? AND target_type = 'card' AND COALESCE(target_id, '') <> ''
      AND (external_id = ? OR (external_id = ? AND COALESCE(metadata_json->>'admissionDate', '') = ?))
    ORDER BY created_at LIMIT 1`)
    .bind(input.workspaceId, input.integrationId, demandExternalId, input.externalId, admission.admissionDate).first<{ target_id: string }>();
  const cardId = previous?.target_id ?? crypto.randomUUID();
  const metadata = JSON.stringify({
    source: input.channel,
    sourceExternalId: admission.externalId,
    admissionDate: admission.admissionDate,
    registrationNumber: admission.registrationNumber,
    documentsPresent: admission.documentsPresent,
    documentsMissing: admission.documentsMissing,
    cardId,
  });

  if (previous) {
    await d1.prepare(`INSERT INTO fdp_integration_sync_items (id, workspace_id, integration_id, run_id, mapping_id, item_key, external_id, status, payload_hash, target_type, target_id, metadata_json, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, 'card', ?, ?::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, integration_id, mapping_id, external_id, payload_hash) DO NOTHING`)
      .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.runId, input.mappingId, demandItemKey, demandExternalId, input.payloadHash, cardId, metadata).run();
    // Demanda que já existia de uma sincronização anterior a esta central:
    // o evento fecha apontando para ela, e a próxima execução para na porta.
    await completeIntegrationEvent(d1, input.workspaceId, event.event.id, {
      status: "processed", resultType: "card", resultId: cardId,
    });
    return { processed: 0, skipped: 1, conflict: 0, failed: 0 };
  }

  const draft = tangerino ? tangerinoTaskDraft(admission) : solidesTaskDraft(admission);
  const created = await d1.prepare(`WITH inserted AS (
      INSERT INTO fdp_integration_sync_items (id, workspace_id, integration_id, run_id, mapping_id, item_key, external_id, status, payload_hash, target_type, target_id, metadata_json, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'processed', ?, 'card', ?, ?::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, integration_id, mapping_id, external_id, payload_hash) DO NOTHING RETURNING id
    ), created AS (
      INSERT INTO fdp_cards (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority, due_at, sla_status, position, source_type, created_by, sla_target_minutes, sla_started_at, process_template_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?,
        COALESCE((SELECT MAX(position) FROM fdp_cards WHERE list_id = ? AND archived = 0), 0) + 1000,
        'integration', ?, ?, CURRENT_TIMESTAMP, ?
      FROM inserted RETURNING id
    ) SELECT id FROM created`)
    .bind(
      crypto.randomUUID(), input.workspaceId, input.integrationId, input.runId, input.mappingId, demandItemKey, demandExternalId, input.payloadHash, cardId, metadata,
      cardId, input.workspaceId, context.boardId, context.listId, draft.title, draft.description, context.companyId, context.companyName || admission.unityName,
      admissionProcessType, context.dueAt, computeSlaStatus(context.dueAt, context.slaBehavior), context.listId, `integracao:${input.channel}`, context.slaTargetMinutes, context.templateId,
    )
    .first<{ id: string }>();
  if (!created) {
    await completeIntegrationEvent(d1, input.workspaceId, event.event.id, {
      status: "ignored", reason: "item já registrado nesta execução",
    });
    return { processed: 0, skipped: 1, conflict: 0, failed: 0 };
  }

  await completeIntegrationEvent(d1, input.workspaceId, event.event.id, {
    status: "processed", resultType: "card", resultId: cardId,
  });
  log("info", "integration.demand_created", { workspaceId: input.workspaceId, connectorId: input.integrationId }, {
    source: input.channel, eventId: event.event.id, cardId, processType: admissionProcessType,
  });

  await d1.batch([
    ...draft.checklist.map((item, index) => d1.prepare("INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position) VALUES (?, ?, ?, ?, 0, ?)")
      .bind(crypto.randomUUID(), input.workspaceId, cardId, item, (index + 1) * 1000)),
    /* A demanda nasceu de uma leitura automática, e a linha do tempo dela
       precisa dizer isso (§45). Sem este registro, o histórico começava com a
       primeira ação humana e ninguém conseguia responder "de onde veio esta
       demanda?" sem abrir o log do servidor. */
    prepareActivity(input.workspaceId, cardId, "SYSTEM", "integration.demand_created", {
      source: input.channel, externalId: admission.externalId, admissionDate: admission.admissionDate,
    }),
  ]);
  return { processed: 1, skipped: 0, conflict: 0, failed: 0 };
}

async function executeRun(d1: Database, workspaceId: string, job: JobRow) {
  const row = await d1.prepare(`SELECT i.id, i.channel, i.status, i.config_json,
      m.id AS mapping_id, m.resource_type, m.direction, m.mapping_json
    FROM fdp_integration_sync_runs r
    JOIN fdp_integrations i ON i.workspace_id = r.workspace_id AND i.id = r.integration_id
    JOIN fdp_integration_mappings m ON m.workspace_id = r.workspace_id AND m.integration_id = r.integration_id AND m.id = r.mapping_id AND m.status = 'active'
    WHERE r.workspace_id = ? AND r.id = ? AND r.status IN ('queued', 'running') AND i.status = 'connected'`)
    .bind(workspaceId, job.run_id).first<Record<string, unknown>>();
  if (!row) throw new ApiError(409, "SYNC_RUN_NOT_EXECUTABLE", "A execução não possui conector e mapeamento ativos.");
  const integration: IntegrationRow = { id: String(row.id), channel: String(row.channel), status: String(row.status), config_json: String(row.config_json ?? "{}") };
  const mapping: MappingRow = { id: String(row.mapping_id), resource_type: String(row.resource_type), direction: String(row.direction), mapping_json: row.mapping_json as Record<string, unknown> | string };
  const credential = await d1.prepare(`SELECT id, encrypted_value, initialization_vector, auth_tag, key_version
    FROM fdp_integration_credentials WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY created_at DESC LIMIT 1`)
    .bind(workspaceId, integration.id).first<CredentialRow>();
  if (!credential) throw new ApiError(409, "INTEGRATION_CREDENTIAL_REQUIRED", "O conector não possui uma credencial ativa.");

  await d1.prepare("UPDATE fdp_integration_sync_runs SET status = 'running', attempt = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), error_code = '', error_message = '' WHERE workspace_id = ? AND id = ?")
    .bind(job.attempt, workspaceId, job.run_id).run();
  const payload = await requestProvider(integration, credential);
  const rawMapping = parseJsonObject(mapping.mapping_json);
  const { mapping: safeMapping } = sanitizeMapping(rawMapping);
  const resource = mappingResource(mapping.resource_type);
  const direction = mappingDirection(mapping.direction);
  if (direction === "outbound") throw new ApiError(409, "OUTBOUND_EXECUTOR_NOT_AVAILABLE", "Este executor processa somente mapeamentos de entrada ou bidirecionais.");
  const records = providerRecords(payload);
  // O destino das conciliações é resolvido uma única vez, e não a cada colaborador recebido.
  const admissionContext = resource === "admissions" ? await loadAdmissionContext(d1, workspaceId, parseJsonObject(integration.config_json)) : null;
  const totals = { processed: 0, skipped: 0, conflict: 0, failed: 0 };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const externalId = text(readPath(record, safeMapping.externalIdField), 180) || `row-${index + 1}`;
    const { mapped, missing } = mapRecord(record, safeMapping.fields);
    // Admissões usam o registro original no hash: mudanças na ficha precisam ser percebidas
    // mesmo quando o mapeamento publicado cobre poucos campos.
    const payloadHash = createHash("sha256").update(stableJson(resource === "admissions" ? record : mapped)).digest("hex");
    const common = { workspaceId, integrationId: integration.id, runId: job.run_id, mappingId: mapping.id, itemKey: `${externalId}:${payloadHash.slice(0, 16)}`, externalId, payloadHash, resource, mapped, missing, raw: record, admission: admissionContext, channel: integration.channel };
    const result = resource === "inbox" ? await insertInboxItem(d1, common)
      : resource === "admissions" ? await insertAdmissionItem(d1, common)
        : await insertGenericItem(d1, common);
    totals.processed += result.processed;
    totals.skipped += result.skipped;
    totals.conflict += result.conflict;
    totals.failed += result.failed;
  }
  const finalStatus = totals.failed || totals.conflict ? (totals.processed ? "partial" : "failed") : "succeeded";
  await d1.batch([
    d1.prepare(`UPDATE fdp_integration_sync_runs SET status = ?, received_count = ?, processed_count = ?, skipped_count = ?, conflict_count = ?, failed_count = ?, completed_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ?`).bind(finalStatus, records.length, totals.processed, totals.skipped, totals.conflict, totals.failed, workspaceId, job.run_id),
    d1.prepare("UPDATE fdp_integration_credentials SET verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?").bind(workspaceId, credential.id),
    d1.prepare("UPDATE fdp_integrations SET status = 'connected', last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?").bind(workspaceId, integration.id),
    d1.prepare("UPDATE fdp_integration_jobs SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP, lease_token = '', lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND lease_token = ?").bind(workspaceId, job.id, job.lease_token),
    /* Zera a contagem de falhas e marca a última leitura bem-sucedida (§34).
       Sem isto, um conector que se recuperou continuaria "degradado" na tela
       até alguém mexer nele à mão. */
    prepareAgentOutcome(d1, { workspaceId, integrationId: integration.id, succeeded: true }),
  ]);
  return { runId: job.run_id, status: finalStatus, received: records.length, ...totals };
}

export async function processNextIntegrationJob(d1: Database, workspaceId: string) {
  const leaseToken = crypto.randomUUID();
  const job = await d1.prepare(`WITH candidate AS (
      SELECT job.id FROM fdp_integration_jobs job
      WHERE job.workspace_id = ? AND job.status IN ('queued', 'leased') AND job.available_at <= CURRENT_TIMESTAMP
        AND EXISTS (SELECT 1 FROM fdp_integrations integration WHERE integration.workspace_id = job.workspace_id
          AND integration.id = job.integration_id AND integration.channel <> 'sankhya_browser')
        AND (job.status = 'queued' OR job.lease_expires_at < CURRENT_TIMESTAMP) ORDER BY job.available_at, job.created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE fdp_integration_jobs job SET status = 'leased', lease_token = ?, lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '2 minutes',
      attempt = job.attempt + 1, updated_at = CURRENT_TIMESTAMP FROM candidate WHERE job.id = candidate.id
    RETURNING job.id, job.integration_id, job.run_id, job.attempt, job.max_attempts, job.lease_token`)
    .bind(workspaceId, leaseToken).first<JobRow>();
  if (!job) return null;
  try {
    return await executeRun(d1, workspaceId, job);
  } catch (error) {
    const safe = safeIntegrationError(error);
    const exhausted = Number(job.attempt) >= Number(job.max_attempts);
    const nextStatus = exhausted ? "dead_letter" : "queued";
    const delay = retryDelaySeconds(Number(job.attempt));
    await d1.batch([
      d1.prepare(`UPDATE fdp_integration_jobs SET status = ?, available_at = CURRENT_TIMESTAMP + make_interval(secs => ?), lease_token = '', lease_expires_at = NULL,
        last_error_code = ?, last_error_message = ?, completed_at = CASE WHEN ? = 'dead_letter' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ? AND lease_token = ?`).bind(nextStatus, delay, safe.code, safe.message, nextStatus, workspaceId, job.id, job.lease_token),
      d1.prepare("UPDATE fdp_integration_sync_runs SET status = ?, attempt = ?, error_code = ?, error_message = ?, completed_at = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE workspace_id = ? AND id = ?")
        .bind(exhausted ? "failed" : "queued", job.attempt, safe.code, safe.message, exhausted ? "failed" : "queued", workspaceId, job.run_id),
      d1.prepare("UPDATE fdp_integrations SET status = CASE WHEN channel = 'solides' THEN 'needs_credentials' ELSE 'error' END, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(safe.message, workspaceId, job.integration_id),
      /* Espera crescente até a próxima leitura da origem (§33) e marcação de
         degradado depois de falhas seguidas (§34). É distinto da retentativa do
         job: aquela tenta de novo o mesmo trabalho, esta afasta a próxima ida ao
         sistema externo que já se sabe indisponível. */
      prepareAgentOutcome(d1, { workspaceId, integrationId: job.integration_id, succeeded: false }),
    ]);
    return { runId: job.run_id, status: nextStatus, attempt: job.attempt, retryInSeconds: exhausted ? null : delay, error: safe.message };
  }
}

export async function verifyIntegration(d1: Database, workspaceId: string, integrationId: string) {
  const integration = await d1.prepare("SELECT id, channel, status, config_json FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, integrationId).first<IntegrationRow>();
  if (!integration) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
  const credential = await d1.prepare(`SELECT id, encrypted_value, initialization_vector, auth_tag, key_version FROM fdp_integration_credentials
    WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ORDER BY created_at DESC LIMIT 1`).bind(workspaceId, integrationId).first<CredentialRow>();
  if (!credential) throw new ApiError(409, "INTEGRATION_CREDENTIAL_REQUIRED", "O conector não possui uma credencial ativa.");
  await requestProvider(integration, credential);
  const activated = await d1.prepare(`WITH lock AS (
      SELECT pg_advisory_xact_lock(hashtext(?))
    ), entitlement AS (
      SELECT plan.integration_limit FROM fdp_workspace_subscriptions subscription
      JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
      WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
    ), integration_updated AS (
      UPDATE fdp_integrations target SET status = 'connected', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE target.workspace_id = ? AND target.id = ? AND (
        target.status = 'connected' OR
        (SELECT COUNT(*) FROM fdp_integrations connected WHERE connected.workspace_id = ? AND connected.status = 'connected') < COALESCE((SELECT integration_limit FROM entitlement), 0)
      ) RETURNING target.id
    ), credential_updated AS (
      UPDATE fdp_integration_credentials SET verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND EXISTS (SELECT 1 FROM integration_updated)
      RETURNING id
    ) SELECT id FROM integration_updated`)
    .bind(workspaceId, workspaceId, workspaceId, integrationId, workspaceId, workspaceId, credential.id)
    .first<{ id: string }>();
  if (!activated) throw new ApiError(409, "PLAN_INTEGRATION_LIMIT", "O plano atual atingiu o limite de integrações conectadas.");
  return { connected: true, verifiedAt: new Date().toISOString() };
}
