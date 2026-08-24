import { tangerinoAgentConfig } from "../../lib/tangerino/config.ts";
import { log } from "../../lib/observability.ts";
import { assertTangerinoWorkerConfiguration, sweepTangerinoQueue } from "./runner.ts";

const pollMs = Math.min(60_000, Math.max(1_000, Number(process.env.FDP_TANGERINO_WORKER_POLL_MS) || 5_000));
let stopping = false;

function stop() { stopping = true; }
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

async function waitForNextSweep() {
  const startedAt = Date.now();
  while (!stopping && Date.now() - startedAt < pollMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, pollMs)));
  }
}

async function main() {
  assertTangerinoWorkerConfiguration();
  const config = tangerinoAgentConfig();
  if (!config.profileRoot || !config.interactiveAuth || config.headless) {
    throw new Error("O worker Windows exige FDP_TANGERINO_PROFILE_ROOT e FDP_TANGERINO_INTERACTIVE_AUTH=true fora da Vercel.");
  }
  log("info", "tangerino.windows_worker_started", {}, { pollMs, concurrency: 1 });
  while (!stopping) {
    try {
      const summary = await sweepTangerinoQueue({ concurrency: 1, shouldStop: () => stopping });
      if (summary.handled > 0) {
        log("info", "tangerino.windows_worker_sweep_completed", {}, summary);
      }
    } catch (error) {
      log("error", "tangerino.windows_worker_sweep_failed", {}, {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    await waitForNextSweep();
  }
  log("info", "tangerino.windows_worker_stopped");
}

main().catch((error) => {
  log("error", "tangerino.windows_worker_failed", {}, {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});

