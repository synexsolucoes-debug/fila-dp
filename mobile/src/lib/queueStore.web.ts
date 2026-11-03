/** Prévia web (desenvolvimento): a fila no `localStorage`. No iPhone vale `queueStore.ts` (SQLite). */
const KEY = "vinculato-campo:fila";
type Entry = { id: string; createdAt: number; body: string };

const read = (): Entry[] => {
  try { return JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]") as Entry[]; } catch { return []; }
};
const write = (entries: Entry[]) => { try { globalThis.localStorage?.setItem(KEY, JSON.stringify(entries)); } catch { /* sem armazenamento */ } };

export async function storePut(id: string, createdAt: number, body: string) {
  write([...read().filter((entry) => entry.id !== id), { id, createdAt, body }]);
}
export async function storeRemove(id: string) { write(read().filter((entry) => entry.id !== id)); }
export async function storeList() { return read().sort((a, b) => a.createdAt - b.createdAt).map((entry) => entry.body); }
