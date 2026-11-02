import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { POSITION_STEP, positionBetween } from "../lib/card-position.ts";
import { STALE_AFTER_DAYS, applyMoveOptimistically, staleDays } from "../app/painel/features/board/board.model.ts";
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
