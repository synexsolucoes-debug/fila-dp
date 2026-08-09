import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { getD1 } from "../db";
import { ApiError } from "./api-errors.ts";
import { log, requestIdFrom } from "./observability.ts";
import { cleanText } from "./registrations.ts";
import { setTenantContext } from "./tenant-context.ts";

/**
 * API pública `/api/v1` (§92).
 *
 * Autenticação por chave com escopos, limite por chave, idempotência para
 * escrita e versionamento no caminho. A chave é armazenada apenas como HMAC:
 * o token completo existe uma única vez, na resposta da criação.
 */
export const apiScopes = [
  "companies.read",
  "employees.read",
  "competences.read",
  "payments.read",
  "payments.write",
] as const;
export type ApiScope = typeof apiScopes[number];

export const API_VERSION = "2026-08-09";
const IDEMPOTENCY_TTL_HOURS = 24;
const RATE_WINDOW_SECONDS = 60;

export function parseScopes(value: unknown): ApiScope[] {
  const list = Array.isArray(value) ? value : [];
  const scopes = [...new Set(list.map((item) => cleanText(item, 40)))].filter((item): item is ApiScope => (apiScopes as readonly string[]).includes(item));
  if (!scopes.length) throw ApiError.badRequest("Selecione ao menos um escopo válido.", "API_SCOPES_REQUIRED");
  return scopes;
}

function apiKeySecret() {
  const secret = process.env.FDP_API_KEY_SECRET ?? process.env.FDP_AUTH_SECRET;
  if (!secret) throw new Error("Defina FDP_API_KEY_SECRET (ou FDP_AUTH_SECRET) para emitir chaves de API.");
  return secret;
}

export function hashApiToken(token: string) {
  return createHmac("sha256", apiKeySecret()).update(`api-key:${token}`).digest("hex");
}

/** Gera o token com prefixo pesquisável e segredo aleatório de 32 bytes. */
export function generateApiToken() {
  const prefix = `fdp_${randomBytes(6).toString("hex")}`;
  const token = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { prefix, token, tokenHash: hashApiToken(token) };
}

function parseBearer(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(fdp_[a-f0-9]{12}_[A-Za-z0-9_-]{20,120})$/u.exec(header.trim());
  return match ? match[1] : "";
}

type Database = ReturnType<typeof getD1>;

export type ApiContext = {
  workspaceId: string;
  apiKeyId: string;
  scopes: ApiScope[];
  requestId: string;
  rateLimitPerMinute: number;
};

type ApiKeyRow = {
  id: string; workspace_id: string; scopes_json: string[] | string; status: string;
  rate_limit_per_minute: number; expires_at: string | null; token_hash: string;
};

/**
 * Autentica a chave, estabelece o contexto de tenant e aplica o limite por
 * minuto. Nenhuma consulta de negócio roda antes disso.
 */
export async function authenticateApiRequest(d1: Database, request: Request): Promise<ApiContext> {
  const requestId = requestIdFrom(request);
  const token = parseBearer(request);
  if (!token) throw new ApiError(401, "API_KEY_REQUIRED", "Envie a chave em Authorization: Bearer.");

  const prefix = token.split("_").slice(0, 2).join("_");
  const row = await d1.prepare(`SELECT id, workspace_id, scopes_json, status, rate_limit_per_minute, expires_at, token_hash
    FROM fdp_api_keys WHERE prefix = ?`).bind(prefix).first<ApiKeyRow>();

  const expected = Buffer.from(row?.token_hash ?? "");
  const received = Buffer.from(hashApiToken(token));
  const matches = Boolean(row) && expected.length === received.length && timingSafeEqual(expected, received);
  if (!row || !matches) {
    log("warn", "api_v1.auth_failed", { requestId }, { reason: row ? "mismatch" : "unknown_prefix" });
    throw new ApiError(401, "API_KEY_INVALID", "Chave de API inválida.");
  }
  if (row.status !== "active") throw new ApiError(401, "API_KEY_REVOKED", "Chave de API revogada.");
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ApiError(401, "API_KEY_EXPIRED", "Chave de API expirada.");
  }

  const workspaceId = String(row.workspace_id);
  setTenantContext({ workspaceId, userId: null });

  const scopes = (Array.isArray(row.scopes_json) ? row.scopes_json : JSON.parse(String(row.scopes_json || "[]")) as string[])
    .filter((item): item is ApiScope => (apiScopes as readonly string[]).includes(item));

  await enforceRateLimit(d1, String(row.id), Number(row.rate_limit_per_minute), requestId);
  await d1.prepare("UPDATE fdp_api_keys SET last_used_at = now() WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, row.id).run();

  return { workspaceId, apiKeyId: String(row.id), scopes, requestId, rateLimitPerMinute: Number(row.rate_limit_per_minute) };
}

/** Janela fixa por minuto, contada no banco para valer entre instâncias. */
async function enforceRateLimit(d1: Database, apiKeyId: string, limit: number, requestId: string) {
  const keyHash = createHmac("sha256", apiKeySecret()).update(`api-rate:${apiKeyId}`).digest("base64url");
  const row = await d1.prepare(`INSERT INTO fdp_api_rate_limits (key_hash, window_started_at, request_count, updated_at)
    VALUES (?, now(), 1, now())
    ON CONFLICT (key_hash) DO UPDATE SET
      window_started_at = CASE WHEN fdp_api_rate_limits.window_started_at < now() - (? * interval '1 second') THEN now() ELSE fdp_api_rate_limits.window_started_at END,
      request_count = CASE WHEN fdp_api_rate_limits.window_started_at < now() - (? * interval '1 second') THEN 1 ELSE fdp_api_rate_limits.request_count + 1 END,
      updated_at = now()
    RETURNING request_count, window_started_at`)
    .bind(keyHash, RATE_WINDOW_SECONDS, RATE_WINDOW_SECONDS)
    .first<{ request_count: number; window_started_at: string }>();

  const count = Number(row?.request_count ?? 1);
  if (count > limit) {
    const startedAt = row?.window_started_at ? new Date(row.window_started_at).getTime() : Date.now();
    const retryAfter = Math.max(1, Math.ceil((startedAt + RATE_WINDOW_SECONDS * 1000 - Date.now()) / 1000));
    log("warn", "api_v1.rate_limited", { requestId, apiKeyId }, { limit, count });
    throw new ApiError(429, "API_RATE_LIMITED", `Limite de ${limit} requisições por minuto excedido.`, { retryAfter });
  }
}

export function requireScope(context: ApiContext, scope: ApiScope) {
  if (!context.scopes.includes(scope)) {
    throw new ApiError(403, "API_SCOPE_REQUIRED", `A chave não possui o escopo ${scope}.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Idempotência                                                                */
/* -------------------------------------------------------------------------- */

export function requestFingerprint(method: string, path: string, body: string) {
  return createHash("sha256").update(`${method}:${path}:${body}`).digest("hex");
}

export type IdempotencyOutcome =
  | { kind: "replay"; status: number; body: string }
  | { kind: "fresh"; key: string; fingerprint: string }
  | { kind: "absent" };

/**
 * Idempotência de escrita: a mesma chave com o mesmo corpo devolve a resposta
 * original; a mesma chave com corpo diferente é conflito, nunca uma segunda
 * execução silenciosa.
 */
export async function beginIdempotentRequest(d1: Database, context: ApiContext, request: Request, path: string, body: string): Promise<IdempotencyOutcome> {
  const key = cleanText(request.headers.get("idempotency-key"), 120);
  if (!key) return { kind: "absent" };
  if (key.length < 8) throw ApiError.badRequest("Idempotency-Key precisa de ao menos 8 caracteres.", "IDEMPOTENCY_KEY_INVALID");

  const fingerprint = requestFingerprint(request.method, path, body);
  const existing = await d1.prepare(`SELECT request_hash, response_status, response_body FROM fdp_api_idempotency_records
    WHERE workspace_id = ? AND api_key_id = ? AND idempotency_key = ? AND expires_at > now()`)
    .bind(context.workspaceId, context.apiKeyId, key)
    .first<{ request_hash: string; response_status: number; response_body: string }>();

  if (existing) {
    if (String(existing.request_hash) !== fingerprint) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "Esta Idempotency-Key já foi usada com outro conteúdo.");
    }
    return { kind: "replay", status: Number(existing.response_status), body: String(existing.response_body) };
  }
  return { kind: "fresh", key, fingerprint };
}

export async function completeIdempotentRequest(
  d1: Database,
  context: ApiContext,
  outcome: IdempotencyOutcome,
  request: Request,
  path: string,
  status: number,
  body: string,
) {
  if (outcome.kind !== "fresh") return;
  await d1.prepare(`INSERT INTO fdp_api_idempotency_records
      (id, workspace_id, api_key_id, idempotency_key, method, path, request_hash, response_status, response_body, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now() + (? * interval '1 hour'))
    ON CONFLICT (workspace_id, api_key_id, idempotency_key) DO NOTHING`)
    .bind(crypto.randomUUID(), context.workspaceId, context.apiKeyId, outcome.key, request.method, path,
      outcome.fingerprint, status, body.slice(0, 20_000), IDEMPOTENCY_TTL_HOURS)
    .run();
}

/** Resposta padrão da API pública, com correlação e versão no cabeçalho. */
export function apiV1Response(context: ApiContext, payload: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Fila-DP-Request-Id": context.requestId,
      "X-Fila-DP-Api-Version": API_VERSION,
      ...extraHeaders,
    },
  });
}

export function apiV1Error(error: unknown, requestId?: string) {
  if (error instanceof ApiError) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Fila-DP-Api-Version": API_VERSION,
      ...(requestId ? { "X-Fila-DP-Request-Id": requestId } : {}),
    };
    const retryAfter = error.details?.retryAfter;
    if (typeof retryAfter === "number") headers["Retry-After"] = String(retryAfter);
    return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: error.status, headers });
  }
  const fallbackId = requestId ?? crypto.randomUUID();
  log("error", "api_v1.unhandled_error", { requestId: fallbackId }, {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return new Response(JSON.stringify({ error: "Não foi possível concluir a operação.", code: "INTERNAL_ERROR", requestId: fallbackId }), {
    status: 500,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Fila-DP-Request-Id": fallbackId },
  });
}

/** Paginação por cursor: nada de carregar coleção inteira (§94). */
export function paginationFrom(url: URL) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const cursor = cleanText(url.searchParams.get("cursor"), 120);
  return { limit, cursor };
}
