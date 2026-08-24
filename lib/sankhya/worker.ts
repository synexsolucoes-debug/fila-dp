import type { getD1 } from "../../db/index.ts";
import { getAttachmentsBucket } from "../../db/index.ts";
import { renewAgentLease } from "../agent-scheduler.ts";
import { DEGRADED_AFTER_FAILURES } from "../agent-schedule.ts";
import { prepareAuditEvent } from "../fila-dp-db.ts";
import { openCredentials, retryDelaySeconds } from "../integrations.ts";
import { log } from "../observability.ts";
import { prepareDomainEvent } from "../outbox.ts";
import { assertRunnableSankhyaConfig, parseSankhyaConfig, sanitizeSankhyaConfig } from "./config.ts";
import { safeSankhyaError, SankhyaConnectorError } from "./errors.ts";
import { importSankhyaEmployees } from "./importer.ts";
import type { SankhyaBrowserSession, SankhyaSessionFactory } from "./types.ts";

type Database = ReturnType<typeof getD1>;
type Job = { id: string; integration_id: string; run_id: string; job_type: string; attempt: number; max_attempts: number; lease_token: string };
type Integration = { id: string; config_json: string; status: string };
type Credential = { id: string; encrypted_value: string; initialization_vector: string; auth_tag: string; key_version: number };

/** Duração da reserva, renovada a cada fase. É o mesmo valor do `claim`. */
const LEASE_MINUTES = 20;

const phaseMessages = {
  running: "Preparando execução Sankhya",
  authenticating: "Iniciando sessão Sankhya",
  navigating: "DP Explorer localizado",
  processing: "Consulta do DP Explorer executada",
  extracting: "Coletando resultado da consulta",
  importing: "Importando dados normalizados no Vinculato",
} as const;

async function appendLog(d1: Database, input: { workspaceId: string; integrationId: string; runId: string; level?: "info" | "warn" | "error"; phase: string; code?: string; message: string; metadata?: Record<string, unknown> }) {
  const sequence = await d1.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM fdp_integration_run_logs WHERE workspace_id = ? AND run_id = ?")
    .bind(input.workspaceId, input.runId).first<{ sequence: number }>();
  const allowedMetadata = Object.fromEntries(Object.entries(input.metadata ?? {}).filter(([, value]) => typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= 120)));
  await d1.prepare(`INSERT INTO fdp_integration_run_logs
    (id, workspace_id, integration_id, run_id, sequence, level, phase, code, message, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)`)
    .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.runId, Number(sequence?.sequence ?? 1), input.level ?? "info",
      input.phase, input.code ?? "", input.message.slice(0, 500), JSON.stringify(allowedMetadata)).run();
}

/**
 * Muda a fase e renova a reserva (§32).
 *
 * A execução de navegador dura mais do que a reserva inicial, e cada fase é a
 * prova de que o worker continua vivo. Sem a renovação, a reserva vence no meio
 * de uma extração longa, outro runner assume o mesmo job, e o cliente recebe a
 * mesma importação duas vezes — a falha que o lease existe para impedir.
 *
 * A renovação não é obrigatória para a fase avançar: perder a corrida da
 * reserva significa que outro worker já assumiu, e nesse caso quem deve parar
 * é este, na próxima escrita condicionada ao `lease_token`.
 */
async function setPhase(d1: Database, workspaceId: string, job: Job, phase: keyof typeof phaseMessages) {
  await d1.prepare("UPDATE fdp_integration_sync_runs SET status = ? WHERE workspace_id = ? AND id = ?")
    .bind(phase, workspaceId, job.run_id).run();
  await renewAgentLease(d1, { workspaceId, jobId: job.id, leaseToken: job.lease_token, minutes: LEASE_MINUTES })
    .catch(() => false);
  await appendLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id, phase, message: phaseMessages[phase] });
}

async function captureDiagnostic(d1: Database, workspaceId: string, job: Job, session: SankhyaBrowserSession | null, retentionHours: number) {
  if (!session || !process.env.BLOB_READ_WRITE_TOKEN) return;
  const diagnostic = await session.diagnosticScreenshot().catch(() => null);
  if (!diagnostic || diagnostic.bytes.length > 5 * 1024 * 1024) return;
  const key = `integrations/${workspaceId}/${job.integration_id}/${job.run_id}/${crypto.randomUUID()}.png`;
  const bytes = diagnostic.bytes.buffer.slice(diagnostic.bytes.byteOffset, diagnostic.bytes.byteOffset + diagnostic.bytes.byteLength) as ArrayBuffer;
  await getAttachmentsBucket().put(key, bytes, { httpMetadata: { contentType: diagnostic.mimeType, contentDisposition: "attachment" } });
  await d1.prepare(`INSERT INTO fdp_integration_diagnostics (id, workspace_id, integration_id, run_id, kind, object_key, expires_at)
    VALUES (?, ?, ?, ?, 'screenshot', ?, CURRENT_TIMESTAMP + make_interval(hours => ?))`)
    .bind(crypto.randomUUID(), workspaceId, job.integration_id, job.run_id, key, retentionHours).run();
}

export async function claimNextSankhyaJob(d1: Database, workspaceId: string) {
  const leaseToken = crypto.randomUUID();
  return d1.prepare(`WITH candidate AS (
      SELECT job.id FROM fdp_integration_jobs job
      JOIN fdp_integrations integration ON integration.workspace_id = job.workspace_id AND integration.id = job.integration_id
      WHERE job.workspace_id = ? AND integration.channel = 'sankhya_browser' AND job.status IN ('queued', 'leased')
        AND job.available_at <= CURRENT_TIMESTAMP AND (job.status = 'queued' OR job.lease_expires_at < CURRENT_TIMESTAMP)
      ORDER BY job.available_at, job.created_at FOR UPDATE OF job SKIP LOCKED LIMIT 1
    ) UPDATE fdp_integration_jobs job SET status = 'leased', lease_token = ?, lease_expires_at = CURRENT_TIMESTAMP + make_interval(mins => 20),
      attempt = job.attempt + 1, updated_at = CURRENT_TIMESTAMP FROM candidate WHERE job.id = candidate.id
    RETURNING job.id, job.integration_id, job.run_id, job.job_type, job.attempt, job.max_attempts, job.lease_token`)
    .bind(workspaceId, leaseToken).first<Job>();
}

export async function processNextSankhyaJob(d1: Database, workspaceId: string, createSession: SankhyaSessionFactory) {
  const job = await claimNextSankhyaJob(d1, workspaceId);
  if (!job) return null;
  const startedAt = Date.now();
  let session: SankhyaBrowserSession | null = null;
  let config = parseSankhyaConfig({});
  try {
    const [integration, credential] = await Promise.all([
      d1.prepare("SELECT id, config_json, status FROM fdp_integrations WHERE workspace_id = ? AND id = ? AND channel = 'sankhya_browser'")
        .bind(workspaceId, job.integration_id).first<Integration>(),
      d1.prepare(`SELECT id, encrypted_value, initialization_vector, auth_tag, key_version FROM fdp_integration_credentials
        WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY created_at DESC LIMIT 1`)
        .bind(workspaceId, job.integration_id).first<Credential>(),
    ]);
    if (!integration || !credential) throw new SankhyaConnectorError("SANKHYA_CREDENTIAL_REQUIRED", "A credencial Sankhya precisa ser configurada novamente.");
    try { config = sanitizeSankhyaConfig(integration.config_json); }
    catch { throw new SankhyaConnectorError("SANKHYA_CONFIG_INVALID", "A URL ou configuração do conector Sankhya não é segura."); }
    assertRunnableSankhyaConfig(config);
    const credentials = openCredentials("sankhya_browser", {
      encryptedValue: credential.encrypted_value, initializationVector: credential.initialization_vector, authTag: credential.auth_tag, keyVersion: Number(credential.key_version),
    });
    if (!credentials.username || !credentials.password) throw new SankhyaConnectorError("SANKHYA_CREDENTIAL_INCOMPLETE", "A credencial Sankhya está incompleta.");

    await d1.batch([
      d1.prepare("UPDATE fdp_integration_sync_runs SET status = 'running', attempt = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), error_code = '', error_message = '' WHERE workspace_id = ? AND id = ?")
        .bind(job.attempt, workspaceId, job.run_id),
      prepareDomainEvent(d1, { workspaceId, eventType: "sankhya.sync.started", entityType: "integration_run", entityId: job.run_id,
        payload: { integrationId: job.integration_id, runId: job.run_id, status: "running", occurredAt: new Date().toISOString() } }),
      prepareAuditEvent({ workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "sankhya.sync.started", entityType: "integration_run", entityId: job.run_id,
        after: { integrationId: job.integration_id, attempt: job.attempt, jobType: job.job_type } }),
    ]);
    await setPhase(d1, workspaceId, job, "running");
    session = await createSession({ workspaceId, integrationId: job.integration_id, runId: job.run_id });
    await setPhase(d1, workspaceId, job, "authenticating");
    await session.authenticate(config.endpoint, { username: credentials.username, password: credentials.password }, config.timeoutMs);
    await appendLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id, phase: "authenticating", message: "Autenticação concluída" });
    await setPhase(d1, workspaceId, job, "navigating");
    await session.openDpExplorer(config);

    if (job.job_type === "health_check") {
      const durationMs = Date.now() - startedAt;
      await d1.batch([
        d1.prepare("UPDATE fdp_integration_sync_runs SET status = 'succeeded', duration_ms = ?, summary = 'Conexão estabelecida com sucesso.', completed_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
          .bind(durationMs, workspaceId, job.run_id),
        d1.prepare("UPDATE fdp_integration_jobs SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP, lease_token = '', lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND lease_token = ?")
          .bind(workspaceId, job.id, job.lease_token),
        d1.prepare("UPDATE fdp_integrations SET status = 'connected', last_connection_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
          .bind(workspaceId, job.integration_id),
        d1.prepare("UPDATE fdp_integration_credentials SET verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
          .bind(workspaceId, credential.id),
        prepareDomainEvent(d1, { workspaceId, eventType: "sankhya.sync.completed", entityType: "integration_run", entityId: job.run_id,
          payload: { integrationId: job.integration_id, runId: job.run_id, status: "succeeded", occurredAt: new Date().toISOString() } }),
        prepareAuditEvent({ workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "sankhya.connection_test.completed", entityType: "integration_run", entityId: job.run_id,
          after: { integrationId: job.integration_id, status: "succeeded", durationMs } }),
      ]);
      await appendLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id, phase: "succeeded", message: "Conexão estabelecida com sucesso" });
      return { runId: job.run_id, status: "succeeded", healthCheck: true };
    }

    await setPhase(d1, workspaceId, job, "processing");
    await session.runRoutine(config);
    await setPhase(d1, workspaceId, job, "extracting");
    const extraction = await session.extract(config);
    await appendLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id, phase: "extracting", message: `${extraction.records.length} registros encontrados`, metadata: { found: extraction.records.length, source: extraction.source } });
    await setPhase(d1, workspaceId, job, "importing");
    const totals = await importSankhyaEmployees(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id, companyId: config.companyId, records: extraction.records });
    const durationMs = Date.now() - startedAt;
    const finalStatus = totals.failed ? (totals.imported ? "partial" : "failed") : "succeeded";
    const summary = `${totals.found} encontrados; ${totals.created} criados; ${totals.updated} atualizados; ${totals.unchanged} sem alteração; ${totals.failed} inválidos.`;
    await d1.batch([
      d1.prepare(`UPDATE fdp_integration_sync_runs SET status = ?, received_count = ?, processed_count = ?, skipped_count = ?, failed_count = ?,
        updated_count = ?, unchanged_count = ?, duration_ms = ?, summary = ?, completed_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(finalStatus, totals.found, totals.imported, totals.ignored, totals.failed, totals.updated, totals.unchanged, durationMs, summary, workspaceId, job.run_id),
      d1.prepare("UPDATE fdp_integration_jobs SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP, lease_token = '', lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND lease_token = ?")
        .bind(workspaceId, job.id, job.lease_token),
      /* Zera a contagem de falhas junto com o sucesso (§34): sem isto o
         conector recuperado continuaria marcado como degradado na tela. */
      d1.prepare("UPDATE fdp_integrations SET status = 'connected', last_connection_at = CURRENT_TIMESTAMP, last_sync_at = CURRENT_TIMESTAMP, last_successful_sync_at = CASE WHEN ? = 'succeeded' THEN CURRENT_TIMESTAMP ELSE last_successful_sync_at END, consecutive_failures = 0, degraded_since = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(finalStatus, workspaceId, job.integration_id),
      prepareDomainEvent(d1, { workspaceId, eventType: "sankhya.sync.completed", entityType: "integration_run", entityId: job.run_id,
        payload: { integrationId: job.integration_id, runId: job.run_id, status: finalStatus, foundCount: totals.found, importedCount: totals.imported,
          updatedCount: totals.updated, ignoredCount: totals.ignored, failedCount: totals.failed, occurredAt: new Date().toISOString() } }),
      prepareAuditEvent({ workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "sankhya.sync.completed", entityType: "integration_run", entityId: job.run_id,
        after: { status: finalStatus, durationMs, ...totals } }),
    ]);
    await appendLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id, phase: finalStatus, message: summary,
      metadata: { found: totals.found, imported: totals.imported, updated: totals.updated, ignored: totals.ignored, failed: totals.failed } });
    return { runId: job.run_id, status: finalStatus, ...totals };
  } catch (error) {
    const safe = safeSankhyaError(error);
    const retry = safe.retryable && !safe.requiresUserAction && job.attempt < job.max_attempts;
    const runStatus = retry ? "queued" : safe.requiresUserAction ? "requires_user_action" : "failed";
    const jobStatus = retry ? "queued" : "dead_letter";
    await captureDiagnostic(d1, workspaceId, job, session, config.diagnosticRetentionHours).catch(() => undefined);
    await d1.batch([
      d1.prepare(`UPDATE fdp_integration_jobs SET status = ?, available_at = CURRENT_TIMESTAMP + make_interval(secs => ?), lease_token = '', lease_expires_at = NULL,
        last_error_code = ?, last_error_message = ?, completed_at = CASE WHEN ? = 'dead_letter' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
        .bind(jobStatus, retry ? retryDelaySeconds(job.attempt) : 0, safe.code, safe.message, jobStatus, workspaceId, job.id, job.lease_token),
      d1.prepare(`UPDATE fdp_integration_sync_runs SET status = ?, attempt = ?, error_code = ?, error_message = ?, duration_ms = ?,
        completed_at = CASE WHEN ? IN ('failed', 'requires_user_action') THEN CURRENT_TIMESTAMP ELSE NULL END WHERE workspace_id = ? AND id = ?`)
        .bind(runStatus, job.attempt, safe.code, safe.message, Date.now() - startedAt, runStatus, workspaceId, job.run_id),
      /* Falhas seguidas acumulam no conector e, no terceiro tropeço, marcam o
         agente como degradado (§34). O horário da próxima execução continua
         vindo da configuração do próprio Sankhya — a espera crescente daqui é
         a do job, que já tem teto de tentativas. */
      d1.prepare(`UPDATE fdp_integrations SET status = ?, last_error = ?,
          consecutive_failures = consecutive_failures + 1,
          degraded_since = CASE WHEN consecutive_failures + 1 >= ? THEN COALESCE(degraded_since, CURRENT_TIMESTAMP) ELSE degraded_since END,
          updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(retry ? "connected" : safe.requiresUserAction ? "requires_user_action" : safe.code.includes("CREDENTIAL") || safe.code.includes("LOGIN_INVALID") ? "needs_credentials" : "error", safe.message, DEGRADED_AFTER_FAILURES, workspaceId, job.integration_id),
      prepareDomainEvent(d1, { workspaceId, eventType: safe.code.includes("LOGIN") ? "sankhya.connection.failed" : "sankhya.sync.failed", entityType: "integration_run", entityId: job.run_id,
        payload: { integrationId: job.integration_id, runId: job.run_id, status: runStatus, errorCode: safe.code, occurredAt: new Date().toISOString() } }),
      prepareAuditEvent({ workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "sankhya.sync.failed", outcome: "failure", entityType: "integration_run", entityId: job.run_id,
        after: { status: runStatus, errorCode: safe.code, retry, attempt: job.attempt } }),
    ]);
    await appendLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id, phase: runStatus, level: "error", code: safe.code, message: safe.message,
      metadata: { retry, attempt: job.attempt, layoutRelated: safe.layoutRelated } });
    log("error", "sankhya.run_failed", { workspaceId, connectorId: job.integration_id, syncRunId: job.run_id, jobId: job.id }, { errorCode: safe.code, retry, attempt: job.attempt });
    return { runId: job.run_id, status: runStatus, retry, errorCode: safe.code };
  } finally {
    if (session) {
      await session.logout().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }
}
