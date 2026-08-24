import type { getD1 } from "../../db/index.ts";
import { ApiError } from "../api-errors.ts";
import { TANGERINO_AGENT_DISABLED_MESSAGE, TANGERINO_MODULE_DISABLED_MESSAGE, tangerinoAgentConfig } from "./config.ts";
import type { AdmissionConsultationTarget, ConsultationState } from "./types.ts";

type Database = ReturnType<typeof getD1>;

export type ConsultationRow = {
  id: string;
  state: ConsultationState;
  error_code: string;
  raw_status: string;
  normalized_status: string;
  stage: string;
  pending_reason: string;
  admission_date: string;
  source_updated_at: string;
  external_admission_id: string;
  match_count: number;
  requested_at: string;
  consulted_at: string | null;
  duration_ms: number;
};

const CONSULTATION_COLUMNS = `id, state, error_code, raw_status, normalized_status, stage, pending_reason,
  admission_date, source_updated_at, external_admission_id, match_count,
  requested_at::text AS requested_at, consulted_at::text AS consulted_at, duration_ms`;

/** O módulo é liberado por workspace pela plataforma, como o conector Sankhya. */
export async function isTangerinoAgentEnabled(d1: Database, workspaceId: string) {
  const row = await d1.prepare(`SELECT 1 AS enabled FROM fdp_workspace_module_grants
    WHERE workspace_id = ? AND module_key = 'tangerino_browser' AND granted = 1
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`).bind(workspaceId).first();
  return Boolean(row);
}

/**
 * Dois portões, e a ordem entre eles é deliberada.
 *
 * O da instalação vem primeiro: quando o agente está desligado no deployment,
 * nenhum workspace consulta, e dizer "seu módulo não está liberado" mandaria a
 * pessoa pedir à plataforma uma liberação que não resolveria nada. Só depois
 * disso a pergunta "este grupo tem o módulo?" faz sentido.
 */
export async function requireTangerinoAgent(d1: Database, workspaceId: string) {
  if (!tangerinoAgentConfig().enabled) {
    throw ApiError.forbidden(TANGERINO_AGENT_DISABLED_MESSAGE, "TANGERINO_AGENT_DISABLED");
  }
  if (!await isTangerinoAgentEnabled(d1, workspaceId)) {
    throw ApiError.forbidden(TANGERINO_MODULE_DISABLED_MESSAGE, "TANGERINO_FEATURE_DISABLED");
  }
}

/**
 * Monta o alvo da consulta a partir do cadastro, no servidor.
 *
 * Esta função é a fronteira da §17 e da §58. O frontend manda um `employeeId` e
 * nada mais; empresa, matrícula, nome e vínculo externo saem daqui, do banco já
 * escopado pelo workspace da sessão. Aceitar qualquer um desses campos vindo do
 * cliente transformaria a consulta numa busca livre dentro do Tangerino da
 * empresa — e um `employeeId` de outro workspace simplesmente não é encontrado,
 * porque o RLS não o enxerga.
 */
export async function loadConsultationTarget(d1: Database, workspaceId: string, employeeId: string): Promise<AdmissionConsultationTarget> {
  const employee = await d1.prepare(`SELECT employee.id, employee.company_id, employee.registration_number, employee.full_name,
      COALESCE(reference.external_id, '') AS external_admission_id
    FROM fdp_employees employee
    LEFT JOIN fdp_employee_external_refs reference
      ON reference.workspace_id = employee.workspace_id AND reference.employee_id = employee.id AND reference.source = 'tangerino'
    WHERE employee.workspace_id = ? AND employee.id = ?`)
    .bind(workspaceId, employeeId)
    .first<{ id: string; company_id: string; registration_number: string; full_name: string; external_admission_id: string }>();
  if (!employee) throw ApiError.notFound("Colaborador não encontrado neste grupo.", "EMPLOYEE_NOT_FOUND");
  return {
    workspaceId,
    companyId: String(employee.company_id),
    employeeId: String(employee.id),
    externalAdmissionId: String(employee.external_admission_id ?? ""),
    registrationNumber: String(employee.registration_number ?? ""),
    fullName: String(employee.full_name ?? ""),
  };
}

/** A integração do canal de navegador, com credencial configurada. */
async function requireIntegration(d1: Database, workspaceId: string) {
  const integration = await d1.prepare(`SELECT id FROM fdp_integrations
    WHERE workspace_id = ? AND channel = 'tangerino_browser'`).bind(workspaceId).first<{ id: string }>();
  if (!integration) throw ApiError.notFound("O agente Tangerino não está configurado neste grupo.", "TANGERINO_INTEGRATION_NOT_FOUND");
  const credential = await d1.prepare(`SELECT 1 AS configured FROM fdp_integration_credentials
    WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`).bind(workspaceId, integration.id).first();
  if (!credential) {
    throw new ApiError(409, "TANGERINO_CREDENTIAL_REQUIRED",
      "Configure o usuário e a senha do agente Tangerino em Integrações antes de consultar.");
  }
  return String(integration.id);
}

/** A consulta mais recente deste colaborador, seja qual for o desfecho. */
export async function lastConsultation(d1: Database, workspaceId: string, employeeId: string) {
  return d1.prepare(`SELECT ${CONSULTATION_COLUMNS} FROM fdp_tangerino_admission_consultations
    WHERE workspace_id = ? AND employee_id = ? ORDER BY requested_at DESC LIMIT 1`)
    .bind(workspaceId, employeeId).first<ConsultationRow>();
}

/** O histórico que a tela mostra (§45). */
export async function consultationHistory(d1: Database, workspaceId: string, employeeId: string, limit = 20) {
  const rows = await d1.prepare(`SELECT ${CONSULTATION_COLUMNS} FROM fdp_tangerino_admission_consultations
    WHERE workspace_id = ? AND employee_id = ? AND state = 'SUCCESS'
    ORDER BY requested_at DESC LIMIT ?`)
    .bind(workspaceId, employeeId, Math.min(100, Math.max(1, limit))).all<ConsultationRow>();
  return rows.results;
}

export async function consultationById(d1: Database, workspaceId: string, consultationId: string) {
  return d1.prepare(`SELECT ${CONSULTATION_COLUMNS} FROM fdp_tangerino_admission_consultations
    WHERE workspace_id = ? AND id = ?`).bind(workspaceId, consultationId).first<ConsultationRow>();
}

export type EnqueueOutcome =
  | { outcome: "queued"; consultation: ConsultationRow }
  | { outcome: "already_running"; consultation: ConsultationRow }
  | { outcome: "cached"; consultation: ConsultationRow };

/**
 * Enfileira a consulta, ou explica por que não precisou.
 *
 * Três desfechos, e nenhum deles é erro:
 *
 * `cached` — houve uma consulta bem-sucedida há poucos segundos. Abrir um
 *   navegador para reler o que acabou de ser lido gasta um minuto de execução e
 *   uma sessão no Tangerino do cliente para devolver o mesmo texto (§41).
 * `already_running` — já existe uma de pé para esta pessoa. Devolver a que
 *   existe é melhor que recusar: quem clicou quer o resultado, e o resultado
 *   está a caminho (§39).
 * `queued` — criou.
 *
 * O `force` pula o cache, e só ele; o trinco de concorrência não tem escape,
 * porque forçar dois navegadores na mesma pessoa não acelera nada e dobra a
 * chance de o Tangerino barrar a conta por uso anômalo.
 */
export async function enqueueConsultation(d1: Database, input: {
  target: AdmissionConsultationTarget;
  requestedByUserId: string;
  force?: boolean;
}): Promise<EnqueueOutcome> {
  const { target } = input;
  await requireTangerinoAgent(d1, target.workspaceId);
  const integrationId = await requireIntegration(d1, target.workspaceId);
  const config = tangerinoAgentConfig();

  const running = await d1.prepare(`SELECT ${CONSULTATION_COLUMNS} FROM fdp_tangerino_admission_consultations
    WHERE workspace_id = ? AND employee_id = ? AND state IN ('QUEUED', 'RUNNING')
    ORDER BY requested_at DESC LIMIT 1`)
    .bind(target.workspaceId, target.employeeId).first<ConsultationRow>();
  if (running) return { outcome: "already_running", consultation: running };

  if (!input.force && config.cacheTtlSeconds > 0) {
    const fresh = await d1.prepare(`SELECT ${CONSULTATION_COLUMNS} FROM fdp_tangerino_admission_consultations
      WHERE workspace_id = ? AND employee_id = ? AND state = 'SUCCESS'
        AND consulted_at > CURRENT_TIMESTAMP - make_interval(secs => ?)
      ORDER BY consulted_at DESC LIMIT 1`)
      .bind(target.workspaceId, target.employeeId, config.cacheTtlSeconds).first<ConsultationRow>();
    if (fresh) return { outcome: "cached", consultation: fresh };
  }

  await assertWithinRateLimit(d1, target.workspaceId, input.requestedByUserId, config.rateLimitPerMinute);

  const id = crypto.randomUUID();
  try {
    const created = await d1.prepare(`INSERT INTO fdp_tangerino_admission_consultations
      (id, workspace_id, company_id, employee_id, integration_id, requested_by_user_id, state, external_admission_id)
      VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?)
      RETURNING ${CONSULTATION_COLUMNS}`)
      .bind(id, target.workspaceId, target.companyId, target.employeeId, integrationId,
        input.requestedByUserId, target.externalAdmissionId)
      .first<ConsultationRow>();
    if (!created) throw new ApiError(409, "TANGERINO_CONSULTATION_NOT_CREATED", "Não foi possível criar a consulta.");
    return { outcome: "queued", consultation: created };
  } catch (error) {
    /* O índice parcial `fdp_tangerino_consultations_active_uq` é quem realmente
       impede duas consultas simultâneas: a verificação lá em cima resolve o caso
       comum, mas duas requisições concorrentes passam por ela juntas. Quando o
       banco recusa, a resposta certa não é erro — é devolver a consulta que
       ganhou a corrida, que é o que quem clicou queria. */
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "23505" || (error instanceof Error && /tangerino_consultations_active_uq/iu.test(error.message))) {
      const winner = await d1.prepare(`SELECT ${CONSULTATION_COLUMNS} FROM fdp_tangerino_admission_consultations
        WHERE workspace_id = ? AND employee_id = ? AND state IN ('QUEUED', 'RUNNING')
        ORDER BY requested_at DESC LIMIT 1`)
        .bind(target.workspaceId, target.employeeId).first<ConsultationRow>();
      if (winner) return { outcome: "already_running", consultation: winner };
    }
    throw error;
  }
}

/**
 * Limite por pessoa, não por workspace.
 *
 * Um clique repetido é de alguém; contá-lo no grupo faria a impaciência de uma
 * pessoa bloquear a equipe inteira. E a janela conta a *requisição*, não o
 * sucesso: uma consulta que falha também abriu navegador e também consumiu
 * sessão no Tangerino.
 */
export async function assertWithinRateLimit(d1: Database, workspaceId: string, userId: string, perMinute: number) {
  const recent = await d1.prepare(`SELECT COUNT(*)::int AS total FROM fdp_tangerino_admission_consultations
    WHERE workspace_id = ? AND requested_by_user_id = ? AND requested_at > CURRENT_TIMESTAMP - INTERVAL '1 minute'`)
    .bind(workspaceId, userId).first<{ total: number }>();
  if (Number(recent?.total ?? 0) >= perMinute) {
    throw new ApiError(429, "TANGERINO_RATE_LIMITED",
      `Você já pediu ${perMinute} consultas neste minuto. Aguarde um instante antes de consultar de novo.`);
  }
}
