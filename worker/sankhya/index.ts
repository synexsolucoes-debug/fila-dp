import { createServer } from "node:http";
import { log } from "../../lib/observability.ts";
import { assertSankhyaWorkerConfiguration, sweepSankhyaQueue } from "./runner.ts";

const pollMs = Math.min(60_000, Math.max(1_000, Number(process.env.FDP_SANKHYA_WORKER_POLL_MS) || 5_000));
const concurrency = Math.min(10, Math.max(1, Number(process.env.FDP_SANKHYA_WORKER_CONCURRENCY) || 3));
const port = Math.max(1, Number(process.env.PORT) || 8080);
let stopping = false;
let sweeping = false;
let ready = false;
let lastSweepAt = "";
let lastError = "";

async function sweep() {
  if (sweeping || stopping) return;
  sweeping = true;
  try {
    await sweepSankhyaQueue({ concurrency, shouldStop: () => stopping });
    lastSweepAt = new Date().toISOString();
    lastError = "";
    ready = true;
  } catch (error) {
    ready = false;
    lastError = error instanceof Error ? error.name : "UnknownError";
    log("error", "sankhya.worker_sweep_failed", {}, { errorName: lastError });
  } finally { sweeping = false; }
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    const healthy = ready && !lastError;
    response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ service: "vinculato-sankhya-worker", status: healthy ? "ok" : "starting", sweeping, lastSweepAt }));
    return;
  }
  response.writeHead(404).end();
});

assertSankhyaWorkerConfiguration();
server.listen(port, () => log("info", "sankhya.worker_started", {}, { port, concurrency, pollMs }));
const timer = setInterval(() => void sweep(), pollMs);
timer.unref();
void sweep();

async function shutdown() {
  stopping = true;
  clearInterval(timer);
  server.close();
  const deadline = Date.now() + 25_000;
  while (sweeping && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
