import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A demanda nova não perde o que foi digitado.
 *
 * Fechar a gaveta por engano (Esc, clique fora, troca de tela) apagava título,
 * descrição e próximo passo. O rascunho fica na sessão do navegador, por grupo
 * e quadro, volta ao reabrir com a opção de descartar e é apagado quando a
 * demanda é criada.
 */
const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");

test("o rascunho é guardado por grupo e quadro, só com conteúdo", () => {
  assert.match(app, /vinculato:rascunho-demanda:\$\{snapshot\.workspace\.id\}:\$\{snapshot\.board\.id\}/u);
  assert.match(app, /if \(!cardModalOpen \|\| selectedCardId \|\| !draftKey\) return;/u, "só a demanda nova, nunca a edição");
  assert.match(app, /window\.sessionStorage\.setItem\(draftKey, JSON\.stringify\(cardForm\)\)/u);
});

test("reabrir recupera, a tela avisa e a criação apaga", () => {
  assert.match(app, /const draft = readDraft\(\);\s*setDraftRestored\(Boolean\(draft\)\);/u);
  assert.match(app, /Descartar rascunho/u);
  assert.equal((app.match(/clearDraft\(\);/gu) ?? []).length >= 2, true, "os dois caminhos de criação apagam o rascunho");
});

test("na demanda nova, o próximo passo vem depois da descrição", () => {
  const descricao = app.indexOf('placeholder="Contexto e orientações para execução"');
  const novo = app.indexOf("{!selectedCard && <label className=\"full\">Próximo passo");
  assert.ok(descricao > 0 && novo > descricao);
  assert.match(app, /\{selectedCard && <section className="demand-next-step full">/u);
});

test("erro inesperado mostra o número do chamado na própria frase", async () => {
  const errors = await readFile(new URL("../lib/api-errors.ts", import.meta.url), "utf8");
  assert.match(errors, /informe ao suporte o chamado \$\{requestId\.slice\(0, 8\)\}/u);
});
