import { getD1, getScopedD1 } from "../../db/index.ts";
import { runNextConsultation } from "../../lib/tangerino/agent.ts";
import { tangerinoAgentConfig } from "../../lib/tangerino/config.ts";
import { processNextTangerinoHealthCheck } from "../../lib/tangerino/health-check.ts";
import { runNextAttachmentAuthorization } from "../../lib/tangerino/attachments-worker.ts";
import { discoverOpenAdmissions } from "../../lib/tangerino/discovery.ts";
import { safeTangerinoError } from "../../lib/tangerino/errors.ts";
import { log } from "../../lib/observability.ts";
import { assertWorkerConfiguration, type WorkerConfigurationOptions } from "../../lib/tangerino/worker-configuration.ts";
import { PlaywrightTangerinoSession } from "./playwright-session.ts";

export type TangerinoSweepSummary = {
  workspaces: number;
  handled: number;
};

export function assertTangerinoWorkerConfiguration(options: WorkerConfigurationOptions = {}) {
  assertWorkerConfiguration(process.env, options);
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
    const attachmentTransfer = healthCheck ? null : await runNextAttachmentAuthorization(
      d1, workspaceId, async () => PlaywrightTangerinoSession.create({ workspaceId }),
    );
    const result = healthCheck ?? attachmentTransfer ?? await runNextConsultation(
      d1, workspaceId, async () => PlaywrightTangerinoSession.create({ workspaceId }),
    );
    if (!result) break;
    handled += 1;
  }

  /* A descoberta vem depois da fila, e não antes: o que uma pessoa pediu tem
     precedência sobre a varredura automática. E só quando a fila secou — abrir
     o navegador para listar admissões enquanto há consulta esperando atrasaria
     justamente quem está na frente de uma tela aguardando resposta. */
  if (!shouldStop() && handled === 0) {
    try {
      const discovery = await discoverOpenAdmissions(
        d1, workspaceId, async () => PlaywrightTangerinoSession.create({ workspaceId }),
      );
      if (discovery && discovery.demandsCreated > 0) handled += discovery.demandsCreated;
    } catch (error) {
      /* Uma descoberta que falha não pode derrubar a varredura: a fila pedida
         por pessoas já foi drenada acima, e perder isso por causa de uma
         listagem seria trocar o certo pelo incerto. */
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "AUTHENTICATION_REQUIRED") throw error;
      /* A mensagem, não só o código — é ela que diz QUAL etapa e QUAL elemento
       * faltaram (`uiChanged` embute os dois: "a etapa \"X\" não encontrou
       * \"Y\""). "TANGERINO_UI_CHANGED" sozinho é o mesmo código para mais de
       * dez pontos de falha diferentes no cliente de navegador — sem a
       * mensagem, cada leitura deste log é uma reconstrução às cegas de qual
       * deles disparou. `safeTangerinoError` já expurga segredo de sessão
       * antes de qualquer coisa chegar aqui.
       */
      const safe = safeTangerinoError(error);
      log("warn", "tangerino.discovery_failed", { workspaceId }, {
        errorName: error instanceof Error ? error.name : "UnknownError", errorCode: code.slice(0, 120),
        errorMessage: safe.message,
      });
    }
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

