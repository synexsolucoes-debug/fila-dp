import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Fechar a competência na Operação DP deixava os fechamentos PJ abertos: são
 * tabelas separadas e a rota só mexia no ciclo. O DP decidiu que o fechamento
 * da competência fecha os PJs junto, sem exigir pagamento/conciliação.
 */
test("fechar a competência fecha os PJs, com permissão e auditoria", async () => {
  const route = await readFile(new URL("../app/api/operations/competences/[id]/transition/route.ts", import.meta.url), "utf8");
  const helper = await readFile(new URL("../lib/contractor-force-close.ts", import.meta.url), "utf8");
  assert.match(route, /forceCloseContractorClosings/u);
  assert.match(route, /contractors\.payments\.close/u, "quem não fecha PJ não fecha por aqui");
  assert.match(helper, /forced: true/u, "o fechamento à força precisa ficar rastreável");
  assert.match(helper, /contractorClosingSnapshot/u, "o snapshot do histórico continua sendo gravado");
  assert.match(helper, /status <> 'closed'/u);
});
