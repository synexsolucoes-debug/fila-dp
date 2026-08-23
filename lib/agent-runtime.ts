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
  agentState, agentStateLabels, canRunNow, isVisibleChannel, productAgentByChannel,
  resolveProductAgent, type ProductAgent,
} from "./agent-catalog.ts";
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
/**
 * A lista deixou de morar aqui.
 *
 * Ela agora é a decisão de produto, em `lib/agent-catalog.ts`: **Teams,
 * Tangerino e Sankhya**, e mais nada. Manter uma segunda lista neste arquivo
 * era o que produzia a divergência que a auditoria encontrou — a Central
 * listava `tangerino` e `solides`, que são as **APIs**, e o agente de navegador
 * do Tangerino, que é o que de fato lê o sistema, não aparecia em lugar nenhum.
 * Quem configurava "o Tangerino" configurava outra coisa.
 */
/** O canal interno de uma chave vinda de fora, ou `""` quando não é um dos três. */
export function resolveAgentChannel(value: unknown): string {
  return resolveProductAgent(cleanText(value, 60))?.channel ?? "";
}

export type AgentRuntimeStatus = {
  /** A chave de produto (`tangerino_agent`…). O canal interno não sai daqui. */
  key: string;
  integrationId: string;
  /** "Agente Tangerino". Nunca `tangerino_browser` (§2, §4, §7). */
  displayName: string;
  /** O que ele faz, em uma frase. */
  summary: string;
  /** `agent` executa; `channel` apenas recebe (§82). */
  kind: "agent" | "channel";
  /** Estado em português, com o que ele significa (§10). */
  state: { key: string; label: string; detail: string };
  /** Os passos do setup deste agente, na ordem (§11, §12, §13). */
  steps: readonly string[];
  /** Este agente tem o que executar periodicamente? */
  supportsSchedule: boolean;
  /** "Executar agora" pode aparecer habilitado? (§25) */
  canRunNow: boolean;
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
    /* `last_connection_at` e a existência de credencial ativa entram na mesma
       leitura porque são degraus do estado, não detalhe: sem eles a tela não
       consegue distinguir "credencial pendente" de "teste pendente", e volta a
       dizer só "precisa de credenciais" para as duas situações — que foi o que
       fez alguém gravar a senha e continuar sem entender por que não conectava
       (§10, §23). */
    d1.prepare(`SELECT i.id, i.channel, i.display_name, i.status, i.connector_version, i.last_sync_at,
          i.last_successful_sync_at, i.next_sync_at, i.schedule_enabled, i.schedule_cadence,
          i.schedule_timezone, i.consecutive_failures, i.degraded_since, i.last_error,
          i.last_connection_at,
          (NULLIF(i.config_json, '') IS NOT NULL AND i.config_json <> '{}') AS configured,
          EXISTS (SELECT 1 FROM fdp_integration_credentials c
            WHERE c.workspace_id = i.workspace_id AND c.integration_id = i.id
              AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now())) AS has_credential
        FROM fdp_integrations i WHERE i.workspace_id = ? ORDER BY i.channel`)
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

  /* Só os três do catálogo saem daqui. Os demais conectores continuam no banco,
     com execuções, eventos e auditoria intactos, e continuam administráveis
     pelo console da plataforma — o que muda é que a pessoa que opera não
     precisa mais escolher entre dez coisas para configurar três (§16, §17). */
  return integrations.results
    .filter((row) => isVisibleChannel(text(row.channel)))
    .map((row) => {
      const id = text(row.id);
      const channel = text(row.channel);
      const product = productAgentByChannel(channel) as ProductAgent;
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

      /* O estado de produto e a saúde respondem perguntas diferentes, e por
         isso convivem: a saúde diz "como vai indo", o estado diz "em que degrau
         do caminho isto está". Quem nunca configurou precisa do segundo. */
      const state = agentState({
        paused: status === "paused",
        configured: row.configured === true,
        hasCredential: row.has_credential === true,
        testedAt: nullable(row.last_connection_at),
        enabled: count(row.schedule_enabled) === 1 || status === "connected",
        consecutiveFailures: count(row.consecutive_failures),
        degraded: Boolean(nullable(row.degraded_since)),
        lastRunFailed: lastStatus === "failed" || lastStatus === "requires_user_action",
      });
      const stateMeta = agentStateLabels[state];

      return {
        key: product.key,
        integrationId: id,
        /* O nome vem do catálogo, não da coluna. `display_name` guarda o que
           alguém digitou um dia — inclusive "Tangerino Browser Connector" —, e
           é exatamente esse vazamento de nome técnico que a decisão proíbe. */
        displayName: product.label,
        summary: product.summary,
        kind: product.reads ? "agent" : "channel",
        state: { key: state, label: stateMeta.label, detail: stateMeta.detail },
        steps: product.steps,
        supportsSchedule: product.supportsSchedule,
        canRunNow: canRunNow(product, state),
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
