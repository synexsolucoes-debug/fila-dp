import type { getD1 } from "../../db/index.ts";
import { prepareAuditEvent } from "../fila-dp-db.ts";
import { openCredentials } from "../integrations.ts";
import { log } from "../observability.ts";
import { prepareDomainEvent } from "../outbox.ts";
import { tangerinoAgentConfig } from "./config.ts";
import { ensureTangerinoErpDemand, type TangerinoDemandResult } from "./demand.ts";
import { safeTangerinoError, tangerinoErrors } from "./errors.ts";
import { tangerinoBrowserLoginUrl } from "./hosts.ts";
import { admissionChanged, admissionSearchTerm, chooseAdmission, parseAdmission } from "./parser.ts";
import type { AdmissionConsultationTarget, ConsultationResult, TangerinoSessionFactory } from "./types.ts";

type Database = ReturnType<typeof getD1>;

type ClaimedConsultation = {
  id: string;
  company_id: string;
  employee_id: string;
  integration_id: string;
  requested_by_user_id: string | null;
  external_admission_id: string;
  attempt: number;
};

type Credential = {
  encrypted_value: string;
  initialization_vector: string;
  auth_tag: string;
  key_version: number;
};

/**
 * O agente de consulta de admissão.
 *
 * Roda **no worker**, nunca dentro de uma requisição HTTP (§33, §36). O caminho
 * é sempre o mesmo e sempre fechado: autenticar, abrir Admissão, pesquisar,
 * escolher (ou recusar a escolher), abrir, ler, voltar, encerrar. Não existe
 * ramo neste arquivo que clique em algo que a lista de comandos não preveja, e
 * é por isso que ele é somente leitura de verdade e não por promessa.
 *
 * A ordem das validações não é acidental. Tudo o que dá para recusar sem abrir
 * navegador — módulo desligado, credencial ausente, colaborador de outro
 * workspace — já foi recusado na fila, antes daqui. O navegador é o recurso
 * caro; chegar até ele para descobrir que faltava uma credencial seria gastar
 * um minuto de execução para dar uma resposta que o banco já tinha.
 */

/**
 * Reivindica a próxima consulta.
 *
 * `FOR UPDATE SKIP LOCKED` é o que permite dois workers no mesmo workspace sem
 * que os dois peguem a mesma linha — e sem que o segundo fique esperando o
 * primeiro terminar, que é o que um `FOR UPDATE` puro faria.
 */
export async function claimNextConsultation(d1: Database, workspaceId: string) {
  return d1.prepare(`WITH candidate AS (
      SELECT id FROM fdp_tangerino_admission_consultations
      WHERE workspace_id = ? AND state = 'QUEUED'
      ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE fdp_tangerino_admission_consultations consultation
      SET state = 'RUNNING', started_at = CURRENT_TIMESTAMP, attempt = consultation.attempt + 1, updated_at = CURRENT_TIMESTAMP
      FROM candidate WHERE consultation.id = candidate.id AND consultation.workspace_id = ?
      RETURNING consultation.id, consultation.company_id, consultation.employee_id, consultation.integration_id,
        consultation.requested_by_user_id, consultation.external_admission_id, consultation.attempt`)
    .bind(workspaceId, workspaceId).first<ClaimedConsultation>();
}

async function loadTarget(d1: Database, workspaceId: string, claimed: ClaimedConsultation): Promise<AdmissionConsultationTarget> {
  const employee = await d1.prepare(`SELECT registration_number, full_name FROM fdp_employees
    WHERE workspace_id = ? AND id = ?`).bind(workspaceId, claimed.employee_id)
    .first<{ registration_number: string; full_name: string }>();
  if (!employee) throw tangerinoErrors.notFound();
  return {
    workspaceId,
    companyId: claimed.company_id,
    employeeId: claimed.employee_id,
    externalAdmissionId: claimed.external_admission_id,
    registrationNumber: String(employee.registration_number ?? ""),
    fullName: String(employee.full_name ?? ""),
  };
}

/**
 * Guarda o vínculo com o processo no Tangerino (§47).
 *
 * A partir daqui a consulta deixa de depender de pesquisa por nome: o processo
 * é aberto pelo identificador, e o risco de casar com homônimo desaparece. É a
 * única escrita que o agente faz — e é no Vinculato, não no Tangerino.
 */
async function saveExternalReference(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  employeeId: string;
  externalId: string;
  registrationNumber: string;
}) {
  if (!input.externalId) return;
  await d1.prepare(`INSERT INTO fdp_employee_external_refs
      (id, workspace_id, integration_id, employee_id, source, external_id, registration_number, normalized_hash, last_seen_at)
    VALUES (?, ?, ?, ?, 'tangerino', ?, ?, '', CURRENT_TIMESTAMP)
    ON CONFLICT ("workspace_id", "integration_id", "source", "external_id")
    DO UPDATE SET employee_id = EXCLUDED.employee_id, registration_number = EXCLUDED.registration_number,
      last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`)
    .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.employeeId,
      input.externalId.slice(0, 120), input.registrationNumber.slice(0, 60)).run();
}

/** A leitura bem-sucedida anterior, para saber se algo mudou (§48). */
async function previousSuccess(d1: Database, workspaceId: string, employeeId: string, exceptId: string) {
  return d1.prepare(`SELECT raw_status, normalized_status, stage FROM fdp_tangerino_admission_consultations
    WHERE workspace_id = ? AND employee_id = ? AND state = 'SUCCESS' AND id <> ?
    ORDER BY consulted_at DESC LIMIT 1`)
    .bind(workspaceId, employeeId, exceptId).first<{ raw_status: string; normalized_status: string; stage: string }>();
}

/** Quantos processos a pesquisa achou, para a tela dizer "encontrei 3" em vez de "erro". */
function extractMatchCount(message: string) {
  const found = /(\d+)\s+processos/u.exec(message);
  return found ? Math.min(999, Number(found[1])) : 0;
}

/**
 * Executa uma consulta reivindicada, do login à gravação.
 *
 * Devolve `null` quando não havia nada na fila. Nunca lança: toda falha vira um
 * `ConsultationResult` com estado próprio, porque quem chama é um laço de worker
 * e uma exceção ali derrubaria a varredura inteira por causa de uma consulta.
 */
export async function runNextConsultation(
  d1: Database,
  workspaceId: string,
  createSession: TangerinoSessionFactory,
): Promise<(ConsultationResult & { consultationId: string }) | null> {
  const claimed = await claimNextConsultation(d1, workspaceId);
  if (!claimed) return null;
  const startedAt = Date.now();
  const config = tangerinoAgentConfig();
  let session: Awaited<ReturnType<TangerinoSessionFactory>> | null = null;

  try {
    const [target, credential, integration] = await Promise.all([
      loadTarget(d1, workspaceId, claimed),
      d1.prepare(`SELECT encrypted_value, initialization_vector, auth_tag, key_version FROM fdp_integration_credentials
        WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY created_at DESC LIMIT 1`)
        .bind(workspaceId, claimed.integration_id).first<Credential>(),
      d1.prepare("SELECT id FROM fdp_integrations WHERE workspace_id = ? AND id = ? AND channel = 'tangerino_browser'")
        .bind(workspaceId, claimed.integration_id).first<{ id: string }>(),
    ]);
    if (!credential || !integration) throw tangerinoErrors.credentialRequired();

    const secrets = openCredentials("tangerino_browser", {
      encryptedValue: credential.encrypted_value,
      initializationVector: credential.initialization_vector,
      authTag: credential.auth_tag,
      keyVersion: Number(credential.key_version),
    });
    if (!secrets.username || !secrets.password) throw tangerinoErrors.credentialRequired();
    await d1.batch([
      prepareDomainEvent(d1, {
        workspaceId, eventType: "tangerino.consultation.started", entityType: "tangerino_consultation", entityId: claimed.id,
        payload: { consultationId: claimed.id, employeeId: claimed.employee_id, occurredAt: new Date().toISOString() },
      }),
      prepareAuditEvent({
        workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "tangerino.consultation.started",
        entityType: "tangerino_consultation", entityId: claimed.id,
        after: { employeeId: claimed.employee_id, attempt: claimed.attempt },
      }),
    ]);

    session = await createSession({ workspaceId, integrationId: claimed.integration_id, consultationId: claimed.id });
    await session.ensureAuthenticated({
      endpoint: tangerinoBrowserLoginUrl, username: secrets.username, password: secrets.password, timeoutMs: config.timeoutMs,
    });
    await session.openAdmissions();
    const hits = await session.searchAdmission(admissionSearchTerm(target));
    const hit = chooseAdmission(hits, target.externalAdmissionId);
    await session.openAdmission(hit);
    const snapshot = await session.readAdmission();
    await session.back();

    const admission = parseAdmission(snapshot);
    // O identificador da linha vale quando a tela do processo não traz o seu.
    const externalId = admission.externalAdmissionId || hit.id;
    const previousRow = await previousSuccess(d1, workspaceId, claimed.employee_id, claimed.id);
    const previous = previousRow
      ? {
          rawStatus: String(previousRow.raw_status ?? ""),
          normalizedStatus: String(previousRow.normalized_status ?? ""),
          stage: String(previousRow.stage ?? ""),
        }
      : null;
    const changed = admissionChanged(previous, admission);
    const durationMs = Date.now() - startedAt;

    await saveExternalReference(d1, {
      workspaceId, integrationId: claimed.integration_id, employeeId: claimed.employee_id,
      externalId, registrationNumber: target.registrationNumber,
    });

    const statements = [
      d1.prepare(`UPDATE fdp_tangerino_admission_consultations SET state = 'SUCCESS', error_code = '',
          raw_status = ?, normalized_status = ?, stage = ?, pending_reason = ?, admission_date = ?, source_updated_at = ?,
          external_admission_id = ?, match_count = 1, consulted_at = CURRENT_TIMESTAMP, duration_ms = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ?`)
        .bind(admission.rawStatus, admission.normalizedStatus, admission.stage, admission.pendingReason,
          admission.admissionDate, admission.sourceUpdatedAt, externalId, durationMs, workspaceId, claimed.id),
      prepareDomainEvent(d1, {
        workspaceId, eventType: "tangerino.consultation.completed", entityType: "tangerino_consultation", entityId: claimed.id,
        payload: {
          consultationId: claimed.id, employeeId: claimed.employee_id, normalizedStatus: admission.normalizedStatus,
          durationMs, occurredAt: new Date().toISOString(),
        },
      }),
      prepareAuditEvent({
        workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "tangerino.consultation.completed",
        entityType: "tangerino_consultation", entityId: claimed.id,
        after: { employeeId: claimed.employee_id, normalizedStatus: admission.normalizedStatus, durationMs, changed },
      }),
    ];

    /* A mudança continua sendo registrada separadamente. A automação não usa a
       tradução de `rawStatus`: o único gatilho aceito é a etapa literal "Dados
       contratuais", validada depois que esta consulta já foi persistida. */
    if (changed) {
      statements.push(prepareDomainEvent(d1, {
        workspaceId, eventType: "tangerino.admission.status_changed", entityType: "employee", entityId: claimed.employee_id,
        payload: {
          consultationId: claimed.id, employeeId: claimed.employee_id,
          previousStatus: previous?.normalizedStatus ?? null, normalizedStatus: admission.normalizedStatus,
          previousStage: previous?.stage ?? null, stage: admission.stage,
          occurredAt: new Date().toISOString(),
        },
      }));
    }
    await d1.batch(statements);

    let demand: TangerinoDemandResult = { status: "not_target_stage", cardId: null };
    try {
      demand = await ensureTangerinoErpDemand(d1, {
        workspaceId,
        integrationId: claimed.integration_id,
        employeeId: claimed.employee_id,
        consultationId: claimed.id,
        externalAdmissionId: externalId,
        admission,
      });
    } catch {
      // A leitura já foi gravada com sucesso. Uma falha ao abrir a demanda não
      // apaga essa evidência nem transforma a consulta em erro de navegador;
      // a próxima varredura tentará novamente e o evento idempotente impede
      // duplicidade caso a primeira tentativa tenha chegado ao banco.
      log("error", "tangerino.erp_demand_failed", { workspaceId }, {
        consultationId: claimed.id, integrationId: claimed.integration_id,
      });
      await d1.batch([
        prepareDomainEvent(d1, {
          workspaceId,
          eventType: "integration.failed",
          entityType: "integration",
          entityId: claimed.integration_id,
          payload: {
            integrationId: claimed.integration_id,
            runId: claimed.id,
            errorCode: "TANGERINO_ERP_DEMAND_FAILED",
            reason: "Não foi possível abrir a demanda após a etapa Dados contratuais.",
            occurredAt: new Date().toISOString(),
          },
        }),
        prepareAuditEvent({
          workspaceId,
          actorType: "system",
          actorEmail: "SYSTEM",
          action: "tangerino.admission.erp_demand_failed",
          outcome: "failure",
          entityType: "employee",
          entityId: claimed.employee_id,
          after: { consultationId: claimed.id, stage: admission.stage },
        }),
      ]).catch(() => undefined);
    }

    log("info", "tangerino.consultation_completed", { workspaceId }, {
      durationMs, normalizedStatus: admission.normalizedStatus, changed, attempt: claimed.attempt,
      demandStatus: demand.status, demandCardId: demand.cardId ?? "",
    });
    return {
      consultationId: claimed.id, state: "SUCCESS", source: "BROWSER", errorCode: "",
      admission, matchCount: 1, consultedAt: new Date().toISOString(), durationMs,
    };
  } catch (error) {
    const safe = safeTangerinoError(error);
    const durationMs = Date.now() - startedAt;
    /* Retry só para o que pode dar certo da segunda vez (§43).
       `NOT_FOUND`, `MULTIPLE_MATCHES`, `AUTHENTICATION_REQUIRED` e `UI_CHANGED`
       são respostas estáveis: repeti-los gasta navegador para chegar à mesma
       conclusão, e no caso do login repetido ainda arrisca bloquear a conta do
       cliente por tentativa sucessiva. */
    const retry = safe.retryable && !safe.requiresUserAction && claimed.attempt < 2;
    const state = retry ? "QUEUED" : safe.state;
    const matchCount = /MULTIPLE_MATCHES/u.test(safe.code) ? extractMatchCount(safe.message) : 0;

    await d1.batch([
      d1.prepare(`UPDATE fdp_tangerino_admission_consultations SET state = ?, error_code = ?, match_count = ?,
          duration_ms = ?, consulted_at = CASE WHEN ? = 'QUEUED' THEN NULL ELSE CURRENT_TIMESTAMP END, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ?`)
        .bind(state, safe.code, matchCount, durationMs, state, workspaceId, claimed.id),
      prepareDomainEvent(d1, {
        workspaceId,
        eventType: safe.requiresUserAction ? "tangerino.authentication.required" : "tangerino.consultation.failed",
        entityType: "tangerino_consultation", entityId: claimed.id,
        payload: {
          consultationId: claimed.id, employeeId: claimed.employee_id, state, errorCode: safe.code,
          occurredAt: new Date().toISOString(),
        },
      }),
      prepareAuditEvent({
        workspaceId, actorType: "system", actorEmail: "SYSTEM", action: "tangerino.consultation.failed", outcome: "failure",
        entityType: "tangerino_consultation", entityId: claimed.id,
        after: { employeeId: claimed.employee_id, state, errorCode: safe.code, retry, attempt: claimed.attempt },
      }),
    ]);
    /* O que vai para o log é o suficiente para investigar e nada além (§52).
       Sem nome, sem matrícula, sem texto lido da tela: um `UI_CHANGED` recorrente
       se diagnostica pela etapa e pelo código, não por saber de quem era o
       processo. */
    log(safe.layoutRelated ? "warn" : "error", "tangerino.consultation_failed", { workspaceId }, {
      errorCode: safe.code, state, retry, attempt: claimed.attempt, durationMs, layoutRelated: safe.layoutRelated,
    });
    return {
      consultationId: claimed.id, state: state as ConsultationResult["state"], source: "BROWSER", errorCode: safe.code,
      admission: null, matchCount, consultedAt: new Date().toISOString(), durationMs,
    };
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}
