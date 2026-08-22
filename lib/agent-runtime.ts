/**
 * Estado de execução dos agentes por workspace (§65, §66).
 *
 * Nenhuma tabela nova aqui, e isso é a decisão principal deste arquivo. Um
 * agente do Vinculato **é** um conector: Sankhya e Tangerino já vivem em
 * `fdp_integrations`, com credencial no cofre, `status` por workspace, execuções
 * em `fdp_integration_sync_runs` e eventos em `fdp_integration_events`. Criar um
 * `fdp_agents` ao lado disso duplicaria o ciclo de vida e daria dois lugares
 * para pausar a mesma coisa — que é como se descobre, no pior momento, que a
 * automação parada continuava rodando pelo outro caminho.
 *
 * O kill switch, portanto, é `fdp_integrations.status = 'paused'`: já existe,
 * já é por workspace, já é respeitado pelo webhook, e não depende de deploy.
 */
import type { getD1 } from "../db";

import { cleanText } from "./registrations.ts";

type Database = ReturnType<typeof getD1>;

/**
 * Canais que se comportam como agente.
 *
 * "Agente" aqui tem sentido estrito: automação que **lê** um sistema de origem
 * e propõe. Teams é canal de entrada e entra na lista porque também produz
 * propostas; e-mail e WhatsApp alimentam a caixa de entrada e não propõem nada.
 */
export const agentChannels = ["sankhya", "tangerino", "solides", "teams"] as const;
export type AgentChannel = typeof agentChannels[number];

export function isAgentChannel(value: unknown): value is AgentChannel {
  return typeof value === "string" && (agentChannels as readonly string[]).includes(value);
}

export type AgentRuntimeStatus = {
  key: string;
  channel: string;
  displayName: string;
  /** `connected`, `paused`, `needs_credentials`… vem do conector. */
  status: string;
  /** O kill switch: `false` significa que nada deste agente é considerado. */
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  runs: { total: number; failed: number; lastAt: string | null; lastDurationMs: number | null };
  events: { received: number; processed: number; ignored: number; failed: number };
  proposals: { pendingTriage: number; suggested: number; applied: number; rejected: number };
};

const text = (value: unknown) => (value == null ? "" : String(value));
const count = (value: unknown) => Number(value ?? 0) || 0;

/**
 * Painel de agentes: o que cada um leu, propôs, ignorou e falhou.
 *
 * Tudo é agregado por consulta e nada é acumulado em contador próprio — um
 * contador que alguém esquece de incrementar mente por meses, e o operador só
 * descobre quando confia nele para decidir se pausa a automação.
 */
export async function listAgentRuntime(d1: Database, workspaceId: string): Promise<AgentRuntimeStatus[]> {
  const [integrations, runs, events, proposals] = await Promise.all([
    d1.prepare(`SELECT id, channel, display_name, status, last_sync_at, last_error
        FROM fdp_integrations WHERE workspace_id = ? ORDER BY channel`)
      .bind(workspaceId).all<Record<string, unknown>>(),
    d1.prepare(`SELECT r.integration_id, count(*)::int AS total,
          count(*) FILTER (WHERE r.status = 'failed')::int AS failed,
          max(r.created_at) AS last_at
        FROM fdp_integration_sync_runs r
        WHERE r.workspace_id = ? AND r.created_at >= now() - interval '30 days'
        GROUP BY r.integration_id`)
      .bind(workspaceId).all<Record<string, unknown>>(),
    d1.prepare(`SELECT e.integration_id,
          count(*)::int AS received,
          count(*) FILTER (WHERE e.status = 'processed')::int AS processed,
          count(*) FILTER (WHERE e.status = 'ignored')::int AS ignored,
          count(*) FILTER (WHERE e.status = 'error')::int AS failed
        FROM fdp_integration_events e
        WHERE e.workspace_id = ? AND e.received_at >= now() - interval '30 days'
        GROUP BY e.integration_id`)
      .bind(workspaceId).all<Record<string, unknown>>(),
    d1.prepare(`SELECT p.agent_key,
          count(*) FILTER (WHERE p.status = 'pending_triage')::int AS pending_triage,
          count(*) FILTER (WHERE p.status = 'suggested')::int AS suggested,
          count(*) FILTER (WHERE p.status = 'applied')::int AS applied,
          count(*) FILTER (WHERE p.status IN ('rejected', 'discarded'))::int AS rejected
        FROM fdp_agent_proposals p
        WHERE p.workspace_id = ?
        GROUP BY p.agent_key`)
      .bind(workspaceId).all<Record<string, unknown>>(),
  ]);

  const runsById = new Map(runs.results.map((row) => [text(row.integration_id), row]));
  const eventsById = new Map(events.results.map((row) => [text(row.integration_id), row]));
  const proposalsByKey = new Map(proposals.results.map((row) => [text(row.agent_key), row]));

  return integrations.results
    .filter((row) => isAgentChannel(text(row.channel)))
    .map((row) => {
      const id = text(row.id);
      const channel = text(row.channel);
      const run = runsById.get(id) ?? {};
      const event = eventsById.get(id) ?? {};
      const proposal = proposalsByKey.get(channel) ?? {};
      const status = text(row.status);
      return {
        key: channel,
        channel,
        displayName: text(row.display_name) || channel,
        status,
        enabled: status !== "paused",
        lastSyncAt: text(row.last_sync_at) || null,
        lastError: text(row.last_error) || null,
        runs: {
          total: count(run.total),
          failed: count(run.failed),
          lastAt: text(run.last_at) || null,
          lastDurationMs: null,
        },
        events: {
          received: count(event.received),
          processed: count(event.processed),
          ignored: count(event.ignored),
          failed: count(event.failed),
        },
        proposals: {
          pendingTriage: count(proposal.pending_triage),
          suggested: count(proposal.suggested),
          applied: count(proposal.applied),
          rejected: count(proposal.rejected),
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
  const key = cleanText(agentKey, 60);
  if (!isAgentChannel(key)) return false;
  const row = await d1.prepare("SELECT status FROM fdp_integrations WHERE workspace_id = ? AND channel = ?")
    .bind(workspaceId, key).first<{ status: string }>();
  return Boolean(row) && text(row?.status) !== "paused";
}

/** Política de automação do workspace, com o padrão conservador (§84). */
export async function readAgentAutomationPolicy(d1: Database, workspaceId: string) {
  const row = await d1.prepare("SELECT agent_automation FROM fdp_workspace_settings WHERE workspace_id = ?")
    .bind(workspaceId).first<{ agent_automation: string }>();
  const value = text(row?.agent_automation);
  return value === "off" || value === "trusted" ? value : "suggest_only" as const;
}
