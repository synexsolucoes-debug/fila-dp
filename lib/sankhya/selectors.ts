/**
 * Único catálogo de seletores do Sankhya. O driver tenta primeiro rótulos e roles
 * semânticos e só depois atributos estáveis conhecidos.
 */
export const SankhyaSelectors = Object.freeze({
  usernameLabels: [/usuário/iu, /login/iu, /user/iu],
  usernameCss: ['input[name="username"]', 'input[name="login"]', 'input[autocomplete="username"]'],
  passwordLabels: [/senha/iu, /password/iu],
  passwordCss: ['input[name="password"]', 'input[type="password"]', 'input[autocomplete="current-password"]'],
  loginButtons: [/entrar/iu, /acessar/iu, /login/iu],
  authenticatedMarkers: [/menu principal/iu, /área de trabalho/iu, /favoritos/iu],
  captchaMarkers: [/captcha/iu, /não sou um robô/iu, /recaptcha/iu],
  mfaMarkers: [/autenticação em duas etapas/iu, /código de verificação/iu, /token de segurança/iu, /mfa/iu],
  invalidLoginMarkers: [/usuário ou senha inválid/iu, /credenciais inválid/iu, /login inválid/iu],
  blockedMarkers: [/usuário bloqueado/iu, /acesso bloqueado/iu],
  expiredPasswordMarkers: [/senha expirada/iu, /alterar senha/iu],
  dpExplorer: [/dp explorer/iu],
  searchLabels: [/pesquisar rotina/iu, /buscar rotina/iu, /pesquisar/iu],
  executeButtons: [/executar/iu, /consultar/iu, /atualizar/iu],
  loadingMarkers: [/carregando/iu, /processando/iu, /aguarde/iu],
  errorMarkers: [/erro ao processar/iu, /falha na consulta/iu],
  exportButtons: [/exportar/iu, /excel/iu, /xlsx/iu, /csv/iu],
  logoutButtons: [/sair/iu, /encerrar sessão/iu, /logout/iu],
});
