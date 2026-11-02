import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { log } from "../lib/observability.ts";

/**
 * Alguém é avisado quando a produção quebra.
 *
 * `/api/health` existia e ninguém o consultava: a varredura das integrações
 * ficou parada em produção enquanto o endpoint respondia. O agendamento das
 * integrações (a cada 30 min) passa a conferir a saúde e reprovar no crítico.
 */
test("o agendamento das integrações confere a saúde da produção", async () => {
  const workflow = await readFile(new URL("../.github/workflows/integrations-cron.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: Conferir a saúde da produção\n\s+if: always\(\)/u, "roda mesmo se a varredura falhar");
  assert.match(workflow, /https:\/\/vinculato\.vercel\.app\/api\/health/u);
  assert.match(workflow, /\[ "\$\{gravidade\}" = "critico" \] \|\| \[ "\$\{banco\}" != "ok" \] \|\| \[ "\$\{pendentes\}" != "0" \]/u);
  assert.match(workflow, /::warning title=Vinculato degradado::/u, "degradado avisa sem reprovar");
});

test("cada linha de log carrega a versão no ar", () => {
  const anterior = process.env.VERCEL_GIT_COMMIT_SHA;
  process.env.VERCEL_GIT_COMMIT_SHA = "abcdef0123456789";
  const original = console.log;
  console.log = () => {};
  try {
    const entry = log("info", "test.release");
    assert.equal(entry.release, "abcdef012345");
  } finally {
    console.log = original;
    if (anterior === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = anterior;
  }
});
