/**
 * Execução recorrente dos agentes (§27 a §35, §80 a §87).
 *
 * O que este módulo faz é decidir **quando** enfileirar e o que gravar depois
 * que a execução termina. Ele não executa nada: quem executa continua sendo
 * `processNextIntegrationJob` (conectores de API) e o worker do navegador
 * (Sankhya), pelos mesmos caminhos de sempre.
 *
 * ## Nada roda dentro da requisição do usuário (§28)
 *
 * A varredura mora em `/api/cron/integrations`, que já existe, já é autenticada
 * por segredo e já é chamada pela Vercel Cron e pelo workflow do GitHub. Não há
 * plataforma nova: a §76 pede para mapear os runners existentes antes de criar
 * um, e o mapeamento devolveu um runner que já drena a mesma fila que os agentes
 * usam. Executar agente dentro do request de quem abriu a tela seria o caminho
 * mais curto e o mais errado — a pessoa esperaria o Playwright subir.
 *
 * ## Onde mora cada garantia
 *
 *   * **Lease** — `fdp_integration_jobs.lease_token` + `lease_expires_at`, com
 *     `FOR UPDATE SKIP LOCKED` na reserva. Dois runners não pegam o mesmo job.
 *   * **Um agente por vez** — índice único parcial `fdp_integration_jobs_active_uq`
 *     (migration 0064). Dois jobs para o mesmo conector não existem.
 *   * **Heartbeat** — `renewAgentLease`, chamado a cada mudança de fase pelo
 *     worker de navegador, cuja execução dura mais que a reserva inicial.
 *   * **Recuperação** — a própria reserva vencida devolve o job: a consulta de
 *     claim aceita `leased` com `lease_expires_at` no passado.
 *   * **Espera crescente e degradação** — `consecutive_failures` no conector,
 *     lido por `backoffMinutes` e `agentHealth`.
 */
import type { getD1 } from "../db";

import { ApiError } from "./api-errors.ts";
import {
  agentCadence, agentIsDue, backoffMinutes, DEGRADED_AFTER_FAILURES,
  nextRunAt, scheduledRunKey, type AgentCadence, type AgentEligibilityReason,
} from "./agent-schedule.ts";
import { resolveAgentChannel } from "./agent-runtime.ts";

type Database = ReturnType<typeof getD1>;

export type SchedulableAgent = {
  integrationId: string;
  channel: string;
  displayName: string;
  status: string;
  scheduleEnabled: boolean;
  cadence: AgentCadence;
  timeZone: string;
  nextRunAt: string | null;
  consecutiveFailures: number;
  hasActiveJob: boolean;
  hasCredential: boolean;
  hasMapping: boolean;
};

const text = (value: unknown) => (value == null ? "" : String(value));

/**
 * Conectores que se comportam como agente e podem ser disparados pela API.
 *
 * `sankhya_browser` fica de fora **desta** consulta de propósito: ele tem
 * portão de módulo, configuração própria e um worker separado, e continua
 * sendo agendado pelo caminho que já existia. Misturar os dois aqui daria dois
 * lugares para enfileirar o mesmo conector — exatamente o que o índice único
 * novo passou a proibir.
 */
export async function listSchedulableAgents(d1: Database, workspaceId: string): Promise<SchedulableAgent[]> {
  const rows = await d1.prepare(`SELECT i.id, i.channel, i.display_name, i.status,
        i.schedule_enabled, i.schedule_cadence, i.schedule_timezone, i.next_sync_at, i.consecutive_failures,
        EXISTS (SELECT 1 FROM fdp_integration_jobs j
          WHERE j.workspace_id = i.workspace_id AND j.integration_id = i.id
            AND j.status IN ('queued', 'leased')) AS has_active_job,
        EXISTS (SELECT 1 FROM fdp_integration_credentials c
          WHERE c.workspace_id = i.workspace_id AND c.integration_id = i.id
            AND c.credential_type = 'provider_auth' AND c.status = 'active'
            AND (c.expires_at IS NULL OR c.expires_at > CURRENT_TIMESTAMP)) AS has_credential,
        EXISTS (SELECT 1 FROM fdp_integration_mappings m
          WHERE m.workspace_id = i.workspace_id AND m.integration_id = i.id
            AND m.status = 'active' AND m.direction IN ('inbound', 'bidirectional')) AS has_mapping
      FROM fdp_integrations i
      WHERE i.workspace_id = ? AND i.channel IN ('tangerino', 'solides')
      ORDER BY i.channel`)
    .bind(workspaceId).all<Record<string, unknown>>();

  return rows.results.map((row) => ({
    integrationId: text(row.id),
    channel: text(row.channel),
    displayName: text(row.display_name),
    status: text(row.status),
    scheduleEnabled: Number(row.schedule_enabled ?? 0) === 1,
    cadence: agentCadence(row.schedule_cadence).key,
    timeZone: text(row.schedule_timezone) || "America/Sao_Paulo",
    nextRunAt: text(row.next_sync_at) || null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    hasActiveJob: row.has_active_job === true || row.has_active_job === 1,
    hasCredential: row.has_credential === true || row.has_credential === 1,
    hasMapping: row.has_mapping === true || row.has_mapping === 1,
  }));
}

export type ScheduleDecision = {
  agent: SchedulableAgent;
  due: boolean;
  reason: AgentEligibilityReason | "missing_credential" | "missing_mapping";
  idempotencyKey: string;
};

/**
 * Quem roda agora, e por que os demais não rodam.
 *
 * Custo (§87): agente pausado, sem credencial, sem mapeamento publicado ou com
 * cadência manual nem chega a ser enfileirado. Cada um desses casos gastaria uma
 * vaga da varredura para produzir uma falha previsível — e um erro previsível
 * repetido a cada meia hora é o que faz a equipe parar de ler o painel de erros.
 */
export function decideAgentSchedule(agents: readonly SchedulableAgent[], now: Date): ScheduleDecision[] {
  return agents.map((agent) => {
    const base = agentIsDue({
      status: agent.status,
      scheduleEnabled: agent.scheduleEnabled,
      cadence: agent.cadence,
      nextRunAt: agent.nextRunAt,
      hasActiveJob: agent.hasActiveJob,
      timeZone: agent.timeZone,
      now,
    });
    const idempotencyKey = scheduledRunKey({ agentKey: agent.channel, cadence: agent.cadence, at: now });
    if (!base.due) return { agent, due: false, reason: base.reason, idempotencyKey };
    if (!agent.hasCredential) return { agent, due: false, reason: "missing_credential" as const, idempotencyKey };
    if (!agent.hasMapping) return { agent, due: false, reason: "missing_mapping" as const, idempotencyKey };
    return { agent, due: true, reason: "ok" as const, idempotencyKey };
  });
}

/**
 * Grava o próximo horário previsto.
 *
 * Chamado **ao enfileirar**, e não ao concluir: se dependesse da conclusão, um
 * agente cuja execução trava deixaria de ter horário previsto e sumiria da
 * varredura — silenciosamente, que é o pior jeito de uma automação parar.
 */
export function prepareNextRun(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  cadence: AgentCadence | string;
  timeZone: string;
  from: Date;
}) {
  const next = nextRunAt({ cadence: input.cadence, from: input.from, timeZone: input.timeZone });
  return d1.prepare(`UPDATE fdp_integrations
      SET next_sync_at = ?::timestamptz, updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND id = ?`)
    .bind(next ? next.toISOString() : null, input.workspaceId, input.integrationId);
}

/**
 * Desfecho da execução: zera ou acumula a falha.
 *
 * A espera crescente é gravada em `next_sync_at`, e não em `available_at` do
 * job: o job já tem a própria retentativa, com o próprio teto. O que este
 * método controla é a distância até a **próxima leitura da origem** — é isso
 * que evita martelar um sistema externo indisponível (§33, §86).
 */
export function prepareAgentOutcome(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  succeeded: boolean;
}) {
  if (input.succeeded) {
    /* O próximo horário não é recalculado aqui: ele já foi gravado no momento
       do enfileiramento, justamente para que uma execução que trava não deixe o
       conector sem horário previsto. */
    return d1.prepare(`UPDATE fdp_integrations
        SET consecutive_failures = 0, degraded_since = NULL,
            last_successful_sync_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ?`)
      .bind(input.workspaceId, input.integrationId);
  }

  /* A espera é calculada no banco a partir do contador já incrementado, para
     que duas conclusões simultâneas não escrevam a mesma espera. `CASE` em vez
     de `backoffMinutes` porque a conta precisa enxergar o valor novo. */
  return d1.prepare(`UPDATE fdp_integrations
      SET consecutive_failures = consecutive_failures + 1,
          degraded_since = CASE
            WHEN consecutive_failures + 1 >= ? THEN COALESCE(degraded_since, CURRENT_TIMESTAMP)
            ELSE degraded_since END,
          next_sync_at = CURRENT_TIMESTAMP + make_interval(mins => CASE
            WHEN consecutive_failures + 1 >= 4 THEN 60
            WHEN consecutive_failures + 1 = 3 THEN 15
            WHEN consecutive_failures + 1 = 2 THEN 5
            ELSE 1 END),
          updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND id = ?`)
    .bind(DEGRADED_AFTER_FAILURES, input.workspaceId, input.integrationId);
}

/**
 * Renova a reserva de um job em andamento (§32).
 *
 * O `lease_token` no `WHERE` é o que impede a renovação cega: um worker que
 * perdeu a reserva para outro — porque travou por tempo demais — não consegue
 * estendê-la de volta e reescrever por cima do trabalho de quem assumiu.
 */
export async function renewAgentLease(d1: Database, input: {
  workspaceId: string;
  jobId: string;
  leaseToken: string;
  minutes: number;
}) {
  const minutes = Math.max(1, Math.min(60, Math.trunc(input.minutes) || 5));
  const row = await d1.prepare(`UPDATE fdp_integration_jobs
      SET lease_expires_at = CURRENT_TIMESTAMP + make_interval(mins => ?), updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND id = ? AND lease_token = ? AND status = 'leased'
    RETURNING id`)
    .bind(minutes, input.workspaceId, input.jobId, input.leaseToken).first<{ id: string }>();
  return Boolean(row);
}

/**
 * Traduz a colisão do índice único em recusa explicada (§24).
 *
 * Sem isto, clicar duas vezes em "Executar agora" devolveria um erro de banco
 * cru. A frase precisa dizer o que está acontecendo — já existe uma execução —
 * porque a reação natural de quem vê erro é clicar de novo.
 */
export function asAgentQueueConflict(error: unknown): ApiError | null {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "23505" && /fdp_integration_jobs_active_uq/iu.test(message)) {
    return new ApiError(409, "AGENT_RUN_ALREADY_ACTIVE",
      "Este agente já tem uma execução em andamento. Aguarde o fim dela antes de disparar outra.");
  }
  return null;
}

/** Chave de reprocessamento: muda de propósito, para não colidir com a original (§25). */
export function reprocessRunKey(input: { runId: string; at: Date }) {
  return `agent:reprocess:${input.runId}:${input.at.toISOString().slice(0, 16)}`;
}

/**
 * Espera até a próxima tentativa, em minutos, para a tela explicar a demora.
 *
 * A mesma tabela do banco, escrita uma vez em TypeScript: a duplicação é
 * consciente e está coberta por teste, porque a alternativa — consultar o banco
 * para desenhar um rótulo — custaria uma ida ao servidor por linha da lista.
 */
export function nextAttemptInMinutes(consecutiveFailures: number) {
  return consecutiveFailures > 0 ? backoffMinutes(consecutiveFailures) : 0;
}

/** O canal canônico, recusando o que não é agente. Usado pelas rotas. */
export function requireAgentChannel(value: unknown) {
  const channel = resolveAgentChannel(value);
  if (!channel) {
    throw ApiError.badRequest("Este agente não existe.", "AGENT_UNKNOWN");
  }
  return channel;
}
