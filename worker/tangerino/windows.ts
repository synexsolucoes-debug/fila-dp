import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { getD1, getScopedD1 } from "../../db/index.ts";
import { tangerinoAgentConfig } from "../../lib/tangerino/config.ts";
import { log } from "../../lib/observability.ts";
import { prepareWorkerHeartbeat } from "../../lib/tangerino/worker-health.ts";
import { assertTangerinoWorkerConfiguration, sweepTangerinoQueue } from "./runner.ts";

const pollMs = Math.min(60_000, Math.max(1_000, Number(process.env.FDP_TANGERINO_WORKER_POLL_MS) || 5_000));
let stopping = false;

/**
 * O identificador do processo, estável entre reinícios da mesma máquina.
 *
 * Deriva do nome da máquina por HMAC, e não o usa em claro: hostname de estação
 * costuma carregar o nome de quem a usa ("NOTE-MARIA"), e isso apareceria no
 * painel de todo mundo do grupo. O que o painel precisa é distinguir um worker
 * do outro, não saber de quem é o computador.
 *
 * `FDP_TANGERINO_WORKER_ID` permite fixar um nome próprio quando o operador
 * quiser reconhecê-lo — aí a escolha é dele, e explícita.
 */
const workerId = (() => {
  const configured = String(process.env.FDP_TANGERINO_WORKER_ID ?? "").trim();
  if (/^[A-Za-z0-9._:-]{4,120}$/u.test(configured)) return configured;
  return `worker-${createHash("sha256").update(`vinculato:worker:${hostname()}`).digest("hex").slice(0, 16)}`;
})();

/** Fila e sinal de autenticação que o último ciclo enxergou, por workspace. */
async function recordHeartbeats(needsAuthentication: boolean, lastErrorCode: string) {
  const workspaces = await getD1().prepare(`SELECT workspace.id FROM fdp_workspaces workspace
    JOIN fdp_workspace_module_grants grant_row
      ON grant_row.workspace_id = workspace.id AND grant_row.module_key = 'tangerino_browser' AND grant_row.granted = 1
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > CURRENT_TIMESTAMP)
    WHERE workspace.status = 'active'`).all<{ id: string }>();

  for (const workspace of workspaces.results ?? []) {
    const workspaceId = String(workspace.id);
    const scoped = getScopedD1({ workspaceId, userId: null });
    const integration = await scoped.prepare(`SELECT id FROM fdp_integrations
      WHERE workspace_id = ? AND channel = 'tangerino_browser'`).bind(workspaceId).first<{ id: string }>();
    if (!integration) continue;

    const queue = await scoped.prepare(`SELECT
        (SELECT COUNT(*) FROM fdp_tangerino_admission_consultations
          WHERE workspace_id = ? AND state IN ('QUEUED', 'RUNNING')) AS consultations,
        (SELECT COUNT(*) FROM fdp_tangerino_attachment_authorizations
          WHERE workspace_id = ? AND state IN ('QUEUED', 'RUNNING')) AS attachments,
        (SELECT MAX(consulted_at)::text FROM fdp_tangerino_admission_consultations
          WHERE workspace_id = ? AND state = 'SUCCESS') AS last_consultation_at`)
      .bind(workspaceId, workspaceId, workspaceId)
      .first<{ consultations: unknown; attachments: unknown; last_consultation_at: string | null }>();

    await prepareWorkerHeartbeat(scoped, {
      workspaceId,
      integrationId: String(integration.id),
      workerId,
      workerVersion: String(process.env.npm_package_version ?? ""),
      pendingConsultations: Number(queue?.consultations ?? 0),
      pendingAttachments: Number(queue?.attachments ?? 0),
      lastConsultationAt: queue?.last_consultation_at ?? null,
      needsAuthentication,
      lastErrorCode,
    }).run();
  }
}

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
  log("info", "tangerino.windows_worker_started", {}, { pollMs, concurrency: 1, workerId });
  while (!stopping) {
    let needsAuthentication = false;
    let lastErrorCode = "";
    try {
      const summary = await sweepTangerinoQueue({ concurrency: 1, shouldStop: () => stopping });
      if (summary.handled > 0) {
        log("info", "tangerino.windows_worker_sweep_completed", {}, summary);
      }
    } catch (error) {
      /* Desafio de autenticação não é falha do worker: ele está de pé e parado
         esperando uma pessoa. O painel precisa dizer isso em vez de "agente com
         problema", que mandaria o operador procurar no lugar errado. */
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      needsAuthentication = code === "AUTHENTICATION_REQUIRED";
      lastErrorCode = code.slice(0, 120);
      log(needsAuthentication ? "warn" : "error", "tangerino.windows_worker_sweep_failed", {}, {
        errorName: error instanceof Error ? error.name : "UnknownError", errorCode: lastErrorCode,
      });
    }

    /* O batimento vai mesmo depois de falha — é justamente aí que o painel
       precisa dele: um worker que só se anuncia quando dá certo some da tela
       exatamente no momento em que alguém deveria olhar para ele. */
    await recordHeartbeats(needsAuthentication, lastErrorCode).catch((error) => {
      log("warn", "tangerino.windows_worker_heartbeat_failed", {}, {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });

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

