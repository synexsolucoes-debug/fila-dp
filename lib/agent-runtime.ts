/**
 * Estado de execução dos agentes por workspace (§20 a §26, §37, §82).
 *
 * Nenhuma tabela nova aqui, e isso continua sendo a decisão principal deste
 * arquivo. Um agente do Vinculato **é** um conector: Sankhya e Tangerino já
 * vivem em `fdp_integrations`, com credencial no cofre, `status` por workspace,
 * execuções em `fdp_integration_sync_runs`, logs em `fdp_integration_run_logs` e
 * eventos em `fdp_integration_events`. Criar um `fdp_agents` ao lado disso
 * duplicaria o ciclo de vida e daria dois lugares para pausar a mesma coisa —
 * que é como se descobre, no pior momento, que a automação parada continuava
 * rodando pelo outro caminho.
 *
 * O kill switch, portanto, é `fdp_integrations.status = 'paused'`: já existe,
 * já é por workspace, já é respeitado pelo webhook, e não depende de deploy.
 *
 * ## Integração e agente não são a mesma coisa (§82)
 *
 * Integração é a **conexão**: para onde apontar, com que credencial, com que
 * mapeamento. Agente é o **executor** que lê aquela origem, interpreta e propõe.
 * O Sankhya tem os dois: a conexão e o agente de navegador que a percorre. O
 * Teams tem só a conexão — a entrada dele é webhook, e não há nada para o
 * Vinculato ir buscar. Por isso o canal traz um `kind`, e por isso a tela
 * mostra o Teams com execução vazia em vez de fingir que ele tem uma.
 */
import type { getD1 } from "../db";

import {
  agentCadence, agentHealth, agentHealthLabels,
  type AgentCadence, type AgentHealth,
} from "./agent-schedule.ts";
import { cleanText } from "./registrations.ts";

type Database = ReturnType<typeof getD1>;

/**
 * Canais que se comportam como agente.
 *
 * `sankhya_browser` é o nome real do canal em `fdp_integrations` — a lista
 * anterior dizia `sankhya`, e o efeito era que o agente de navegador, que é o
 * mais caro e o mais frágil dos três, simplesmente não aparecia na
 * administração. Um agente que não aparece não pode ser pausado pela tela.
 *
 * "Agente" aqui tem sentido estrito: automação que **lê** um sistema de origem
 * e propõe. Teams entra na lista como canal, não como executor: ele produz
 * propostas, mas quem as traz é um webhook. E-mail e WhatsApp alimentam a caixa
 * de entrada e não propõem nada — não estão aqui.
 */
export const agentChannels = ["sankhya_browser", "tangerino", "solides", "teams"] as const;
export type AgentChannel = typeof agentChannels[number];

/** Canais cuja execução o Vinculato dispara; os demais só recebem. */
const EXECUTOR_CHANNELS = new Set<AgentChannel>(["sankhya_browser", "tangerino", "solides"]);

/**
 * Apelidos aceitos de fora.
 *
 * As propostas gravadas em `fdp_agent_proposals.agent_key` usam `sankhya`, e a
 * chave já está em dado de cliente. Traduzir aqui deixa os dois vocabulários
 * válidos sem migrar histórico — o mesmo caminho que a autorização já usa para
 * as capacidades renomeadas.
 */
const CHANNEL_ALIASES: Record<string, AgentChannel> = {
  sankhya: "sankhya_browser",
  sankhya_browser: "sankhya_browser",
  tangerino: "tangerino",
  solides: "solides",
  teams: "teams",
};

export function isAgentChannel(value: unknown): value is AgentChannel {
  return typeof value === "string" && (agentChannels as readonly string[]).includes(value);
}

/** O canal canônico de uma chave vinda de fora, ou `""` quando não é agente. */
export function resolveAgentChannel(value: unknown): AgentChannel | "" {
  const key = cleanText(value, 60);
  return CHANNEL_ALIASES[key] ?? "";
}

export type AgentRuntimeStatus = {
  /** Canal canônico — é ele que a tela usa como identificador. */
  key: AgentChannel;
  integrationId: string;
  channel: string;
  displayName: string;
  /** `agent` executa; `channel` apenas recebe (§82). */
  kind: "agent" | "channel";
  connectorVersion: string;
  /** `connected`, `paused`, `needs_credentials`… vem do conector. */
  status: string;
  /** O kill switch: `false` significa que nada deste agente é considerado. */
  enabled: boolean;
  health: AgentHealth;
  healthLabel: string;
  healthTone: "critical" | "warning" | "neutral" | "positive";
  healthDetail: string;
  lastError: string | null;
  schedule: {
    enabled: boolean;
    cadence: AgentCadence;
    cadenceLabel: string;
    timeZone: string;
    nextRunAt: string | null;
    consecutiveFailures: number;
    degradedSince: string | null;
  };
  runs: {
    total: number;
    failed: number;
    succeeded: number;
    lastAt: string | null;
    lastStatus: string;
    lastSuccessAt: string | null;
    lastDurationMs: number | null;
    averageDurationMs: number | null;
    /** Somatório dos itens das execuções da janela: o que o agente fez. */
    received: number;
    processed: number;
    skipped: number;
    failedItems: number;
  };
  /** Fila: o que está esperando e o que desistiu (§35). */
  queue: { active: number; deadLetter: number };
  events: { received: number; processed: number; ignored: number; failed: number; deduplicated: number };
  proposals: { pendingTriage: number; suggested: number; applied: number; rejected: number };
};

const text = (value: unknown) => (value == null ? "" : String(value));
const count = (value: unknown) => Number(value ?? 0) || 0;
const nullable = (value: unknown) => (text(value) || null);

/** Janela das agregações. Trinta dias mostram tendência sem virar histórico. */
export const AGENT_METRICS_WINDOW_DAYS = 30;

/**
 * Painel de agentes: o que cada um leu, propôs, ignorou e falhou.
 *
 * Tudo é agregado por consulta e nada é acumulado em contador próprio — um
 * contador que alguém esquece de incrementar mente por meses, e o operador só
 * descobre quando confia nele para decidir se pausa a automação.
 */
export async function listAgentRuntime(
  d1: Database,
  workspaceId: string,
  now = new Date(),
): Promise<AgentRuntimeStatus[]> {
  const [integrations, runs, lastRuns, events, proposals, jobs] = await Promise.all([
    d1.prepare(`SELECT id, channel, display_name, status, connector_version, last_sync_at,
          last_successful_sync_at, next_sync_at, schedule_enabled, schedule_cadence,
          schedule_timezone, consecutive_failures, degraded_since, last_error
        FROM fdp_integrations WHERE workspace_id = ? ORDER BY channel`)
      .bind(workspaceId).all<Record<string, unknown>>(),
    d1.prepare(`SELECT r.integration_id, count(*)::int AS total,
          count(*) FILTER (WHERE r.status IN ('failed', 'requires_user_action'))::int AS failed,
          count(*) FILTER (WHERE r.status IN ('succeeded', 'partial'))::int AS succeeded,
          max(r.created_at)::text AS last_at,
          max(r.completed_at) FILTER (WHERE r.status IN ('succeeded', 'partial'))::text AS last_success_at,
          avg(NULLIF(r.duration_ms, 0))::int AS average_duration_ms,
          sum(r.received_count)::int AS received,
          sum(r.processed_count)::int AS processed,
          sum(r.skipped_count)::int AS skipped,
          sum(r.failed_count)::int AS failed_items
        FROM fdp_integration_sync_runs r
        WHERE r.workspace_id = ? AND r.created_at >= now() - make_interval(days => ?)
        GROUP BY r.integration_id`)
      .bind(workspaceId, AGENT_METRICS_WINDOW_DAYS).all<Record<string, unknown>>(),
    /* A última execução, e não a última bem-sucedida: o que a tela precisa dizer
       primeiro é "como terminou a mais recente". */
    d1.prepare(`SELECT DISTINCT ON (r.integration_id) r.integration_id, r.status, r.duration_ms
        FROM fdp_integration_sync_runs r WHERE r.workspace_id = ?
        ORDER BY r.integration_id, r.created_at DESC`)
      .bind(workspaceId).all<Record<string, unknown>>(),
    d1.prepare(`SELECT e.integration_id,
          count(*)::int AS received,
          count(*) FILTER (WHERE e.status = 'processed')::int AS processed,
          count(*) FILTER (WHERE e.status = 'ignored')::int AS ignored,
          count(*) FILTER (WHERE e.status = 'error')::int AS failed,
          COALESCE(sum(e.duplicate_count), 0)::int AS deduplicated
        FROM fdp_integration_events e
        WHERE e.workspace_id = ? AND e.received_at >= now() - make_interval(days => ?)
        GROUP BY e.integration_id`)
      .bind(workspaceId, AGENT_METRICS_WINDOW_DAYS).all<Record<string, unknown>>(),
    d1.prepare(`SELECT p.agent_key,
          count(*) FILTER (WHERE p.status = 'pending_triage')::int AS pending_triage,
          count(*) FILTER (WHERE p.status = 'suggested')::int AS suggested,
          count(*) FILTER (WHERE p.status = 'applied')::int AS applied,
          count(*) FILTER (WHERE p.status IN ('rejected', 'discarded'))::int AS rejected
        FROM fdp_agent_proposals p
        WHERE p.workspace_id = ?
        GROUP BY p.agent_key`)
      .bind(workspaceId).all<Record<string, unknown>>(),
    d1.prepare(`SELECT j.integration_id,
          count(*) FILTER (WHERE j.status IN ('queued', 'leased'))::int AS active,
          count(*) FILTER (WHERE j.status = 'dead_letter')::int AS dead_letter
        FROM fdp_integration_jobs j WHERE j.workspace_id = ?
        GROUP BY j.integration_id`)
      .bind(workspaceId).all<Record<string, unknown>>(),
  ]);

  const runsById = new Map(runs.results.map((row) => [text(row.integration_id), row]));
  const lastById = new Map(lastRuns.results.map((row) => [text(row.integration_id), row]));
  const eventsById = new Map(events.results.map((row) => [text(row.integration_id), row]));
  const jobsById = new Map(jobs.results.map((row) => [text(row.integration_id), row]));

  /* As propostas são agrupadas pelo canal canônico: `sankhya` e
     `sankhya_browser` são o mesmo agente e não podem virar duas linhas. */
  const proposalsByChannel = new Map<string, { pending_triage: number; suggested: number; applied: number; rejected: number }>();
  for (const row of proposals.results) {
    const channel = resolveAgentChannel(row.agent_key);
    if (!channel) continue;
    const current = proposalsByChannel.get(channel)
      ?? { pending_triage: 0, suggested: 0, applied: 0, rejected: 0 };
    current.pending_triage += count(row.pending_triage);
    current.suggested += count(row.suggested);
    current.applied += count(row.applied);
    current.rejected += count(row.rejected);
    proposalsByChannel.set(channel, current);
  }

  return integrations.results
    .filter((row) => isAgentChannel(text(row.channel)))
    .map((row) => {
      const id = text(row.id);
      const channel = text(row.channel) as AgentChannel;
      const run = runsById.get(id) ?? {};
      const last = lastById.get(id) ?? {};
      const event = eventsById.get(id) ?? {};
      const job = jobsById.get(id) ?? {};
      const proposal = proposalsByChannel.get(channel) ?? { pending_triage: 0, suggested: 0, applied: 0, rejected: 0 };
      const status = text(row.status);
      const cadence = agentCadence(row.schedule_cadence);
      const lastStatus = text(last.status);

      const health = agentHealth({
        status,
        scheduleEnabled: count(row.schedule_enabled) === 1,
        cadence: cadence.key,
        lastRunAt: nullable(row.last_sync_at),
        nextRunAt: nullable(row.next_sync_at),
        consecutiveFailures: count(row.consecutive_failures),
        lastRunFailed: lastStatus === "failed" || lastStatus === "requires_user_action",
        now,
      });
      const meta = agentHealthLabels[health];

      return {
        key: channel,
        integrationId: id,
        channel,
        displayName: text(row.display_name) || channel,
        kind: EXECUTOR_CHANNELS.has(channel) ? "agent" : "channel",
        connectorVersion: text(row.connector_version),
        status,
        enabled: status !== "paused",
        health,
        healthLabel: meta.label,
        healthTone: meta.tone,
        healthDetail: meta.detail,
        lastError: nullable(row.last_error),
        schedule: {
          enabled: count(row.schedule_enabled) === 1,
          cadence: cadence.key,
          cadenceLabel: cadence.label,
          timeZone: text(row.schedule_timezone) || "America/Sao_Paulo",
          nextRunAt: nullable(row.next_sync_at),
          consecutiveFailures: count(row.consecutive_failures),
          degradedSince: nullable(row.degraded_since),
        },
        runs: {
          total: count(run.total),
          failed: count(run.failed),
          succeeded: count(run.succeeded),
          lastAt: nullable(row.last_sync_at) ?? nullable(run.last_at),
          lastStatus,
          lastSuccessAt: nullable(row.last_successful_sync_at) ?? nullable(run.last_success_at),
          lastDurationMs: count(last.duration_ms) || null,
          averageDurationMs: count(run.average_duration_ms) || null,
          received: count(run.received),
          processed: count(run.processed),
          skipped: count(run.skipped),
          failedItems: count(run.failed_items),
        },
        queue: { active: count(job.active), deadLetter: count(job.dead_letter) },
        events: {
          received: count(event.received),
          processed: count(event.processed),
          ignored: count(event.ignored),
          failed: count(event.failed),
          deduplicated: count(event.deduplicated),
        },
        proposals: {
          pendingTriage: proposal.pending_triage,
          suggested: proposal.suggested,
          applied: proposal.applied,
          rejected: proposal.rejected,
        },
      } satisfies AgentRuntimeStatus;
    });
}

/**
 * O agente está ligado neste workspace?
 *
 * Consulta única e explícita, chamada antes de qualquer proposta ser
 * considerada. Um agente sem integração cadastrada devolve `false`: automação
 * que ninguém configurou não roda por omissão.
 */
export async function isAgentEnabled(d1: Database, workspaceId: string, agentKey: string) {
  const channel = resolveAgentChannel(agentKey);
  if (!channel) return false;
  const row = await d1.prepare("SELECT status FROM fdp_integrations WHERE workspace_id = ? AND channel = ?")
    .bind(workspaceId, channel).first<{ status: string }>();
  return Boolean(row) && text(row?.status) !== "paused";
}

/** Política de automação do workspace, com o padrão conservador (§84). */
export async function readAgentAutomationPolicy(d1: Database, workspaceId: string) {
  const row = await d1.prepare("SELECT agent_automation FROM fdp_workspace_settings WHERE workspace_id = ?")
    .bind(workspaceId).first<{ agent_automation: string }>();
  const value = text(row?.agent_automation);
  return value === "off" || value === "trusted" ? value : "suggest_only" as const;
}
