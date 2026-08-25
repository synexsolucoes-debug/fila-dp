/**
 * Único catálogo de seletores do Tangerino.
 *
 * Os seletores de navegação, pesquisa, cartão, situação e etapa foram validados
 * em 24/08/2026 contra uma sessão real e autorizada da Sólides DP / Tangerino.
 * O mapeamento confirmou duas camadas: o shell legado em `app.tangerino.com.br`
 * e a lista de admissões dentro do iframe oficial
 * `admissao-demissao.tangerino.com.br`.
 *
 * Inventar seletor daria a pior falha possível: o agente encontraria "alguma
 * coisa", leria o campo errado e devolveria um status plausível. `UI_CHANGED`
 * pede conferência; um status errado é acreditado.
 *
 * A interface não expõe código de processo nem data efetiva de admissão nos
 * cartões. O agente não substitui esses campos por posição da lista nem pela
 * "Data limite para a admissão": ausência continua sendo ausência.
 *
 * NUNCA clicar, durante o mapeamento, em Salvar, Excluir, Cancelar, Finalizar,
 * Admitir, Aprovar ou Rejeitar (§73). O agente é somente leitura e a pessoa que
 * o mapeia também precisa ser.
 */

/** A estrutura crítica abaixo foi confirmada em tela real (§72). */
export const TANGERINO_SELECTORS_ARE_PROVISIONAL = false;

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

  /** Caminho validado: menu Admissão → Visão geral → iframe do produto. */
  admissionsMenuCss: "a.item-menu.item-modulo-menu-pricing",
  admissionsMenuText: [/^admiss[ãa]o$/iu],
  admissionsOverviewLinks: [/^vis[ãa]o geral$/iu],
  admissionsFrameCss: 'iframe[src*="admissao-demissao.tangerino.com.br"]',
  admissionsPageMarkers: [/^admiss[ãa]o$/iu, /^todas admiss[õo]es$/iu],

  /** Pesquisa do colaborador dentro da área de admissão. */
  searchPlaceholders: [/^digite o nome$/iu],
  searchCss: ['input[placeholder="Digite o nome"]'],

  /** A interface real entrega cartões, sem papel ARIA de linha. */
  resultCardCss: ".cards-scroll .s-card",
  resultNameCss: "strong.s-title",
  emptyResultMarkers: [/nenhum (?:resultado|registro|processo)/iu, /nada encontrado/iu, /sem resultados/iu],

  /** Campos confirmados dentro de cada cartão. */
  statusLabels: [/^status da admiss[ãa]o$/iu],
  stageLabels: [/^status da etapa$/iu],
  cardValueCss: "p.info-status",
  pendingLabels: [/pend[êe]ncia/iu, /o que falta/iu, /motivo/iu],
  // Intencionalmente não casa com "Data limite para a admissão".
  admissionDateLabels: [/^data (?:de|da) admiss[ãa]o$/iu, /^admiss[ãa]o prevista$/iu],
  updatedAtLabels: [/[úu]ltima atualiza[çc][ãa]o/iu, /atualizado em/iu],
  externalIdLabels: [/c[óo]digo do processo/iu, /n[úu]mero do processo/iu, /protocolo/iu],
  displayNameLabels: [/colaborador/iu, /candidato/iu, /nome/iu],

  /** Downloads de leitura, liberados somente depois da autorização no cartão. */
  documentApprovalSection: [/^aprovar documentos$/iu],
  openSubmittedDocumentsButtons: [/^ver documentos enviados$/iu],
  openAdmissionDetailsButtons: [/^preencher dados$/iu, /^preencher documentos$/iu],
  /** Cabeçalho do painel recolhível que contém os documentos já enviados. */
  documentApprovalPanelHeaderCss: "nz-collapse-panel .ant-collapse-header",
  downloadAllDocumentsButtons: [/^baixar todos os documentos$/iu],
  exportRegistrationFormButtons: [/^exportar ficha do colaborador$/iu],

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
