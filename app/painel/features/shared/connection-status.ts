/**
 * Como o produto chama o estado de uma conexão, em um lugar só.
 *
 * As palavras já existiam, no filtro do console da plataforma
 * (`app/plataforma/features/IntegrationsFeature.tsx`): "Conectadas",
 * "Pausadas", "Sem credencial", "Com erro". Escrever outras aqui faria o painel
 * e o console falarem línguas diferentes sobre o mesmo registro — que é como o
 * selo de status deste repositório chegou a ter cinco definições e duas
 * gramáticas incompatíveis.
 */
export const connectionStatusLabels: Record<string, string> = {
  connected: "Conectada",
  needs_credentials: "Sem credencial",
  paused: "Pausada",
  error: "Com erro",
};

export function connectionStatusLabel(status: string) {
  return connectionStatusLabels[status] ?? status;
}

/**
 * O tom de cada estado.
 *
 * `error` e `needs_credentials` não são a mesma coisa, e a diferença importa
 * para quem opera: sem credencial é trabalho de implantação, com erro é algo
 * que funcionava e parou. Misturar os dois num "atenção" só apagaria essa
 * distinção justamente na tela que existe para mostrá-la.
 */
export function connectionTone(status: string): "ok" | "warn" | "bad" | "idle" {
  if (status === "connected") return "ok";
  if (status === "error") return "bad";
  if (status === "needs_credentials") return "warn";
  return "idle";
}

/** "há 8 min", "há 3 h", "há 2 d" — ou nada, quando nunca sincronizou. */
export function lastSyncLabel(lastSyncAt: string | null) {
  if (!lastSyncAt) return "nunca sincronizou";
  const quando = Date.parse(lastSyncAt);
  if (Number.isNaN(quando)) return "nunca sincronizou";
  const minutos = Math.max(0, Math.round((Date.now() - quando) / 60000));
  if (minutos < 1) return "agora";
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  return `há ${Math.round(horas / 24)} d`;
}
