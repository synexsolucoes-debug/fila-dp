import type { getD1 } from "../../db/index.ts";
import { ApiError } from "../api-errors.ts";
import { prepareAuditEvent } from "../fila-dp-db.ts";
import { openCredentials, retryDelaySeconds } from "../integrations.ts";
import { log } from "../observability.ts";
import { prepareDomainEvent } from "../outbox.ts";
import { tangerinoAgentConfig } from "./config.ts";
import { safeTangerinoError, tangerinoErrors } from "./errors.ts";
import { verifyTangerinoBrowserLogin } from "./login.ts";
import { requireTangerinoAgent } from "./queue.ts";
import type { TangerinoBrowserSession, TangerinoSessionFactory } from "./types.ts";

type Database = ReturnType<typeof getD1>;
type HealthJob = {
  id: string;
  integration_id: string;
  run_id: string;
  attempt: number;
  max_attempts: number;
  lease_token: string;
};
type Credential = {
  id: string;
  encrypted_value: string;
  initialization_vector: string;
  auth_tag: string;
  key_version: number;
};

/**
 * Enfileira uma autenticação real, sem consultar colaborador nem abrir Admissão.
 * A tabela é a mesma das execuções dos demais conectores: assim a tela, a fila,
 * a auditoria e a idempotência continuam tendo uma fonte única.
 */
export async function queueTangerinoHealthCheck(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  requestedBy?: string | null;
  idempotencyKey: string;
}) {
  await requireTangerinoAgent(d1, input.workspaceId);
  const integration = await d1.prepare(`SELECT id FROM fdp_integrations
    WHERE workspace_id = ? AND id = ? AND channel = 'tangerino_browser'`)
    .bind(input.workspaceId, input.integrationId).first<{ id: string }>();
  if (!integration) throw ApiError.notFound("Agente Tangerino não encontrado.", "TANGERINO_INTEGRATION_NOT_FOUND");
  const credential = await d1.prepare(`SELECT 1 AS configured FROM fdp_integration_credentials
    WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`)
    .bind(input.workspaceId, input.integrationId).first();
  if (!credential) throw new ApiError(409, "TANGERINO_CREDENTIAL_REQUIRED", "Configure o usuário e a senha do agente Tangerino antes de testar.");

  const key = input.idempotencyKey.trim().slice(0, 180);
  if (key.length < 8) throw ApiError.badRequest("Chave de idempotência inválida.", "IDEMPOTENCY_KEY_REQUIRED");
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  try {
    const run = await d1.prepare(`WITH inserted_run AS (
        INSERT INTO fdp_integration_sync_runs
          (id, workspace_id, integration_id, trigger_type, status, idempotency_key, requested_by)
        SELECT ?, ?, ?, 'health_check', 'queued', ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM fdp_integration_jobs active
          WHERE active.workspace_id = ? AND active.integration_id = ? AND active.status IN ('queued', 'leased')
        )
        ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING RETURNING *
      ), chosen_run AS (
        SELECT * FROM inserted_run UNION ALL
        SELECT * FROM fdp_integration_sync_runs
        WHERE workspace_id = ? AND integration_id = ? AND idempotency_key = ?
          AND NOT EXISTS (SELECT 1 FROM inserted_run) LIMIT 1
      ), inserted_job AS (
        INSERT INTO fdp_integration_jobs
          (id, workspace_id, integration_id, run_id, job_type, idempotency_key, payload_json, max_attempts)
        SELECT ?, ?, ?, chosen_run.id, 'health_check', 'run:' || chosen_run.id,
          jsonb_build_object('runId', chosen_run.id), 2 FROM chosen_run
        ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING
      ) SELECT id, integration_id, trigger_type, status, idempotency_key, created_at FROM chosen_run`)
      .bind(runId, input.workspaceId, input.integrationId, key, input.requestedBy ?? null,
        input.workspaceId, input.integrationId,
        input.workspaceId, input.integrationId, key,
        jobId, input.workspaceId, input.integrationId)
      .first<Record<string, unknown>>();
    if (!run) throw new ApiError(409, "TANGERINO_RUN_ALREADY_ACTIVE", "Já existe um teste ou execução do agente Tangerino em andamento.");
    return run;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "23505" || (error instanceof Error && /fdp_(?:sankhya_active_run|integration_jobs_active)_uq/iu.test(error.message))) {
      throw new ApiError(409, "TANGERINO_RUN_ALREADY_ACTIVE", "Já existe um teste ou execução do agente Tangerino em andamento.");
    }
    throw error;
  }
}

export async function claimNextTangerinoHealthCheck(d1: Database, workspaceId: string) {
  const leaseToken = crypto.randomUUID();
  return d1.prepare(`WITH candidate AS (
      SELECT job.id FROM fdp_integration_jobs job
      JOIN fdp_integrations integration
        ON integration.workspace_id = job.workspace_id AND integration.id = job.integration_id
      WHERE job.workspace_id = ? AND integration.channel = 'tangerino_browser'
        AND job.job_type = 'health_check' AND job.status IN ('queued', 'leased')
        AND job.available_at <= CURRENT_TIMESTAMP
        AND (job.status = 'queued' OR job.lease_expires_at < CURRENT_TIMESTAMP)
      ORDER BY job.available_at, job.created_at FOR UPDATE OF job SKIP LOCKED LIMIT 1
    ) UPDATE fdp_integration_jobs job
      SET status = 'leased', lease_token = ?, lease_expires_at = CURRENT_TIMESTAMP + make_interval(mins => 20),
        attempt = job.attempt + 1, updated_at = CURRENT_TIMESTAMP
      FROM candidate WHERE job.id = candidate.id
      RETURNING job.id, job.integration_id, job.run_id, job.attempt, job.max_attempts, job.lease_token`)
    .bind(workspaceId, leaseToken).first<HealthJob>();
}

async function appendHealthLog(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  runId: string;
  phase: string;
  level?: "info" | "warn" | "error";
  code?: string;
  message: string;
}) {
  const sequence = await d1.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM fdp_integration_run_logs WHERE workspace_id = ? AND run_id = ?`)
    .bind(input.workspaceId, input.runId).first<{ sequence: number }>();
  await d1.prepare(`INSERT INTO fdp_integration_run_logs
      (id, workspace_id, integration_id, run_id, sequence, level, phase, code, message, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}'::jsonb)`)
    .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.runId,
      Number(sequence?.sequence ?? 1), input.level ?? "info", input.phase,
      input.code ?? "", input.message.slice(0, 500)).run();
}

/** Processa um teste do login no worker Playwright, fora da requisição web. */
export async function processNextTangerinoHealthCheck(
  d1: Database,
  workspaceId: string,
  createSession: TangerinoSessionFactory,
) {
  const job = await claimNextTangerinoHealthCheck(d1, workspaceId);
  if (!job) return null;
  const startedAt = Date.now();
  let session: TangerinoBrowserSession | null = null;
  try {
    const [integration, credential] = await Promise.all([
      d1.prepare(`SELECT id FROM fdp_integrations
        WHERE workspace_id = ? AND id = ? AND channel = 'tangerino_browser'`)
        .bind(workspaceId, job.integration_id).first<{ id: string }>(),
      d1.prepare(`SELECT id, encrypted_value, initialization_vector, auth_tag, key_version
        FROM fdp_integration_credentials
        WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        ORDER BY created_at DESC LIMIT 1`)
        .bind(workspaceId, job.integration_id).first<Credential>(),
    ]);
    if (!integration || !credential) throw tangerinoErrors.credentialRequired();
    const secrets = openCredentials("tangerino_browser", {
      encryptedValue: credential.encrypted_value,
      initializationVector: credential.initialization_vector,
      authTag: credential.auth_tag,
      keyVersion: Number(credential.key_version),
    });
    if (!secrets.username || !secrets.password) throw tangerinoErrors.credentialRequired();

    await d1.batch([
      d1.prepare(`UPDATE fdp_integration_sync_runs
        SET status = 'authenticating', attempt = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          error_code = '', error_message = '' WHERE workspace_id = ? AND id = ?`)
        .bind(job.attempt, workspaceId, job.run_id),
      prepareDomainEvent(d1, {
        workspaceId, eventType: "tangerino.connection_test.started", entityType: "integration_run", entityId: job.run_id,
        payload: { integrationId: job.integration_id, runId: job.run_id, occurredAt: new Date().toISOString() },
      }),
      prepareAuditEvent({
        workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "tangerino.connection_test.started",
        entityType: "integration_run", entityId: job.run_id,
        after: { integrationId: job.integration_id, attempt: job.attempt },
      }),
    ]);
    await appendHealthLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id,
      phase: "authenticating", message: "Iniciando autenticação no Tangerino" });

    session = await createSession({ workspaceId, integrationId: job.integration_id, consultationId: job.run_id });
    await verifyTangerinoBrowserLogin(session, {
      username: secrets.username,
      password: secrets.password,
      timeoutMs: tangerinoAgentConfig().timeoutMs,
    });
    const durationMs = Date.now() - startedAt;
    await d1.batch([
      d1.prepare(`UPDATE fdp_integration_sync_runs
        SET status = 'succeeded', duration_ms = ?, summary = 'Login confirmado com sucesso.',
          completed_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(durationMs, workspaceId, job.run_id),
      d1.prepare(`UPDATE fdp_integration_jobs
        SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP, lease_token = '', lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
        .bind(workspaceId, job.id, job.lease_token),
      d1.prepare(`UPDATE fdp_integrations
        SET status = 'connected', last_connection_at = CURRENT_TIMESTAMP, consecutive_failures = 0,
          degraded_since = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ?`)
        .bind(workspaceId, job.integration_id),
      d1.prepare(`UPDATE fdp_integration_credentials
        SET verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ?`)
        .bind(workspaceId, credential.id),
      prepareDomainEvent(d1, {
        workspaceId, eventType: "tangerino.connection_test.completed", entityType: "integration_run", entityId: job.run_id,
        payload: { integrationId: job.integration_id, runId: job.run_id, status: "succeeded", occurredAt: new Date().toISOString() },
      }),
      prepareAuditEvent({
        workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "tangerino.connection_test.completed",
        entityType: "integration_run", entityId: job.run_id,
        after: { integrationId: job.integration_id, status: "succeeded", durationMs },
      }),
    ]);
    await appendHealthLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id,
      phase: "succeeded", message: "Login confirmado com sucesso" });
    return { runId: job.run_id, status: "succeeded", healthCheck: true };
  } catch (error) {
    const safe = safeTangerinoError(error);
    const retry = safe.retryable && !safe.requiresUserAction && job.attempt < job.max_attempts;
    const runStatus = retry ? "queued" : safe.requiresUserAction ? "requires_user_action" : "failed";
    const jobStatus = retry ? "queued" : "dead_letter";
    const integrationStatus = safe.requiresUserAction || /CREDENTIAL|AUTHENTICATION/iu.test(safe.code)
      ? "needs_credentials" : "error";
    const durationMs = Date.now() - startedAt;
    await d1.batch([
      d1.prepare(`UPDATE fdp_integration_jobs
        SET status = ?, available_at = CURRENT_TIMESTAMP + make_interval(secs => ?), lease_token = '', lease_expires_at = NULL,
          last_error_code = ?, last_error_message = ?, completed_at = CASE WHEN ? = 'dead_letter' THEN CURRENT_TIMESTAMP ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
        .bind(jobStatus, retry ? retryDelaySeconds(job.attempt) : 0, safe.code, safe.message,
          jobStatus, workspaceId, job.id, job.lease_token),
      d1.prepare(`UPDATE fdp_integration_sync_runs
        SET status = ?, attempt = ?, error_code = ?, error_message = ?, duration_ms = ?,
          completed_at = CASE WHEN ? IN ('failed', 'requires_user_action') THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE workspace_id = ? AND id = ?`)
        .bind(runStatus, job.attempt, safe.code, safe.message, durationMs, runStatus, workspaceId, job.run_id),
      d1.prepare(`UPDATE fdp_integrations
        SET status = CASE WHEN ? = 1 THEN status ELSE ? END, last_error = ?,
          consecutive_failures = consecutive_failures + CASE WHEN ? = 1 THEN 0 ELSE 1 END,
          updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(retry ? 1 : 0, integrationStatus, safe.message, retry ? 1 : 0, workspaceId, job.integration_id),
      prepareDomainEvent(d1, {
        workspaceId, eventType: "tangerino.connection_test.failed", entityType: "integration_run", entityId: job.run_id,
        payload: { integrationId: job.integration_id, runId: job.run_id, status: runStatus, errorCode: safe.code, occurredAt: new Date().toISOString() },
      }),
      prepareAuditEvent({
        workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "tangerino.connection_test.failed", outcome: "failure",
        entityType: "integration_run", entityId: job.run_id,
        after: { integrationId: job.integration_id, status: runStatus, errorCode: safe.code, retry, attempt: job.attempt },
      }),
    ]);
    await appendHealthLog(d1, { workspaceId, integrationId: job.integration_id, runId: job.run_id,
      phase: runStatus, level: "error", code: safe.code, message: safe.message });
    log("error", "tangerino.connection_test_failed", {
      workspaceId, connectorId: job.integration_id, syncRunId: job.run_id, jobId: job.id,
    }, { errorCode: safe.code, retry, attempt: job.attempt });
    return { runId: job.run_id, status: runStatus, retry, errorCode: safe.code, healthCheck: true };
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}
