import { log, type LogContext } from "../observability.ts";

/**
 * Acorda o worker do agente Tangerino.
 *
 * O Playwright não roda dentro da requisição da Vercel (§33, §36): a requisição
 * enfileira, responde `202` e dispara um runner efêmero no GitHub Actions, que
 * drena a fila e morre.
 *
 * O payload é `{ "ref": "main" }` e nada mais. `workspaceId`, colaborador,
 * integração e credencial jamais saem do banco para o GitHub — o runner descobre
 * o que fazer com consultas escopadas por tenant, do outro lado. Mandar o
 * contexto no disparo seria vazar quem está sendo consultado para um sistema que
 * não precisa saber disso e guarda log de webhook por padrão.
 */
export type TangerinoWorkerDispatch = {
  status: "dispatched" | "persistent" | "not_configured" | "misconfigured" | "failed";
  httpStatus?: number;
};

type DispatchOptions = {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const workflowPattern = /^[A-Za-z0-9_.-]+\.ya?ml$/u;
const refPattern = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,120}$/u;

export async function dispatchTangerinoWorker(options: DispatchOptions = {}): Promise<TangerinoWorkerDispatch> {
  const env = options.env ?? process.env;
  const workerMode = String(env.FDP_TANGERINO_WORKER_MODE ?? "actions").trim().toLowerCase();
  if (workerMode === "persistent") return { status: "persistent" };

  const token = String(env.FDP_TANGERINO_ACTIONS_TOKEN ?? env.FDP_SANKHYA_ACTIONS_TOKEN ?? "").trim();
  if (!token) return { status: "not_configured" };

  const repository = String(env.FDP_TANGERINO_ACTIONS_REPOSITORY ?? env.FDP_SANKHYA_ACTIONS_REPOSITORY ?? "synexsolucoes-debug/fila-dp").trim();
  const workflow = String(env.FDP_TANGERINO_ACTIONS_WORKFLOW ?? "tangerino-worker.yml").trim();
  const ref = String(env.FDP_TANGERINO_ACTIONS_REF ?? env.FDP_SANKHYA_ACTIONS_REF ?? "main").trim();
  /* Validar os três antes de montar a URL: repositório e workflow entram no
     caminho da chamada ao GitHub, e um valor com `../` ali viraria uma chamada a
     outro recurso da API com o token da plataforma anexado. */
  if (!repositoryPattern.test(repository) || !workflowPattern.test(workflow) || !refPattern.test(ref)) {
    return { status: "misconfigured" };
  }

  try {
    const response = await (options.fetcher ?? fetch)(
      `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "vinculato-tangerino-dispatcher",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref }),
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(1_000, options.timeoutMs ?? 5_000))),
      },
    );
    return response.status === 204 ? { status: "dispatched" } : { status: "failed", httpStatus: response.status };
  } catch {
    return { status: "failed" };
  }
}

/**
 * Falha de disparo não derruba a consulta.
 *
 * A consulta já está na fila quando isto roda; se o disparo falhar, ela continua
 * lá e a próxima varredura a pega. Propagar o erro faria a tela dizer "não foi
 * possível consultar" sobre um trabalho que está enfileirado e vai acontecer.
 */
export async function wakeTangerinoWorker(context: LogContext = {}) {
  const result = await dispatchTangerinoWorker();
  const level = result.status === "failed" || result.status === "misconfigured" ? "warn" : "info";
  log(level, `tangerino.actions_dispatch_${result.status}`, context, {
    dispatchStatus: result.status,
    httpStatus: result.httpStatus,
  });
  return result;
}

