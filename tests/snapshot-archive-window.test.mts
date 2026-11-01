import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SNAPSHOT_ACTIVE_CARDS_SQL, SNAPSHOT_ARCHIVE_LIMIT, SNAPSHOT_ARCHIVED_TOTAL_SQL, SNAPSHOT_RECENT_ARCHIVED_SQL,
} from "../lib/snapshot-queries.ts";

/**
 * O snapshot do painel não cresce com o arquivo.
 *
 * O painel recarrega o snapshot sempre que alguém do grupo mexe em algo. Antes,
 * a consulta de demandas era `WHERE board_id = ?` — todas, arquivadas inclusive
 * —, e o custo de cada recarga crescia com anos de histórico. Agora vêm as
 * ativas, as arquivadas mais recentes e o total; a busca alcança as demais.
 */
test("ativas e arquivadas são consultas separadas, e a de arquivadas tem teto", () => {
  assert.match(SNAPSHOT_ACTIVE_CARDS_SQL, /archived = 0/u);
  assert.match(SNAPSHOT_RECENT_ARCHIVED_SQL, /archived = 1/u);
  assert.match(SNAPSHOT_RECENT_ARCHIVED_SQL, /LIMIT \?/u);
  assert.match(SNAPSHOT_RECENT_ARCHIVED_SQL, /ORDER BY archived_at DESC/u);
  assert.ok(SNAPSHOT_ARCHIVE_LIMIT > 0 && SNAPSHOT_ARCHIVE_LIMIT <= 200);
});

test("arquivadas e total respeitam as empresas que a pessoa enxerga", () => {
  for (const sql of [SNAPSHOT_RECENT_ARCHIVED_SQL, SNAPSHOT_ARCHIVED_TOTAL_SQL]) {
    assert.match(sql, /\(\?::boolean OR company_id = ANY\(\?::text\[\]\)\)/u,
      "sem o recorte, o total contaria demandas de empresa que a pessoa não vê");
  }
});

test("o snapshot usa as consultas compartilhadas e informa o total de arquivadas", async () => {
  const db = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.match(db, /d1\.prepare\(SNAPSHOT_ACTIVE_CARDS_SQL\)/u);
  assert.match(db, /d1\.prepare\(SNAPSHOT_RECENT_ARCHIVED_SQL\)/u);
  assert.match(db, /d1\.prepare\(SNAPSHOT_ARCHIVED_TOTAL_SQL\)/u);
  assert.doesNotMatch(db, /SELECT \* FROM fdp_cards WHERE board_id = \? ORDER BY archived/u,
    "a consulta antiga trazia o arquivo inteiro");
  assert.match(db, /archived: \{ loaded: archivedCardRows\.length, total:/u);
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /Ver arquivo \(\{archivedTotal\}\)/u, "a contagem mostra o total, não só as carregadas");
  assert.match(app, /title: "Restaurar demanda arquivada\?"/u, "arquivada fora da janela é alcançável pela busca");
});

test("o ensaio de volume mede o SQL do snapshot importado, não copiado", async () => {
  const script = await readFile(new URL("../scripts/measure-work-center.mjs", import.meta.url), "utf8");
  assert.match(script, /await import\("\.\.\/lib\/snapshot-queries\.ts"\)/u);
  assert.match(script, /SNAPSHOT_RECENT_ARCHIVED_SQL, \[/u);
});
