/**
 * Onde a fila mora: SQLite do aparelho (incluído no Expo Go).
 * `queueStore.web.ts` é a versão da prévia web.
 */
import * as SQLite from "expo-sqlite";

let database: SQLite.SQLiteDatabase | null = null;

function db() {
  if (!database) {
    database = SQLite.openDatabaseSync("vinculato-campo.db");
    database.execSync(`CREATE TABLE IF NOT EXISTS fila (
      id TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL,
      body TEXT NOT NULL
    )`);
  }
  return database;
}

export async function storePut(id: string, createdAt: number, body: string) {
  await db().runAsync("INSERT OR REPLACE INTO fila (id, created_at, body) VALUES (?, ?, ?)", id, createdAt, body);
}

export async function storeRemove(id: string) {
  await db().runAsync("DELETE FROM fila WHERE id = ?", id);
}

export async function storeList() {
  const rows = await db().getAllAsync<{ body: string }>("SELECT body FROM fila ORDER BY created_at");
  return rows.map((row) => row.body);
}
