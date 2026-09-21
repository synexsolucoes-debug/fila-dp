/** Tipos e acesso da ficha de contratação, buscada por rota própria. */
export type SheetFieldStatus = "ok" | "blank" | "invalid";

export type SheetField = {
  key: string;
  label: string;
  block: string;
  status: SheetFieldStatus;
  value: string;
  note: string;
};

export type SheetBlock = { block: string; label: string; fields: SheetField[] };

export type RegistrationSheet = {
  blocks: SheetBlock[];
  warnings: string[];
  readable: number;
  filled: number;
  sourceFilename?: string;
  attachmentId?: string;
  updatedAt?: string;
};

/**
 * A ficha não vem no retrato do workspace, e é de propósito.
 *
 * Todo o resto da demanda chega junto do painel. Pôr valor de documento ali o
 * deixaria na memória do navegador de quem só passou pela tela. Buscar sob
 * demanda é o que faz a permissão de leitura valer alguma coisa.
 */
export async function requestSheet<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível ler a ficha.");
  return payload;
}
