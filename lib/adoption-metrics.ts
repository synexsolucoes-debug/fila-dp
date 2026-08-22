/**
 * Telemetria de adoção da consolidação (§77) — e a ativação de uma tabela que
 * estava morta (§50).
 *
 * A pergunta que isto responde é a única que decide se este trabalho valeu:
 * **a nova arquitetura está sendo usada?** Demanda continua nascendo solta ou
 * passou a nascer de processo? O Teams virou entrada operacional ou os eventos
 * chegam e param? O motor está recusando muito? Sem número, a resposta vira
 * opinião — e a próxima decisão de produto é tomada no escuro.
 *
 * Onde os números moram: `fdp_workspace_usage_counters`, que já existia com a
 * forma exata do necessário (workspace, métrica, período, quantidade) e não era
 * lida nem escrita por ninguém. Criar uma tabela nova ao lado dela seria repetir
 * o padrão que este trabalho está corrigindo.
 *
 * ## Sem PII, por construção
 *
 * A granularidade é (grupo, métrica, mês). Não há identificador de pessoa, de
 * colaborador ou de demanda — nem como coluna, nem como chave. Não é uma
 * promessa: é o formato da tabela.
 *
 * ## Falha de telemetria não derruba operação
 *
 * `recordAdoption` nunca lança. Uma métrica perdida é um número menos no
 * relatório; uma exceção aqui derrubaria a criação de uma demanda por causa de
 * um contador. A ordem de importância é essa e não a inversa.
 */
import type { getD1 } from "../db";

import { log } from "./observability.ts";

type Database = ReturnType<typeof getD1>;

export const adoptionMetrics = [
  "demands_from_process",
  "process_steps_advanced",
  "process_instances_completed",
  "events_received",
  "events_deduplicated",
  "triage_opened",
  "agent_actions_automatic",
  "agent_actions_refused",
  "work_center_opened",
  "assistant_queries",
  "deep_links_opened",
] as const;
export type AdoptionMetric = typeof adoptionMetrics[number];

/** Competência no formato do resto do produto: `AAAA-MM`. */
export function currentPeriod(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

/**
 * Statement do incremento, para entrar no mesmo lote da mutação que o originou.
 *
 * `ON CONFLICT ... DO UPDATE` sobre `(workspace_id, metric, period)`: o índice
 * único já existia, e é ele que torna o incremento seguro sob concorrência —
 * duas demandas criadas no mesmo instante somam dois, não sobrescrevem uma à
 * outra.
 */
export function prepareAdoptionIncrement(
  d1: Database,
  workspaceId: string,
  metric: AdoptionMetric,
  delta = 1,
  period = currentPeriod(),
) {
  const amount = Math.max(1, Math.trunc(delta) || 1);
  return d1.prepare(`INSERT INTO fdp_workspace_usage_counters (id, workspace_id, metric, period, quantity, limit_snapshot)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT (workspace_id, metric, period)
    DO UPDATE SET quantity = fdp_workspace_usage_counters.quantity + EXCLUDED.quantity, measured_at = now()`)
    .bind(crypto.randomUUID(), workspaceId, metric, period, amount);
}

/** Incremento fora de lote, para quem só quer registrar uma leitura. */
export async function recordAdoption(
  d1: Database,
  workspaceId: string,
  metric: AdoptionMetric,
  delta = 1,
) {
  try {
    await prepareAdoptionIncrement(d1, workspaceId, metric, delta).run();
  } catch (error) {
    log("warn", "adoption.metric_failed", { workspaceId }, {
      metric,
      errorType: error instanceof Error ? error.name : "Unknown",
    });
  }
}

export type AdoptionSnapshot = {
  period: string;
  metrics: Record<string, number>;
};

/**
 * Leitura para a tela e para o relatório.
 *
 * Devolve os períodos pedidos com todas as métricas presentes, inclusive as
 * zeradas: um indicador ausente é lido como "não medimos", e zero é uma
 * informação diferente disso.
 */
export async function readAdoption(
  d1: Database,
  workspaceId: string,
  periods = 6,
): Promise<AdoptionSnapshot[]> {
  const limit = Math.max(1, Math.min(24, Math.trunc(periods) || 6));
  const rows = await d1.prepare(`SELECT period, metric, quantity
      FROM fdp_workspace_usage_counters
     WHERE workspace_id = ? AND metric = ANY(?)
     ORDER BY period DESC`)
    .bind(workspaceId, [...adoptionMetrics])
    .all<{ period: string; metric: string; quantity: number }>();

  const byPeriod = new Map<string, Record<string, number>>();
  for (const row of rows.results) {
    const period = String(row.period);
    if (!byPeriod.has(period)) {
      byPeriod.set(period, Object.fromEntries(adoptionMetrics.map((metric) => [metric, 0])));
    }
    byPeriod.get(period)![String(row.metric)] = Number(row.quantity ?? 0);
  }
  return [...byPeriod.entries()]
    .sort(([left], [right]) => (left < right ? 1 : -1))
    .slice(0, limit)
    .map(([period, metrics]) => ({ period, metrics }));
}
