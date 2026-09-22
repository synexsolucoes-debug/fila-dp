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

/**
 * As entradas da tela de Admissão, na ordem em que vale tentar.
 *
 * Só ir ao aplicativo autônomo não bastou: numa conta real a navegação direta
 * para `admissao-demissao.tangerino.com.br/dashboard` terminou redirecionada de
 * volta para `/Tangerino/`, e o worker ficou olhando para o painel do shell —
 * onde não há iframe de admissão nenhum, e por isso `iframeCount: 0`.
 *
 * A rota que a conta realmente usa é a página do shell que hospeda o módulo. O
 * `funcionalidade=113` é o identificador do item no Wicket; ele pode variar
 * entre contas e perfis de permissão, então a mesma rota sem o parâmetro vem
 * logo em seguida, e o aplicativo autônomo fica por último como rede de
 * segurança. Todas são GET, dentro da mesma allowlist.
 */
export const tangerinoAdmissionsEntryUrls = [
  "https://app.tangerino.com.br/Tangerino/pages/admissao-demissao?funcionalidade=113",
  "https://app.tangerino.com.br/Tangerino/pages/admissao-demissao",
  tangerinoAdmissionsOverviewUrl,
] as const;
