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

/**
 * Entrada oficial do produto web usada pelo agente.
 *
 * Não é configuração do workspace: permitir que o cliente informe este endereço
 * transformaria o navegador autenticado em um cliente de URL arbitrária. Quando
 * a Sólides mudar a entrada, a alteração passa por revisão e pela allowlist.
 */
export const tangerinoBrowserLoginUrl = "https://app.tangerino.com.br/Tangerino/pages/LoginPage";

/**
 * Entrada estável da Visão geral de Admissão Digital.
 *
 * O menu do shell legado muda de classe entre contas e versões do Wicket. A
 * rota oficial do aplicativo de Admissão Digital é estável e continua sendo
 * uma navegação GET, somente leitura, dentro da allowlist fixa do Tangerino.
 */
export const tangerinoAdmissionsOverviewUrl =
  "https://admissao-demissao.tangerino.com.br/dashboard";
