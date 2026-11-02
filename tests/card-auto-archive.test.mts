import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  archiveFinishedCards, DEFAULT_COMPLETED_ARCHIVE_DAYS, FINISHED_AT_SQL, normalizeCompletedArchiveDays,
} from "../lib/card-auto-archive.ts";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("os dias da regra ficam entre 0 (nunca) e 365, com 7 como padrão", () => {
  assert.equal(DEFAULT_COMPLETED_ARCHIVE_DAYS, 7);
  assert.equal(normalizeCompletedArchiveDays(15), 15);
  assert.equal(normalizeCompletedArchiveDays("30"), 30);
  assert.equal(normalizeCompletedArchiveDays(0), 0);
  assert.equal(normalizeCompletedArchiveDays(2.7), 2);
  assert.equal(normalizeCompletedArchiveDays(9999), 365);
  assert.equal(normalizeCompletedArchiveDays(-1), 7);
  assert.equal(normalizeCompletedArchiveDays("abc"), 7);
  assert.equal(normalizeCompletedArchiveDays(undefined), 7);
});

/** Banco falso que guarda o SQL e os parâmetros do UPDATE. */
function fakeDatabase(changes: number) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) {
      return { bind(...params: unknown[]) { return { async run() { calls.push({ sql, params }); return { meta: { changes } }; } }; } };
    },
  };
  return { d1: d1 as never, calls };
}

test("com 0 dias a regra não toca no banco", async () => {
  const { d1, calls } = fakeDatabase(5);
  assert.equal(await archiveFinishedCards(d1, "ws-1", 0), 0);
  assert.equal(calls.length, 0);
});

test("arquiva só as concluídas do grupo, nunca arquivadas, terminadas há mais de N dias", async () => {
  const { d1, calls } = fakeDatabase(3);
  assert.equal(await archiveFinishedCards(d1, "ws-1", 7), 3);
  const [{ sql, params }] = calls;
  assert.deepEqual(params, ["ws-1", 7]);
  assert.match(sql, /SET archived = 1, archived_at = CURRENT_TIMESTAMP/u);
  assert.match(sql, /workspace_id = \? AND archived = 0 AND archived_at IS NULL/u,
    "demanda restaurada do Arquivo não pode voltar para ele sozinha");
  assert.match(sql, /make_interval\(days => \?\)/u);
  assert.ok(sql.includes(`${FINISHED_AT_SQL} < CURRENT_TIMESTAMP`));
  // Nada é apagado: a regra só arquiva.
  assert.doesNotMatch(sql, /DELETE/iu);
});

test("concluída é quem tem closed_at, ou as antigas com sla_status concluído", () => {
  assert.match(FINISHED_AT_SQL, /closed_at/u);
  assert.match(FINISHED_AT_SQL, /sla_status = 'completed'/u);
  // Coluna do tipo Concluído com SLA "em andamento": a demanda nunca ganha closed_at.
  assert.match(FINISHED_AT_SQL, /kind = 'done'/u);
});

test("o quadro roda a regra antes de ler as demandas, e uma falha não impede de abrir", async () => {
  const db = await read("lib/fila-dp-db.ts");
  const regra = db.indexOf("await archiveFinishedCards(d1, workspace.id");
  // A leitura das demandas usa as consultas de lib/snapshot-queries.ts.
  const leitura = db.indexOf("d1.prepare(SNAPSHOT_ACTIVE_CARDS_SQL)");
  assert.ok(regra > 0 && regra < leitura, "a regra precisa rodar antes da leitura do quadro");
  assert.match(db.slice(regra - 400, regra + 300), /try \{[\s\S]*\} catch \(cause\)/u);
});

test("arquivar à mão grava a data, e mover de coluna libera a demanda para a regra de novo", async () => {
  const arquivar = await read("app/api/cards/[id]/route.ts");
  assert.match(arquivar, /SET archived = 1, archived_at = CURRENT_TIMESTAMP/u);
  const mover = await read("app/api/cards/[id]/move/route.ts");
  assert.match(mover, /archived_at = NULL/u);
});

test("a migration cria a configuração com 7 dias e a data de arquivamento", async () => {
  const sql = await read("drizzle/postgres/0120_completed_card_archive.sql");
  assert.match(sql, /"completed_archive_days" integer DEFAULT 7 NOT NULL/u);
  assert.match(sql, /"fdp_cards" ADD COLUMN IF NOT EXISTS "archived_at"/u);
});

test("a coluna de concluídas avisa para onde as demandas vão", async () => {
  const painel = await read("app/painel/WorkspaceApp.tsx");
  assert.match(await read("app/painel/features/board/KanbanBoard.tsx"), /Vão para o Arquivo após/u);
  assert.match(painel, /resource: "card-archive"/u);
});
