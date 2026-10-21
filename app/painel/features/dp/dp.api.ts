/** Chamadas do DP Operacional: JSON, sem cache, erro com a mensagem do servidor. */
export async function dpRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

export const brDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
};

export const weekdayShort = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function errorText(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
