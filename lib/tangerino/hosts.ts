/**
 * Domínios oficiais da Sólides DP / Tangerino.
 *
 * Vive num arquivo só seu, e não junto da validação de navegação, por um motivo
 * concreto de empacotamento: `navigation-security.ts` importa `node:dns`, e
 * `lib/integrations.ts` — que precisa desta lista para validar a URL do conector
 * — é alcançado pelo bundle do cliente. Uma constante de texto arrastando um
 * módulo de rede do Node para o navegador quebra o build, e foi o que aconteceu.
 *
 * A regra que isso deixa: dado puro fica em módulo puro. Quem precisa do dado
 * não deve herdar as dependências de quem o usa.
 */
export const tangerinoBrowserHosts = ["tangerino.com.br", "solides.com.br"] as const;
