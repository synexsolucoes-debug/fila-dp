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

export type FieldSource = "document" | "registry" | "manual";

export const FIELD_SOURCE_LABELS: Readonly<Record<FieldSource, string>> = {
  document: "do documento",
  registry: "do cadastro",
  manual: "preenchido à mão",
};

/** Origem por campo. Sem valor — o conteúdo vem cifrado, junto da ficha. */
export type FieldProvenance = { source: FieldSource; documentValue: string; by: string; at: string };

/** Identidade: documento que não parece ser desta pessoa. */
export type IdentityDivergence = { field: string; label: string; detail: string };

export type SheetConfirmation = { erpRegistration: string; confirmedAt: string; confirmedBy: string };

/**
 * Em que pé está o preparo.
 *
 * `absent` e `pending` não podem virar a mesma tela: a primeira significa que
 * o PDF ainda não chegou, a segunda que ele chegou e está sendo lido. Mandar a
 * pessoa clicar em "Ler a ficha" no meio de uma leitura em curso é o tipo de
 * ruído que faz a automação parecer quebrada.
 */
export type SheetPreparationState = "absent" | "pending" | "ready" | "failed";

export type SheetPayload = {
  state: SheetPreparationState;
  sheet: RegistrationSheet | null;
  attempts?: number;
  maxAttempts?: number;
  errorCode?: string;
  errorMessage?: string;
  sourceFilename?: string;
  attachmentId?: string;
  divergences?: IdentityDivergence[];
  confirmation?: SheetConfirmation | null;
};

export type RegistrationSheet = {
  blocks: SheetBlock[];
  warnings: string[];
  readable: number;
  filled: number;
  sourceFilename?: string;
  attachmentId?: string;
  updatedAt?: string;
  provenance?: Record<string, FieldProvenance>;
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
