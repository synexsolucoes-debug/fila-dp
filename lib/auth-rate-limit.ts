import { createHmac } from "node:crypto";
import { getD1 } from "@/db";

const WINDOW_MINUTES = 15;
const IDENTITY_FAILURE_LIMIT = 5;
const ADDRESS_FAILURE_LIMIT = 30;

type LimitRow = { blocked_until: string | Date | null };

function limiterSecret() {
  return process.env.FDP_AUTH_SECRET ?? (process.env.NODE_ENV === "production" ? "" : "fila-dp-local-secret-change-me");
}

function keyHash(value: string) {
  const secret = limiterSecret();
  if (!secret) throw new Error("FDP_AUTH_SECRET não configurado.");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function clientAddress(request: Request) {
  if (process.env.VERCEL !== "1" && process.env.VERCEL !== "true") return "unknown";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  return address.slice(0, 128);
}

function keysFor(email: string, address: string) {
  return [
    { hash: keyHash(`login:${email}|${address}`), limit: IDENTITY_FAILURE_LIMIT },
    { hash: keyHash(`address:${address}`), limit: ADDRESS_FAILURE_LIMIT },
  ];
}

function retryAfter(blockedUntil: string | Date | null) {
  if (!blockedUntil) return 0;
  const remaining = new Date(blockedUntil).getTime() - Date.now();
  return remaining > 0 ? Math.max(1, Math.ceil(remaining / 1000)) : 0;
}

export async function checkLoginRateLimit(email: string, address: string) {
  const d1 = getD1();
  let retryAfterSeconds = 0;
  for (const key of keysFor(email, address)) {
    const row = await d1.prepare(`SELECT blocked_until
      FROM fdp_auth_rate_limits
      WHERE key_hash = ? AND blocked_until > CURRENT_TIMESTAMP`)
      .bind(key.hash)
      .first<LimitRow>();
    retryAfterSeconds = Math.max(retryAfterSeconds, retryAfter(row?.blocked_until ?? null));
  }
  return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
}

async function recordFailure(hash: string, limit: number) {
  return getD1().prepare(`INSERT INTO fdp_auth_rate_limits
      (key_hash, failure_count, window_started_at, blocked_until, updated_at)
    VALUES (?, 1, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT (key_hash) DO UPDATE SET
      failure_count = CASE
        WHEN fdp_auth_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes' THEN 1
        ELSE fdp_auth_rate_limits.failure_count + 1
      END,
      window_started_at = CASE
        WHEN fdp_auth_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes' THEN CURRENT_TIMESTAMP
        ELSE fdp_auth_rate_limits.window_started_at
      END,
      blocked_until = CASE
        WHEN fdp_auth_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes' THEN NULL
        WHEN fdp_auth_rate_limits.failure_count + 1 >= ? THEN CURRENT_TIMESTAMP + INTERVAL '15 minutes'
        ELSE fdp_auth_rate_limits.blocked_until
      END,
      updated_at = CURRENT_TIMESTAMP
    RETURNING blocked_until`)
    .bind(hash, limit)
    .first<LimitRow>();
}

export async function recordLoginFailure(email: string, address: string) {
  let retryAfterSeconds = 0;
  for (const key of keysFor(email, address)) {
    const row = await recordFailure(key.hash, key.limit);
    retryAfterSeconds = Math.max(retryAfterSeconds, retryAfter(row?.blocked_until ?? null));
  }
  return { blocked: retryAfterSeconds > 0, retryAfterSeconds };
}

export async function clearLoginIdentityFailures(email: string, address: string) {
  const identityHash = keysFor(email, address)[0].hash;
  await getD1().prepare("DELETE FROM fdp_auth_rate_limits WHERE key_hash = ?")
    .bind(identityHash)
    .run();
}

export const authRateLimitPolicy = {
  windowMinutes: WINDOW_MINUTES,
  identityFailureLimit: IDENTITY_FAILURE_LIMIT,
  addressFailureLimit: ADDRESS_FAILURE_LIMIT,
} as const;
