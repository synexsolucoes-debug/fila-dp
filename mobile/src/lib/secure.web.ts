/**
 * Prévia web (desenvolvimento): o navegador não tem chaveiro, então usa o
 * `localStorage`. Não é o app de produção — no iPhone vale `secure.ts`.
 */
const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export const secureGet = async (key: string) => store()?.getItem(key) ?? null;
export const secureSet = async (key: string, value: string) => { store()?.setItem(key, value); };
export const secureDelete = async (key: string) => { store()?.removeItem(key); };
