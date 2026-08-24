import { log, type LogContext } from "../observability.ts";

export type SankhyaWorkerDispatch = {
  status: "dispatched" | "not_configured" | "misconfigured" | "failed";
  httpStatus?: number;
};

type DispatchEnvironment = Record<string, string | undefined>;
type DispatchOptions = {
  env?: DispatchEnvironment;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const workflowPattern = /^[A-Za-z0-9_.-]+\.ya?ml$/u;
const refPattern = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,120}$/u;

export async function dispatchSankhyaWorker(options: DispatchOptions = {}): Promise<SankhyaWorkerDispatch> {
  const env = options.env ?? process.env;
  const token = String(env.FDP_SANKHYA_ACTIONS_TOKEN ?? "").trim();
  if (!token) return { status: "not_configured" };

  const repository = String(env.FDP_SANKHYA_ACTIONS_REPOSITORY ?? "synexsolucoes-debug/fila-dp").trim();
  const workflow = String(env.FDP_SANKHYA_ACTIONS_WORKFLOW ?? "sankhya-worker.yml").trim();
  const ref = String(env.FDP_SANKHYA_ACTIONS_REF ?? "main").trim();
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
          "User-Agent": "vinculato-sankhya-dispatcher",
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

export async function wakeSankhyaWorker(context: LogContext = {}) {
  const result = await dispatchSankhyaWorker();
  const level = result.status === "failed" || result.status === "misconfigured" ? "warn" : "info";
  log(level, `sankhya.actions_dispatch_${result.status}`, context, {
    dispatchStatus: result.status,
    httpStatus: result.httpStatus,
  });
  return result;
}
