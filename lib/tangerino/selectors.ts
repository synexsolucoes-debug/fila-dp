/**
 * Único catálogo de seletores do Tangerino.
 *
 * ATENÇÃO — LEIA ANTES DE CONFIAR NESTE ARQUIVO.
 *
 * Estes padrões **não foram verificados contra a interface real do Tangerino**.
 * Eles não foram copiados de uma tela: são a abstração que a §11 pede quando não
 * há acesso autorizado para conferir. Enquanto a etapa de mapeamento (§72) não
 * acontecer, o comportamento esperado do agente diante de uma tela real é falhar
 * com `UI_CHANGED` — e isso é o resultado correto, não um defeito.
 *
 * Inventar seletor daria a pior falha possível: o agente encontraria "alguma
 * coisa", leria o campo errado e devolveria um status plausível. `UI_CHANGED`
 * pede conferência; um status errado é acreditado.
 *
 * COMO MAPEAR DE VERDADE (§72)
 *   1. `TANGERINO_BROWSER_HEADLESS_OFF=true` e uma conta autorizada de consulta;
 *   2. abrir Admissão e localizar um processo de teste;
 *   3. preferir, nesta ordem: papel acessível (`getByRole`), rótulo
 *      (`getByLabel`), texto estável (`getByText`), atributo semântico;
 *   4. substituir o padrão daqui — nunca espalhar seletor pelo resto do código;
 *   5. rodar `npm run tangerino:fixtures` e atualizar as fixtures;
 *   6. marcar em `status.ts` as frases confirmadas com `evidence: "tela"`.
 *
 * NUNCA clicar, durante o mapeamento, em Salvar, Excluir, Cancelar, Finalizar,
 * Admitir, Aprovar ou Rejeitar (§73). O agente é somente leitura e a pessoa que
 * o mapeia também precisa ser.
 */

/** Todo padrão daqui ainda espera confirmação em tela real. */
export const TANGERINO_SELECTORS_ARE_PROVISIONAL = true;

export const TangerinoSelectors = Object.freeze({
  /** Sinais de que a sessão caiu ou nunca existiu. */
  loginMarkers: [/entrar/iu, /acessar (?:sua )?conta/iu, /informe (?:seu|o) e-?mail/iu],
  sessionExpiredMarkers: [/sess[ãa]o expirad/iu, /sua sess[ãa]o (?:terminou|encerrou)/iu, /fa[çc]a login novamente/iu],
  accessDeniedMarkers: [/acesso negado/iu, /sem permiss[ãa]o/iu, /voc[êe] n[ãa]o tem acesso/iu],

  /**
   * MFA e CAPTCHA não são obstáculos a vencer: são o sinal de parar (§16).
   * Detectá-los serve para devolver `AUTHENTICATION_REQUIRED` depressa, e nunca
   * para tentar contorná-los.
   */
  mfaMarkers: [/autentica[çc][ãa]o em duas etapas/iu, /c[óo]digo de verifica[çc][ãa]o/iu, /token de seguran[çc]a/iu, /\bmfa\b/iu, /\b2fa\b/iu],
  captchaMarkers: [/captcha/iu, /n[ãa]o (?:sou|é|e) um rob[ôo]/iu, /recaptcha/iu, /hcaptcha/iu],

  /**
   * O widget de CAPTCHA no DOM, e não no texto.
   *
   * Detectar CAPTCHA por texto falha no caso mais comum: o desafio do reCAPTCHA
   * e do hCaptcha vive dentro de um iframe, e a página em volta pode não escrever
   * a palavra em lugar nenhum — só "Acessar sua conta", igual à tela de login.
   * Sem esta verificação, o agente lê a tela do desafio como se fosse a de login,
   * digita a senha e tenta de novo, que é o caminho mais curto para a conta do
   * cliente ser bloqueada por tentativas sucessivas.
   */
  captchaWidgets: [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[title*="captcha" i]',
    ".g-recaptcha", ".h-captcha", "[data-sitekey]", "#captcha",
  ],

  /** Campos de login. CSS é fallback, e só de login. */
  usernameLabels: [/e-?mail/iu, /usu[áa]rio/iu, /login/iu],
  usernameCss: ['input[name="email"]', 'input[name="username"]', 'input[autocomplete="username"]', 'input[type="email"]'],
  passwordLabels: [/senha/iu, /password/iu],
  passwordCss: ['input[name="password"]', 'input[type="password"]', 'input[autocomplete="current-password"]'],
  submitButtons: [/^entrar$/iu, /^acessar$/iu, /^login$/iu],

  /** Marca de que a sessão está de pé e o agente pode navegar. */
  authenticatedMarkers: [/admiss[ãa]o/iu, /colaboradores/iu, /menu/iu],

  /** Caminho até a área de admissão. */
  admissionsNav: [/admiss[ãa]o digital/iu, /^admiss(?:[ãa]o|[õo]es)$/iu, /processos? admissionai?s/iu],
  admissionsPageMarkers: [/processos? admissionai?s/iu, /admiss[õo]es em andamento/iu, /admiss[ãa]o digital/iu],

  /** Pesquisa do colaborador dentro da área de admissão. */
  searchLabels: [/pesquisar/iu, /buscar/iu, /nome do colaborador/iu, /filtrar/iu],
  searchCss: ['input[type="search"]', 'input[name="search"]', 'input[name="busca"]'],

  /** Linhas do resultado. É o que o parser conta para achar duplicidade. */
  resultRowRole: "row" as const,
  emptyResultMarkers: [/nenhum (?:resultado|registro|processo)/iu, /nada encontrado/iu, /sem resultados/iu],

  /** Campos da tela do processo aberto. */
  statusLabels: [/situa[çc][ãa]o/iu, /status/iu, /etapa atual/iu],
  stageLabels: [/etapa/iu, /fase/iu],
  pendingLabels: [/pend[êe]ncia/iu, /o que falta/iu, /motivo/iu],
  admissionDateLabels: [/data de admiss[ãa]o/iu, /admiss[ãa]o prevista/iu],
  updatedAtLabels: [/[úu]ltima atualiza[çc][ãa]o/iu, /atualizado em/iu],
  externalIdLabels: [/c[óo]digo do processo/iu, /n[úu]mero do processo/iu, /protocolo/iu],
  displayNameLabels: [/colaborador/iu, /candidato/iu, /nome/iu],

  /**
   * Ações de escrita que o agente reconhece **para ignorar**.
   *
   * Estão listadas porque ignorar de propósito é diferente de nunca ter olhado:
   * o teste de somente-leitura usa esta lista para provar que nenhum caminho do
   * cliente encosta nelas.
   */
  forbiddenActions: [
    /^salvar$/iu, /^excluir$/iu, /^cancelar admiss[ãa]o$/iu, /^finalizar$/iu,
    /^admitir$/iu, /^aprovar$/iu, /^rejeitar$/iu, /^assinar$/iu, /^enviar documento$/iu,
  ],
});
