import { getD1, getScopedD1 } from "../../db/index.ts";
import { runNextConsultation } from "../../lib/tangerino/agent.ts";
import { tangerinoAgentConfig } from "../../lib/tangerino/config.ts";
import { processNextTangerinoHealthCheck } from "../../lib/tangerino/health-check.ts";
import { PlaywrightTangerinoSession } from "./playwright-session.ts";

export type TangerinoSweepSummary = {
  workspaces: number;
  handled: number;
};

export function assertTangerinoWorkerConfiguration() {
  const missing: string[] = [];
  if (!String(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || "").startsWith("postgres")) {
    missing.push("DATABASE_URL");
  }
  if (!String(process.env.FDP_TANGERINO_VAULT_KEYS || process.env.FDP_TANGERINO_VAULT_KEY || "").trim()) {
    missing.push("FDP_TANGERINO_VAULT_KEYS");
  }
  if (!tangerinoAgentConfig().enabled) missing.push("TANGERINO_BROWSER_AGENT_ENABLED");
  if (missing.length) throw new Error(`Configuração obrigatória ausente: ${missing.join(", ")}`);
}

async function drainWorkspace(workspaceId: string, maxJobs: number, shouldStop: () => boolean) {
  const d1 = getScopedD1({ workspaceId, userId: null });
  let handled = 0;
  while (!shouldStop() && handled < maxJobs) {
    /* O teste de conexão vem primeiro: ele é curto, desbloqueia o setup e não
       deve esperar atrás de uma varredura de dezenas de colaboradores. */
    const healthCheck = await processNextTangerinoHealthCheck(
      d1, workspaceId, async () => PlaywrightTangerinoSession.create({ workspaceId }),
    );
    const result = healthCheck ?? await runNextConsultation(
      d1, workspaceId, async () => PlaywrightTangerinoSession.create({ workspaceId }),
    );
    if (!result) break;
    handled += 1;
  }
  return handled;
}

/**
 * Varredura da fila de consultas.
 *
 * Um workspace por vez dentro do laço, e o paralelismo acontece **entre**
 * workspaces, até o limite configurado. Dois navegadores no mesmo cliente ao
 * mesmo tempo não entregam resposta mais rápido — a fila por colaborador já é
 * serializada pelo trinco — e multiplicam a chance de o Tangerino tratar a conta
 * como uso anômalo.
 */
export async function sweepTangerinoQueue(options: {
  concurrency?: number;
  maxJobsPerWorkspace?: number;
  shouldStop?: () => boolean;
} = {}): Promise<TangerinoSweepSummary> {
  assertTangerinoWorkerConfiguration();
  const config = tangerinoAgentConfig();
  const concurrency = Math.min(8, Math.max(1, Number(options.concurrency) || config.concurrency));
  const maxJobs = Math.min(25, Math.max(1, Number(options.maxJobsPerWorkspace) || 10));
  const shouldStop = options.shouldStop ?? (() => false);

  /* Só os workspaces com o módulo liberado. Varrer todos abriria conexão e
     consulta para grupos que nunca terão trabalho na fila — e num produto com
     muitos workspaces isso é a maior parte do tempo da varredura. */
  const workspaces = await getD1().prepare(`SELECT workspace.id FROM fdp_workspaces workspace
    JOIN fdp_workspace_module_grants grant_row
      ON grant_row.workspace_id = workspace.id AND grant_row.module_key = 'tangerino_browser' AND grant_row.granted = 1
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > CURRENT_TIMESTAMP)
    WHERE workspace.status = 'active' ORDER BY workspace.created_at`).all<{ id: string }>();

  let handled = 0;
  for (let index = 0; index < workspaces.results.length && !shouldStop(); index += concurrency) {
    const slice = workspaces.results.slice(index, index + concurrency);
    const results = await Promise.all(slice.map((workspace) => drainWorkspace(String(workspace.id), maxJobs, shouldStop)));
    for (const count of results) handled += count;
  }
  return { workspaces: workspaces.results.length, handled };
}

