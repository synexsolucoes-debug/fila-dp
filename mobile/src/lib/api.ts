/**
 * Cliente da API do Vinculato para o app de campo.
 *
 * O app conversa com as **mesmas** rotas do painel (`/api/epi/*`,
 * `/api/employees`) e o servidor confere cada permissão de novo. O que muda é a
 * identificação: em vez de cookie, o token da sessão no `Authorization`, mais
 * o cabeçalho `x-vinculato-client` que diz ao filtro de origem do servidor que
 * a ausência de `Origin` é esperada — é um app nativo, não um navegador.
 */

export const NATIVE_CLIENT_HEADER = "x-vinculato-client";
export const NATIVE_CLIENT_VALUE = "campo-app";

/** Recusa do servidor, com a mensagem que ele mandou. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Falha de rede: o pedido nem chegou ao servidor. É o caso em que a fila guarda e reenvia. */
export class NetworkError extends Error {
  constructor(message = "Sem conexão com o servidor.") {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Recusa definitiva — não adianta reenviar.
 *
 * 4xx que não seja 408/429 é decisão do servidor, não tropeço de rede. Sem esta
 * distinção a fila giraria para sempre sobre uma operação inválida.
 */
export function isPermanent(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 408 || error.status === 429) return false;
  return error.status >= 400 && error.status < 500;
}

type Credentials = { server: string; token: string };

let credentials: Credentials | null = null;
let onUnauthorized: (() => void) | null = null;

/** A sessão registra aqui o servidor e o token; o cliente não guarda nada em disco. */
export function setCredentials(next: Credentials | null) { credentials = next; }
export function setUnauthorizedHandler(handler: (() => void) | null) { onUnauthorized = handler; }

/** Normaliza o endereço digitado: protocolo, sem barra no fim. */
export function normalizeServer(value: string) {
  const raw = value.trim().replace(/\/+$/u, "");
  if (!raw) return "";
  return /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`;
}

const TIMEOUT_MS = 20_000;

async function send(server: string, path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    [NATIVE_CLIENT_HEADER]: NATIVE_CLIENT_VALUE,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body && !(init.body instanceof FormData)) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${server}${path}`, { ...init, headers, signal: controller.signal });
  } catch {
    // Sem resposta nenhuma — rede caída, servidor inalcançável, tempo esgotado.
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(response.status, String(payload.code ?? ""), String(payload.error ?? "Não foi possível concluir a operação."));
  }
  return payload;
}

/** Pedido autenticado. 401 encerra a sessão local: o token foi revogado ou expirou. */
export async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  if (!credentials) throw new ApiError(401, "NO_SESSION", "Entre novamente para continuar.");
  try {
    return await send(credentials.server, path, { ...init, token: credentials.token }) as T;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
    throw error;
  }
}

/** Login: mesmas regras do site, com o token na resposta em vez de cookie. */
export async function loginRequest(server: string, email: string, password: string) {
  const payload = await send(server, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, client: "app" }),
  });
  return payload as { token: string; expiresAt: string; user: { name: string; email: string } };
}

/** Sair revoga o token no servidor. Sem rede, a sessão local sai do mesmo jeito. */
export async function logoutRequest(server: string, token: string) {
  await send(server, "/api/auth/logout", { method: "POST", token }).catch(() => undefined);
}
