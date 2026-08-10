/**
 * Erro de requisição com identificação de suporte.
 *
 * A tela de falha do painel mostrava só a frase genérica devolvida pelo
 * servidor. O `code` e o `requestId` que a resposta já trazia eram descartados
 * — e sem eles ninguém consegue dizer *qual* falha aconteceu, nem localizar o
 * registro correspondente no log. Quem reporta o problema fica sem prova e quem
 * investiga fica sem ponto de partida.
 */
export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(message: string, status: number, code = "", requestId = "") {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  /** Falha de infraestrutura: não é erro do usuário e não adianta insistir já. */
  get isInfrastructure() {
    return this.code === "SCHEMA_OUTDATED" || this.code === "DATABASE_UNAVAILABLE";
  }
}

/** Constrói o erro a partir da resposta, preservando o que veio do servidor. */
export function requestErrorFrom(response: Response, payload: Record<string, unknown>) {
  return new RequestError(
    typeof payload.error === "string" && payload.error ? payload.error : "Não foi possível concluir a operação.",
    response.status,
    typeof payload.code === "string" ? payload.code : "",
    typeof payload.requestId === "string" ? payload.requestId : "",
  );
}

/** Linha de referência mostrada na tela, para o usuário repassar ao suporte. */
export function supportReference(error: unknown) {
  if (!(error instanceof RequestError)) return "";
  const parts = [];
  if (error.code) parts.push(`código ${error.code}`);
  if (error.requestId) parts.push(`chamado ${error.requestId}`);
  return parts.join(" · ");
}
