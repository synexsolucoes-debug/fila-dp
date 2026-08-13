import { getAttachmentsBucket, getD1, getScopedD1 } from "../../db/index.ts";
import { processNextSankhyaJob } from "../../lib/sankhya/worker.ts";
import { PlaywrightSankhyaSession } from "./playwright-session.ts";

type SweepOptions = {
  concurrency?: number;
  maxJobsPerWorkspace?: number;
  shouldStop?: () => boolean;
};

type WorkspaceSweep = {
  handled: number;
  nextAvailableAt: string | null;
};

export type SankhyaSweepSummary = {
  workspaces: number;
  handled: number;
  nextAvailableAt: string | null;
};

export function assertSankhyaWorkerConfiguration() {
  const missing: string[] = [];
  if (!String(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || "").startsWith("postgres")) {
    missing.push("DATABASE_URL");
  }
  if (!String(process.env.FDP_INTEGRATION_VAULT_KEYS || process.env.FDP_INTEGRATION_VAULT_KEY || "").trim()) {
    missing.push("FDP_INTEGRATION_VAULT_KEYS");
  }
  if (!String(process.env.FDP_PII_HASH_SECRET || process.env.FDP_AUTH_SECRET || "").trim()) {
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
  for (const item of expired.results) {
    await d1.prepare("DELETE FROM fdp_integration_diagnostics WHERE workspace_id = ? AND id = ?").bind(workspaceId, item.id).run();
  }
}

async function drainWorkspace(workspaceId: string, maxJobs: number, shouldStop: () => boolean): Promise<WorkspaceSweep> {
  const d1 = getScopedD1({ workspaceId, userId: null });
  let handled = 0;
  while (!shouldStop() && handled < maxJobs) {
    const result = await processNextSankhyaJob(d1, workspaceId, async () => PlaywrightSankhyaSession.create());
    if (!result) break;
    handled += 1;
  }
  await cleanupDiagnostics(workspaceId).catch(() => undefined);
  const pending = await d1.prepare(`SELECT MIN(job.available_at)::text AS available_at
    FROM fdp_integration_jobs job
    JOIN fdp_integrations integration ON integration.workspace_id = job.workspace_id AND integration.id = job.integration_id
    WHERE job.workspace_id = ? AND integration.channel = 'sankhya_browser' AND job.status = 'queued'`)
    .bind(workspaceId).first<{ available_at: string | null }>();
  return { handled, nextAvailableAt: pending?.available_at ?? null };
}

export async function sweepSankhyaQueue(options: SweepOptions = {}): Promise<SankhyaSweepSummary> {
  const concurrency = Math.min(10, Math.max(1, Number(options.concurrency) || 1));
  const maxJobs = Math.min(25, Math.max(1, Number(options.maxJobsPerWorkspace) || 10));
  const shouldStop = options.shouldStop ?? (() => false);
  const workspaces = await getD1().prepare("SELECT id FROM fdp_workspaces WHERE status = 'active' ORDER BY created_at")
    .all<{ id: string }>();
  let handled = 0;
  let nextAvailableAt: string | null = null;

  for (let index = 0; index < workspaces.results.length && !shouldStop(); index += concurrency) {
    const slice = workspaces.results.slice(index, index + concurrency);
    const results = await Promise.all(slice.map((workspace) => drainWorkspace(workspace.id, maxJobs, shouldStop)));
    for (const result of results) {
      handled += result.handled;
      if (result.nextAvailableAt && (!nextAvailableAt || new Date(result.nextAvailableAt) < new Date(nextAvailableAt))) {
        nextAvailableAt = result.nextAvailableAt;
      }
    }
  }
  return { workspaces: workspaces.results.length, handled, nextAvailableAt };
}
