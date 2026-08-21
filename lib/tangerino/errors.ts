import type { ConsultationState } from "./types.ts";

/**
 * Falha do agente Tangerino, com o que decidir depois dela.
 *
 * Três atributos e não um código só, porque três decisões diferentes são
 * tomadas a partir da mesma falha: repetir ou não (`retryable`), pedir ação de
 * uma pessoa ou não (`requiresUserAction`), e contar como possível quebra de
 * layout ou não (`layoutRelated`). Espremer isso num código faria a decisão
 * virar `if` sobre string espalhado pelo worker.
 */
export class TangerinoAgentError extends Error {
  readonly code: string;
  readonly state: ConsultationState;
  readonly retryable: boolean;
  readonly requiresUserAction: boolean;
  readonly layoutRelated: boolean;

  constructor(code: string, state: ConsultationState, message: string, options: {
    retryable?: boolean;
    requiresUserAction?: boolean;
    layoutRelated?: boolean;
  } = {}) {
    super(message);
    this.name = "TangerinoAgentError";
    this.code = code.slice(0, 80);
    this.state = state;
    this.retryable = options.retryable === true;
    this.requiresUserAction = options.requiresUserAction === true;
    this.layoutRelated = options.layoutRelated === true;
  }
}

/**
 * As falhas que o agente sabe nomear.
 *
 * Construtores em vez de `new TangerinoAgentError(...)` espalhado: o par
 * código/estado precisa ser o mesmo em todo lugar que produz a falha, senão a
 * tela recebe `UI_CHANGED` de um caminho e `CONSULTATION_FAILED` de outro para
 * a mesma causa.
 */
export const tangerinoErrors = {
  /** MFA, CAPTCHA, sessão expirada, tela de login. Nunca repetir sozinho. */
  authenticationRequired: (detail: string) => new TangerinoAgentError(
    "TANGERINO_AUTHENTICATION_REQUIRED", "AUTHENTICATION_REQUIRED",
    detail || "O Tangerino pediu autenticação. Renove o acesso do conector antes de consultar novamente.",
    { requiresUserAction: true },
  ),
  /** A pesquisa não devolveu nenhum processo. Não é erro, é resposta. */
  notFound: () => new TangerinoAgentError(
    "TANGERINO_ADMISSION_NOT_FOUND", "NOT_FOUND",
    "Nenhum processo de admissão foi localizado no Tangerino para este colaborador.",
  ),
  /** Mais de um candidato. Escolher um seria inventar o vínculo. */
  multipleMatches: (count: number) => new TangerinoAgentError(
    "TANGERINO_MULTIPLE_MATCHES", "MULTIPLE_MATCHES",
    `A pesquisa encontrou ${count} processos possíveis. Informe o identificador do processo no Tangerino para desfazer o empate.`,
  ),
  /** Um elemento sem o qual não há leitura confiável não estava lá. */
  uiChanged: (step: string, selector: string) => new TangerinoAgentError(
    "TANGERINO_UI_CHANGED", "UI_CHANGED",
    `A tela do Tangerino mudou: a etapa "${step}" não encontrou "${selector}".`,
    { layoutRelated: true },
  ),
  /** O navegador saiu do domínio autorizado. */
  unauthorizedNavigation: (host: string) => new TangerinoAgentError(
    "TANGERINO_UNAUTHORIZED_NAVIGATION", "CONSULTATION_FAILED",
    `A navegação foi interrompida: o destino "${host}" não faz parte dos domínios autorizados do Tangerino.`,
  ),
  /** A página tentou uma requisição de alteração. Nunca deveria acontecer. */
  readOnlyViolation: (method: string, url: string) => new TangerinoAgentError(
    "TANGERINO_READ_ONLY_VIOLATION", "CONSULTATION_FAILED",
    `A consulta foi interrompida: uma requisição ${method} de alteração foi tentada em "${url}". O agente é somente leitura.`,
  ),
  timeout: (step: string) => new TangerinoAgentError(
    "TANGERINO_TIMEOUT", "TIMEOUT",
    `O Tangerino não respondeu a tempo na etapa "${step}".`,
    { retryable: true },
  ),
  unavailable: (detail: string) => new TangerinoAgentError(
    "TANGERINO_UNAVAILABLE", "TANGERINO_UNAVAILABLE",
    detail || "O Tangerino está indisponível no momento.",
    { retryable: true },
  ),
  credentialRequired: () => new TangerinoAgentError(
    "TANGERINO_CREDENTIAL_REQUIRED", "AUTHENTICATION_REQUIRED",
    "As credenciais do agente Tangerino precisam ser configuradas antes de consultar.",
    { requiresUserAction: true },
  ),
};

/**
 * Nunca deixar vazar o que não pode ser lido depois.
 *
 * Uma exceção de navegador carrega URL com querystring, corpo de requisição e,
 * em alguns casos, o valor que estava no campo — que aqui é a senha do cliente.
 * O expurgo acontece na fronteira, antes de a mensagem alcançar log, banco ou
 * tela, porque depois dela há três destinos e só uma chance de acertar.
 */
export function safeTangerinoError(error: unknown): TangerinoAgentError {
  if (error instanceof TangerinoAgentError) return error;
  const raw = error instanceof Error ? error.message : "Falha inesperada no agente Tangerino.";
  const sanitized = raw
    /* `Authorization: Bearer abc.def` tem o segredo na SEGUNDA palavra. Um padrão
       que consome um único termo apaga "Bearer" e deixa o token à mostra — que é
       o oposto do que este expurgo existe para fazer. Por isso o esquema de
       autenticação é opcionalmente consumido junto com o valor. */
    .replace(/(password|senha|token|cookie|authorization|secret)\s*[:=]?\s*(?:bearer|basic|token)?\s*[^\s,;]+/giu, "$1=[oculto]")
    .replace(/\bbearer\s+[^\s,;]+/giu, "[oculto]")
    .replace(/[?&](?:token|password|senha|code|access_token)=[^&\s]+/giu, "[oculto]")
    .slice(0, 500);
  // Timeout do Playwright é a única falha genérica que dá para classificar com
  // segurança pela mensagem — e classificar errado aqui custa um retry indevido.
  if (/timeout|timed out/iu.test(sanitized)) return tangerinoErrors.timeout("navegação");
  return new TangerinoAgentError("TANGERINO_UNEXPECTED_ERROR", "CONSULTATION_FAILED",
    sanitized || "Falha inesperada no agente Tangerino.", { retryable: true });
}
