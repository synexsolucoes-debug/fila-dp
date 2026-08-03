import { createHmac } from "node:crypto";
import { getD1 } from "@/db";

const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function clientAddress(request: Request) {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 120);
}

function keyFor(request: Request, subject: string, purpose: string) {
  const secret = process.env.FDP_AUTH_SECRET || "fila-dp-rate-limit";
  return createHmac("sha256", secret)
    .update(`${purpose}:${clientAddress(request)}:${subject.trim().toLowerCase()}`)
    .digest("hex");
}

type LimitRow = { attempt_count: number; window_started_at: string; blocked_until: string | null };

export class AuthRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.");
    this.name = "AuthRateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export async function assertAuthAttemptAllowed(request: Request, subject: string, purpose = "login") {
  const d1 = getD1();
  const key = keyFor(request, subject, purpose);
  const row = await d1.prepare("SELECT attempt_count, window_started_at, blocked_until FROM fdp_auth_rate_limits WHERE key_hash = ?")
    .bind(key)
    .first<LimitRow>();
  if (!row) return key;

  const now = Date.now();
  const blockedUntil = row.blocked_until ? new Date(row.blocked_until).getTime() : 0;
  if (blockedUntil > now) throw new AuthRateLimitError((blockedUntil - now) / 1000);

  const windowStartedAt = new Date(row.window_started_at).getTime();
  if (!Number.isFinite(windowStartedAt) || now - windowStartedAt >= WINDOW_MS) {
    await d1.prepare("DELETE FROM fdp_auth_rate_limits WHERE key_hash = ?").bind(key).run();
  }
  return key;
}

export async function registerAuthFailure(key: string) {
  const d1 = getD1();
  const row = await d1.prepare("SELECT attempt_count, window_started_at FROM fdp_auth_rate_limits WHERE key_hash = ?")
    .bind(key)
    .first<{ attempt_count: number; window_started_at: string }>();
  const now = Date.now();
  const started = row ? new Date(row.window_started_at).getTime() : 0;
  const withinWindow = Boolean(row && Number.isFinite(started) && now - started < WINDOW_MS);
  const attempts = withinWindow ? Number(row?.attempt_count ?? 0) + 1 : 1;
  const blockedUntil = attempts >= MAX_ATTEMPTS ? new Date(now + BLOCK_MS).toISOString() : null;

  await d1.prepare(`INSERT INTO fdp_auth_rate_limits (key_hash, attempt_count, window_started_at, blocked_until, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key_hash) DO UPDATE SET attempt_count = excluded.attempt_count,
      window_started_at = CASE WHEN ? = 1 THEN fdp_auth_rate_limits.window_started_at ELSE CURRENT_TIMESTAMP END,
      blocked_until = excluded.blocked_until, updated_at = CURRENT_TIMESTAMP`)
    .bind(key, attempts, blockedUntil, withinWindow ? 1 : 0)
    .run();
}

export async function clearAuthFailures(key: string) {
  await getD1().prepare("DELETE FROM fdp_auth_rate_limits WHERE key_hash = ?").bind(key).run();
}

export function authRateLimitResponse(error: AuthRateLimitError) {
  return Response.json(
    { error: error.message, retryAfterSeconds: error.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds), "Cache-Control": "no-store" } },
  );
}

