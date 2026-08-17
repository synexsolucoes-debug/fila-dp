import type { getD1 } from "../../db/index.ts";
import { ApiError } from "../api-errors.ts";
import { assertRunnableSankhyaConfig, parseSankhyaConfig } from "./config.ts";

type Database = ReturnType<typeof getD1>;

export async function isSankhyaWorkspaceEnabled(d1: Database, workspaceId: string) {
  const row = await d1.prepare(`SELECT 1 AS enabled FROM fdp_workspace_module_grants
    WHERE workspace_id = ? AND module_key = 'sankhya_browser' AND granted = 1
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`).bind(workspaceId).first();
  return Boolean(row);
}

/**
 * A frase que o portão devolve quando o módulo não está liberado.
 *
 * A anterior — "O Sankhya Browser Connector não está habilitado para este
 * workspace." — dizia o estado e parava aí. Quem a recebia não tinha como saber
 * se era falha do sistema, se faltava contratar algo, ou a quem pedir; e ela
 * aparece justamente no fim de um formulário preenchido, no momento de vincular
 * o Sankhya. Beco sem saída é a mesma classe de defeito que esta auditoria já
 * corrigiu na redefinição de senha: a mensagem precisa dizer o que destrava.
 *
 * O que destrava está na migration 0038: "O módulo não entra em nenhum plano
 * automaticamente. A plataforma o libera por workspace." Não há plano que o
 * inclua — a liberação é sempre individual. Isso é o que a frase precisa
 * carregar, porque ela alcança dois públicos: o usuário do workspace, que não
 * tem esse botão e precisa saber a quem pedir, e o administrador da plataforma,
 * que tem, e precisa saber onde ele fica.
 */
export const SANKHYA_MODULE_DISABLED_MESSAGE = "O conector Sankhya ainda não está liberado para este workspace. "
  + "Ele não faz parte de nenhum plano: a liberação é individual e feita pela plataforma, "
  + "em Configuração operacional › Acessos e módulos › Módulos do workspace.";

export async function requireSankhyaWorkspaceEnabled(d1: Database, workspaceId: string) {
  if (!await isSankhyaWorkspaceEnabled(d1, workspaceId)) {
    throw ApiError.forbidden(SANKHYA_MODULE_DISABLED_MESSAGE, "SANKHYA_FEATURE_DISABLED");
  }
}

export async function queueSankhyaRun(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  requestedBy?: string | null;
  triggerType: "manual" | "scheduled" | "health_check" | "retry";
  idempotencyKey: string;
}) {
  await requireSankhyaWorkspaceEnabled(d1, input.workspaceId);
  const integration = await d1.prepare(`SELECT id, status, config_json FROM fdp_integrations
    WHERE workspace_id = ? AND id = ? AND channel = 'sankhya_browser'`).bind(input.workspaceId, input.integrationId)
    .first<{ id: string; status: string; config_json: string }>();
  if (!integration) throw ApiError.notFound("Integração Sankhya não encontrada.", "SANKHYA_INTEGRATION_NOT_FOUND");
  const config = parseSankhyaConfig(integration.config_json);
  assertRunnableSankhyaConfig(config);
  if (input.triggerType !== "health_check" && integration.status !== "connected") {
    throw new ApiError(409, "SANKHYA_NOT_CONNECTED", "Teste a conexão Sankhya com sucesso antes de sincronizar.");
  }
  const credentials = await d1.prepare(`SELECT 1 AS configured FROM fdp_integration_credentials
    WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`).bind(input.workspaceId, input.integrationId).first();
  if (!credentials) throw new ApiError(409, "SANKHYA_CREDENTIAL_REQUIRED", "Configure as credenciais Sankhya antes de executar.");

  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const key = input.idempotencyKey.trim().slice(0, 180);
  if (key.length < 8) throw ApiError.badRequest("Chave de idempotência inválida.", "IDEMPOTENCY_KEY_REQUIRED");
  try {
    const run = await d1.prepare(`WITH inserted_run AS (
        INSERT INTO fdp_integration_sync_runs (id, workspace_id, integration_id, trigger_type, status, idempotency_key, requested_by)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)
        ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING RETURNING *
      ), chosen_run AS (
        SELECT * FROM inserted_run UNION ALL
        SELECT * FROM fdp_integration_sync_runs WHERE workspace_id = ? AND integration_id = ? AND idempotency_key = ?
          AND NOT EXISTS (SELECT 1 FROM inserted_run) LIMIT 1
      ), inserted_job AS (
        INSERT INTO fdp_integration_jobs (id, workspace_id, integration_id, run_id, job_type, idempotency_key, payload_json, max_attempts)
        SELECT ?, ?, ?, chosen_run.id, ?, 'run:' || chosen_run.id, jsonb_build_object('runId', chosen_run.id), ? FROM chosen_run
        ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING
      ) SELECT id, integration_id, trigger_type, status, idempotency_key, created_at FROM chosen_run`)
      .bind(runId, input.workspaceId, input.integrationId, input.triggerType, key, input.requestedBy ?? null,
        input.workspaceId, input.integrationId, key, jobId, input.workspaceId, input.integrationId,
        input.triggerType === "health_check" ? "health_check" : "sync", config.maxAttempts)
      .first<Record<string, unknown>>();
    if (!run) throw new ApiError(409, "SANKHYA_RUN_NOT_CREATED", "Não foi possível criar a execução Sankhya.");
    return run;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "23505" || (error instanceof Error && /fdp_sankhya_active_run_uq/iu.test(error.message))) {
      throw new ApiError(409, "SANKHYA_RUN_ALREADY_ACTIVE", "Já existe uma sincronização Sankhya em andamento.");
    }
    throw error;
  }
}
