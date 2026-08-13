import { createServer } from "node:http";
import { getAttachmentsBucket, getD1, getScopedD1 } from "../../db/index.ts";
import { log } from "../../lib/observability.ts";
import { processNextSankhyaJob } from "../../lib/sankhya/worker.ts";
import { PlaywrightSankhyaSession } from "./playwright-session.ts";

const pollMs = Math.min(60_000, Math.max(1_000, Number(process.env.FDP_SANKHYA_WORKER_POLL_MS) || 5_000));
const concurrency = Math.min(10, Math.max(1, Number(process.env.FDP_SANKHYA_WORKER_CONCURRENCY) || 3));
const port = Math.max(1, Number(process.env.PORT) || 8080);
let stopping = false;
let sweeping = false;
let ready = false;
let lastSweepAt = "";
let lastError = "";

function assertWorkerConfiguration() {
  const missing: string[] = [];
  if (!String(process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL ?? "").startsWith("postgres")) {
    missing.push("DATABASE_URL");
  }
  if (!String(process.env.FDP_INTEGRATION_VAULT_KEYS ?? process.env.FDP_INTEGRATION_VAULT_KEY ?? "").trim()) {
    missing.push("FDP_INTEGRATION_VAULT_KEYS");
  }
  if (!String(process.env.FDP_PII_HASH_SECRET ?? process.env.FDP_AUTH_SECRET ?? "").trim()) {
    missing.push("FDP_PII_HASH_SECRET");
  }
  if (missing.length) throw new Error(`Configuração obrigatória ausente: ${missing.join(", ")}`);
}

async function cleanupDiagnostics(workspaceId: string) {
  const d1 = getScopedD1({ workspaceId, userId: null });
  const expired = await d1.prepare("SELECT id, object_key FROM fdp_integration_diagnostics WHERE workspace_id = ? AND expires_at <= CURRENT_TIMESTAMP LIMIT 50")
    .bind(workspaceId).all<{ id: string; object_key: string }>();
  if (!expired.results.length) return;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const bucket = getAttachmentsBucket();
    for (const item of expired.results) await bucket.delete(item.object_key).catch(() => undefined);
  }
  for (const item of expired.results) await d1.prepare("DELETE FROM fdp_integration_diagnostics WHERE workspace_id = ? AND id = ?").bind(workspaceId, item.id).run();
}

async function drainWorkspace(workspaceId: string) {
  const d1 = getScopedD1({ workspaceId, userId: null });
  let handled = 0;
  while (!stopping && handled < 10) {
    const result = await processNextSankhyaJob(d1, workspaceId, async () => PlaywrightSankhyaSession.create());
    if (!result) break;
    handled += 1;
  }
  await cleanupDiagnostics(workspaceId).catch(() => undefined);
  return handled;
}

async function sweep() {
  if (sweeping || stopping) return;
  sweeping = true;
  try {
    const workspaces = await getD1().prepare("SELECT id FROM fdp_workspaces WHERE status = 'active' ORDER BY created_at").all<{ id: string }>();
    for (let index = 0; index < workspaces.results.length; index += concurrency) {
      const slice = workspaces.results.slice(index, index + concurrency);
      await Promise.all(slice.map((workspace) => drainWorkspace(workspace.id)));
    }
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

assertWorkerConfiguration();
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
