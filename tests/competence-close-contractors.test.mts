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

/**
 * Reabrir a competência deixava os PJs fechados à força: a tela mostrava a
 * competência aberta e todo lançamento era recusado como fechamento concluído.
 */
test("reabrir a competência devolve os PJs que ela fechou à força", async () => {
  const route = await readFile(new URL("../app/api/operations/competences/[id]/transition/route.ts", import.meta.url), "utf8");
  const helper = await readFile(new URL("../lib/contractor-force-close.ts", import.meta.url), "utf8");
  assert.match(route, /reopenForcedContractorClosings/u);
  assert.match(helper, /'via' = 'competence_close'/u, "só volta o que a competência fechou");
  assert.match(helper, /previous_status === "paid" \? "paid" : "reopened"/u, "o que estava pago continua pago");
});

test("o lançamento PJ avisa antes quem já tem o pagamento fechado", async () => {
  const dialog = await readFile(new URL("../app/painel/features/payments/ContractorEntryDialog.tsx", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8");
  assert.match(dialog, /lockedProviderIds/u);
  assert.match(view, /lockedProviderIds=\{lockedProviderIds\}/u);
  assert.match(view, / · fechada/u, "o seletor diferencia competência fechada");
});
