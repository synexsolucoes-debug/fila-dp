import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { closingBlockerMessage, describeClosingBlockers, type ClosingBlocker } from "../lib/operations.ts";

/**
 * §22 pede que fique muito claro o que está impedindo o fechamento. O produto
 * respondia "A competência possui bloqueadores, aprovações ou obrigações
 * pendentes" — o usuário sabia que algo barrou, mas não o quê, onde, nem
 * quantos, e tinha de caçar item por item em cinco telas diferentes.
 *
 * A causa não era descuido: os portões ficam dentro do `WHERE` do UPDATE, de
 * propósito, para não abrir janela entre conferir e aplicar. O preço era a
 * resposta não saber o motivo. O diagnóstico roda depois do bloqueio, só para
 * explicá-lo — não é pré-checagem e não autoriza nada.
 */

/** Consulta falsa: devolve a linha que o PostgreSQL devolveria. */
const fakeDb = (row: Record<string, unknown> | null) => ({
  prepare: () => ({ bind: () => ({ first: async () => row as never }) }),
});

const linha = (over: Record<string, unknown> = {}) => ({
  pending_total: 0, pending_examples: null,
  movements_total: 0, movements_examples: null,
  items_total: 0, items_examples: null,
  obligations_total: 0, obligations_examples: null,
  auxiliary_total: 0, auxiliary_examples: null,
  ...over,
});

test("o fechamento lista as cinco categorias de bloqueio", async () => {
  const blockers = await describeClosingBlockers(fakeDb(linha({
    pending_total: 2, pending_examples: ["Conferir ponto", "Vale-transporte"],
    movements_total: 1, movements_examples: ["Rescisão de João"],
    items_total: 1, items_examples: ["Conferência pós-folha"],
    obligations_total: 1, obligations_examples: ["DCTFWeb"],
    auxiliary_total: 1, auxiliary_examples: ["Benefícios de agosto"],
  })) as never, "ws", "cy", "closed");

  assert.deepEqual(blockers.map((b) => b.kind), ["pending", "movements", "items", "obligations", "auxiliary"]);
  assert.equal(blockers[0].total, 2);
});

test("sair de pré-fechamento não cobra o que ainda não barra", async () => {
  // Ir para `processing` só depende de pendência e movimentação. Listar
  // obrigação e execução auxiliar mandaria resolver algo que não está
  // impedindo aquela transição.
  const blockers = await describeClosingBlockers(fakeDb(linha({
    pending_total: 1, pending_examples: ["Conferir ponto"],
    obligations_total: 3, auxiliary_total: 2, items_total: 4,
  })) as never, "ws", "cy", "processing");

  assert.deepEqual(blockers.map((b) => b.kind), ["pending"]);
});

test("a mensagem nomeia quantidade e exemplos, em vez de dizer que algo barrou", () => {
  const message = closingBlockerMessage([
    { kind: "pending", label: "pendências bloqueantes em aberto", total: 2, examples: ["Conferir ponto", "Vale-transporte"] },
    { kind: "obligations", label: "obrigação não concluída", total: 1, examples: ["DCTFWeb"] },
  ]);

  assert.match(message, /2 pendências bloqueantes em aberto/u);
  assert.match(message, /Conferir ponto; Vale-transporte/u);
  assert.match(message, /1 obrigação não concluída/u);
  assert.match(message, /Resolva esses itens/u);
  // A frase antiga não pode voltar.
  assert.doesNotMatch(message, /possui bloqueadores, aprovações ou obrigações pendentes/u);
});

test("singular e plural acompanham a contagem", async () => {
  const um = await describeClosingBlockers(fakeDb(linha({ pending_total: 1, pending_examples: ["Só um"] })) as never, "ws", "cy", "closed");
  assert.equal(um[0].label, "pendência bloqueante em aberto");

  const varios = await describeClosingBlockers(fakeDb(linha({ pending_total: 4 })) as never, "ws", "cy", "closed");
  assert.equal(varios[0].label, "pendências bloqueantes em aberto");
});

test("com mais itens que exemplos, a mensagem indica que há mais", () => {
  const message = closingBlockerMessage([
    { kind: "items", label: "etapas do fechamento não concluídas", total: 9, examples: ["A", "B", "C"] },
  ]);
  assert.match(message, /9 etapas/u);
  assert.match(message, /A; B; C…/u, "o reticências avisa que a lista foi cortada");
});

test("bloqueio sem diagnóstico admite a corrida, em vez de listar zero motivos", () => {
  // Outra pessoa resolveu o bloqueador entre a tentativa e a explicação.
  // Inventar um motivo, ou dizer "nenhum", seria pior que admitir a corrida.
  const message = closingBlockerMessage([]);
  assert.match(message, /mudou enquanto a transição era aplicada/u);
  assert.match(message, /Recarregue/u);
});

test("a rota devolve os bloqueadores estruturados junto da mensagem", async () => {
  const route = await readFile(new URL("../app/api/operations/competences/[id]/transition/route.ts", import.meta.url), "utf8");
  assert.match(route, /describeClosingBlockers\(d1, workspace\.id, id, target\)/u);
  assert.match(route, /closingBlockerMessage\(blockers\)/u);
  // A tela precisa do detalhe estruturado para poder levar ao item de origem.
  assert.match(route, /\{ blockers \}/u);
  // Os portões continuam no UPDATE: o diagnóstico não pode virar pré-checagem.
  assert.match(route, /NOT EXISTS \(SELECT 1 FROM fdp_operational_pending_items/u);
});

test("o diagnóstico não decide nada: ele só explica", async () => {
  const source = await readFile(new URL("../lib/operations.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function describeClosingBlockers"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  // Só leitura. Uma escrita aqui transformaria explicação em efeito colateral.
  for (const escrita of ["UPDATE ", "INSERT ", "DELETE "]) {
    assert.ok(!body.includes(escrita), `o diagnóstico não pode conter ${escrita.trim()}`);
  }
});

const _tipo: ClosingBlocker = { kind: "pending", label: "x", total: 1, examples: [] };
void _tipo;
