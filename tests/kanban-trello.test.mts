import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { POSITION_STEP, positionBetween } from "../lib/card-position.ts";
import {
  STALE_AFTER_DAYS, activeFilterCount, applyMoveOptimistically, defaultDemandFilters, filterDemands, presetViews,
  readBoardFilters, staleDays, writeBoardFilters,
} from "../app/painel/features/board/board.model.ts";
import type { Card, WorkspaceSnapshot } from "../lib/fila-dp-types.ts";

/**
 * Quadro por etapa no desenho do Trello (docs/engenharia-reversa-trello.md).
 * O que se testa aqui é a regra; o desenho mora em KanbanBoard.tsx.
 */

test("a posição entre dois vizinhos é o meio-termo, e o fim soma um passo", () => {
  assert.equal(positionBetween(null, null), POSITION_STEP);
  assert.equal(positionBetween(1000, 2000), 1500);
  assert.equal(positionBetween(3000, null), 3000 + POSITION_STEP);
  assert.equal(positionBetween(null, 1000), 500);
});

test("sem folga entre os vizinhos, a posição pede renumeração em vez de empatar", () => {
  assert.equal(positionBetween(1000, 1000), null);
  assert.equal(positionBetween(1000, 1000 + 1e-7), null);
  assert.equal(positionBetween(null, 1e-7), null);
});

function demanda(id: string, listId: string, patch: Partial<Card> = {}): Card {
  return { id, listId, title: id, slaStatus: "safe", updatedAt: "2026-11-01T12:00:00Z", ...patch } as Card;
}

function quadro(): WorkspaceSnapshot {
  return {
    lists: [
      { id: "a", boardId: "b", name: "Novas", kind: "new", position: 1, slaBehavior: "running", cards: [demanda("1", "a"), demanda("2", "a"), demanda("3", "a")] },
      { id: "z", boardId: "b", name: "Feito", kind: "done", position: 2, slaBehavior: "completed", cards: [demanda("9", "z")] },
    ],
  } as unknown as WorkspaceSnapshot;
}

const ids = (snapshot: WorkspaceSnapshot, listId: string) =>
  snapshot.lists.find((list) => list.id === listId)!.cards.map((card) => card.id);

test("soltar entre dois cartões põe a demanda exatamente ali, já na tela", () => {
  const depois = applyMoveOptimistically(quadro(), "3", "a", { beforeCardId: "1", afterCardId: "2" });
  assert.deepEqual(ids(depois, "a"), ["1", "3", "2"]);
});

test("mover para outra coluna tira da origem e troca a coluna da demanda", () => {
  const depois = applyMoveOptimistically(quadro(), "2", "z", { afterCardId: "9" });
  assert.deepEqual(ids(depois, "a"), ["1", "3"]);
  assert.deepEqual(ids(depois, "z"), ["2", "9"]);
  assert.equal(depois.lists[1].cards[0].listId, "z");
});

test("sem vizinho a demanda vai para o fim; coluna ou demanda inexistente não muda nada", () => {
  assert.deepEqual(ids(applyMoveOptimistically(quadro(), "1", "z"), "z"), ["9", "1"]);
  const antes = quadro();
  assert.equal(applyMoveOptimistically(antes, "x", "z"), antes);
  assert.equal(applyMoveOptimistically(antes, "1", "nao-existe"), antes);
});

test("parada é diferente de atrasada: conta dias sem alteração, só para demanda aberta", () => {
  const agora = new Date("2026-11-10T12:00:00Z");
  assert.equal(staleDays({ updatedAt: "2026-11-09T12:00:00Z", slaStatus: "safe" }, agora), null);
  assert.equal(staleDays({ updatedAt: "2026-11-02T12:00:00Z", slaStatus: "safe" }, agora), 8);
  // Formato do banco, sem "T": lido como UTC.
  assert.equal(staleDays({ updatedAt: "2026-11-05 11:00:00", slaStatus: "warning" }, agora), STALE_AFTER_DAYS);
  assert.equal(staleDays({ updatedAt: "2026-10-01T12:00:00Z", slaStatus: "completed" }, agora), null);
  assert.equal(staleDays({ updatedAt: "2026-10-01T12:00:00Z", slaStatus: "paused" }, agora), null);
  assert.equal(staleDays({ updatedAt: "", slaStatus: "safe" }, agora), null);
});

test("reordenar na mesma coluna não conta como mover: sem evento, sem mexer no SLA", async () => {
  const rota = await readFile(new URL("../app/api/cards/[id]/move/route.ts", import.meta.url), "utf8");
  const mesmaColuna = rota.slice(rota.indexOf("if (card.list_id === toListId)"), rota.indexOf("return Response.json(await getWorkspaceSnapshot(auth.user));"));
  assert.match(mesmaColuna, /SET position = \?, updated_at = CURRENT_TIMESTAMP WHERE/u);
  assert.doesNotMatch(mesmaColuna, /sla_status|closed_at|recordActivity|runAutomations/u);
  // Os vizinhos vêm por id e a posição é lida do banco, nunca recebida como número.
  assert.match(rota, /beforeCardId: text\(body\.beforeCardId, 100\)/u);
  assert.doesNotMatch(rota, /body\.position/u);
});

test("o quadro por etapa só usa tokens do tema, sem cor fixa", async () => {
  const css = await readFile(new URL("../app/painel/features/board/kanban.module.css", import.meta.url), "utf8");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//gu, ""), /#[0-9a-f]{3,8}\b|rgba?\(/iu);
});

/* ── Filtros por etiqueta e por parada ────────────────────────────────────── */

const agora = new Date("2026-11-20T12:00:00Z");
const rotulada = (id: string, labels: string[], updatedAt: string, slaStatus: Card["slaStatus"] = "safe") =>
  ({ ...demanda(id, "a", { updatedAt, slaStatus }), labels: labels.map((label) => ({ id: label, name: label, color: "#000" })),
    assignees: [], assigneeName: "", customValues: {}, checklist: [], comments: [], attachments: [] }) as unknown as Card;

const lote = [
  rotulada("nova", ["urgente-cliente"], "2026-11-19T12:00:00Z"),
  rotulada("seis-dias", ["urgente-cliente", "documentos"], "2026-11-14T12:00:00Z"),
  rotulada("vinte-dias", [], "2026-10-31T12:00:00Z"),
  rotulada("concluida-velha", ["documentos"], "2026-09-01T12:00:00Z", "completed"),
];
const so = (filtros: Partial<typeof defaultDemandFilters>) =>
  filterDemands(lote, { ...defaultDemandFilters, ...filtros }, undefined, agora).map((card) => card.id);

test("filtro por etiqueta mostra só as demandas com aquela etiqueta", () => {
  assert.deepEqual(so({ label: "documentos" }), ["seis-dias", "concluida-velha"]);
  assert.deepEqual(so({ label: "urgente-cliente" }), ["nova", "seis-dias"]);
  assert.deepEqual(so({ label: "nao-existe" }), []);
});

test("filtro de parada usa a faixa mínima e ignora concluída", () => {
  assert.deepEqual(so({ stale: "5" }), ["seis-dias", "vinte-dias"]);
  assert.deepEqual(so({ stale: "14" }), ["vinte-dias"]);
  assert.deepEqual(so({ stale: "30" }), []);
});

test("valor de parada inventado no endereço não esconde o quadro inteiro", () => {
  assert.equal(so({ stale: "abc" }).length, lote.length);
  assert.equal(so({ stale: "-3" }).length, lote.length);
});

test("os dois filtros contam como ativos, vão para a URL e voltam dela", () => {
  const filtros = { ...defaultDemandFilters, label: "documentos", stale: "14" };
  assert.equal(activeFilterCount(filtros), 2);
  const url = writeBoardFilters(filtros);
  assert.equal(url.get("etiqueta"), "documentos");
  assert.equal(url.get("parada"), "14");
  const lido = readBoardFilters(url);
  assert.equal(lido.label, "documentos");
  assert.equal(lido.stale, "14");
  assert.equal(writeBoardFilters(defaultDemandFilters).toString(), "");
});

test("existe o atalho 'Paradas' ao lado de 'Atrasadas'", () => {
  const paradas = presetViews("").find((view) => view.id === "paradas");
  assert.deepEqual(paradas?.filters, { stale: "5" });
});

test("link com filtro abre o quadro filtrado: a consulta é guardada antes de a URL ser reescrita", async () => {
  /* O efeito que sincroniza o endereço rodava antes do quadro adiado ler a
     consulta e a apagava; todo link com `?etiqueta=`, `?parada=` ou `?modo=`
     abria o quadro inteiro. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /const \[initialBoardSearch\] = useState\(\(\) => \(typeof window === "undefined" \? "" : window\.location\.search\)\)/u);
  const efeito = app.slice(app.indexOf("const boardLocationApplied"), app.indexOf("[applyBoardFilters, initialBoardSearch]"));
  assert.match(efeito, /const busca = initialBoardSearch;/u);
  assert.doesNotMatch(efeito, /window\.location\.search;\n\s*if \(!busca\)/u);
});
