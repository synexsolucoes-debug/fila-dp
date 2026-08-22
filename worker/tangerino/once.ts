import { log } from "../../lib/observability.ts";
import { assertTangerinoWorkerConfiguration, sweepTangerinoQueue } from "./runner.ts";

/**
 * Uma passada na fila e encerra.
 *
 * É este o modo usado em produção: o backend dispara o workflow, o runner
 * efêmero drena o que existe e morre. Não há processo ocioso guardando sessão de
 * navegador entre execuções — que seria uma credencial de cliente viva num
 * container esperando trabalho aparecer.
 */
const budgetMs = Math.min(20 * 60_000, Math.max(60_000, Number(process.env.FDP_TANGERINO_WORKER_BUDGET_MS) || 10 * 60_000));

async function main() {
  assertTangerinoWorkerConfiguration();
  const startedAt = Date.now();
  const summary = await sweepTangerinoQueue({
    // Orçamento de tempo, e não contagem: uma consulta lenta não pode fazer o
    // runner estourar o limite do workflow e morrer no meio de uma leitura.
    shouldStop: () => Date.now() - startedAt >= budgetMs,
  });
  log("info", "tangerino.worker_completed", {}, {
    workspaces: summary.workspaces,
    handled: summary.handled,
    durationMs: Date.now() - startedAt,
  });
}

main().catch((error) => {
  // Só o nome da exceção: a mensagem de uma falha de navegador carrega URL com
  // querystring e, em alguns casos, o valor que estava no campo.
  log("error", "tangerino.worker_failed", {}, {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
