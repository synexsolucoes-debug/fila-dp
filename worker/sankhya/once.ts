import { log } from "../../lib/observability.ts";
import { assertSankhyaWorkerConfiguration, sweepSankhyaQueue } from "./runner.ts";

const concurrency = Math.min(10, Math.max(1, Number(process.env.FDP_SANKHYA_WORKER_CONCURRENCY) || 1));
const maxJobsPerWorkspace = Math.min(25, Math.max(1, Number(process.env.FDP_SANKHYA_WORKER_MAX_JOBS) || 10));
const retryWaitLimitMs = Math.min(180_000, Math.max(30_000, Number(process.env.FDP_SANKHYA_WORKER_RETRY_WAIT_MS) || 90_000));
const executionBudgetMs = Math.min(40 * 60_000, Math.max(5 * 60_000, Number(process.env.FDP_SANKHYA_WORKER_BUDGET_MS) || 35 * 60_000));

async function main() {
  assertSankhyaWorkerConfiguration();
  const startedAt = Date.now();
  let handled = 0;
  let sweeps = 0;

  while (Date.now() - startedAt < executionBudgetMs) {
    const summary = await sweepSankhyaQueue({ concurrency, maxJobsPerWorkspace });
    sweeps += 1;
    handled += summary.handled;
    if (!summary.nextAvailableAt) break;

    const waitMs = Math.max(0, new Date(summary.nextAvailableAt).getTime() - Date.now()) + 250;
    if (waitMs > retryWaitLimitMs || Date.now() - startedAt + waitMs >= executionBudgetMs) break;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  log("info", "sankhya.actions_worker_completed", {}, {
    handled,
    sweeps,
    durationMs: Date.now() - startedAt,
  });
}

main().catch((error) => {
  log("error", "sankhya.actions_worker_failed", {}, {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
