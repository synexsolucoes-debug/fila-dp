import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dispatchSankhyaWorker } from "../lib/sankhya/actions-dispatch.ts";

const validEnvironment = {
  FDP_SANKHYA_ACTIONS_TOKEN: "github_pat_sensitive_value",
  FDP_SANKHYA_ACTIONS_REPOSITORY: "synexsolucoes-debug/fila-dp",
  FDP_SANKHYA_ACTIONS_WORKFLOW: "sankhya-worker.yml",
  FDP_SANKHYA_ACTIONS_REF: "main",
};

test("dispatcher chama somente o workflow fixo e não envia workspace", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const result = await dispatchSankhyaWorker({
    env: validEnvironment,
    fetcher: async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(result, { status: "dispatched" });
  assert.equal(capturedUrl, "https://api.github.com/repos/synexsolucoes-debug/fila-dp/actions/workflows/sankhya-worker.yml/dispatches");
  assert.deepEqual(JSON.parse(capturedBody), { ref: "main" });
  assert.doesNotMatch(capturedBody, /workspace|integration|github_pat/iu);
});

test("dispatcher falha fechado e nunca devolve o token", async () => {
  let called = false;
  const missing = await dispatchSankhyaWorker({ env: {}, fetcher: async () => { called = true; return new Response(); } });
  assert.deepEqual(missing, { status: "not_configured" });
  assert.equal(called, false);

  const invalid = await dispatchSankhyaWorker({ env: { ...validEnvironment, FDP_SANKHYA_ACTIONS_REPOSITORY: "https://example.com" }, fetcher: async () => { called = true; return new Response(); } });
  assert.deepEqual(invalid, { status: "misconfigured" });
  assert.equal(called, false);

  const rejected = await dispatchSankhyaWorker({ env: validEnvironment, fetcher: async () => new Response(null, { status: 403 }) });
  assert.deepEqual(rejected, { status: "failed", httpStatus: 403 });
  assert.doesNotMatch(JSON.stringify(rejected), /github_pat_sensitive_value/u);
});

test("workflow é one-shot, isolado e recebe segredos apenas pelo GitHub", async () => {
  const [workflow, runner, once, manualRoute, verifyRoute] = await Promise.all([
    readFile(new URL("../.github/workflows/sankhya-worker.yml", import.meta.url), "utf8"),
    readFile(new URL("../worker/sankhya/runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/sankhya/once.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/[id]/runs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/[id]/verify/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workflow, /workflow_dispatch/u);
  assert.match(workflow, /permissions:\s+contents: read/u);
  assert.match(workflow, /concurrency:[\s\S]+cancel-in-progress: false/u);
  assert.match(workflow, /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/u);
  assert.match(workflow, /npm run worker:sankhya:once/u);
  assert.match(workflow, /FDP_SANKHYA_CHROMIUM_SANDBOX: "true"/u);
  assert.doesNotMatch(workflow, /workspaceId|integrationId/u);
  assert.match(runner, /getScopedD1\(\{ workspaceId, userId: null \}\)/u);
  assert.match(runner, /integration\.channel = 'sankhya_browser'/u);
  assert.match(once, /executionBudgetMs/u);
  assert.match(once, /nextAvailableAt/u);
  assert.match(manualRoute, /wakeSankhyaWorker/u);
  assert.match(verifyRoute, /wakeSankhyaWorker/u);
});
