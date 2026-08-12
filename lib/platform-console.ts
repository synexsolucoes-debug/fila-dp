import { ApiError } from "./api-errors.ts";

const sensitiveKey = /authorization|cookie|credential|encrypted|initialization|password|secret|senha|token|auth_tag|api.?key.?hash|private.?key/iu;
const sensitiveValue = /\b(?:bearer\s+[a-z0-9._~+/-]{8,}|basic\s+[a-z0-9+/=]{8,}|sk_(?:live|test)_[a-z0-9]{8,}|ghp_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,}|AIza[a-z0-9_-]{20,}|(?:password|senha|secret|token|api[_ -]?key)\s*[:=]\s*\S{6,})/iu;

export function platformListLimit(value: string | null, fallback = 25, maximum = 100) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, parsed) : fallback;
}

export type PlatformCursor = { createdAt: string; id: string };

export function encodePlatformCursor(cursor: PlatformCursor | null) {
  return cursor ? Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url") : null;
}

export function decodePlatformCursor(value: string | null): PlatformCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (!createdAt || !id || createdAt.length > 80 || id.length > 180) throw new Error("invalid cursor");
    return { createdAt, id };
  } catch {
    throw ApiError.badRequest("Cursor de paginação inválido.", "PLATFORM_CURSOR_INVALID");
  }
}

/** Redige por nome de campo antes de qualquer valor chegar à resposta ou auditoria global. */
export function sanitizePlatformValue(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[limite de profundidade]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizePlatformValue(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sensitiveValue.test(value) ? "[redigido]" : value.slice(0, 2_000) : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sensitiveKey.test(key) ? "[redigido]" : sanitizePlatformValue(item, depth + 1),
  ]));
}

export function requiredPlatformReason(value: unknown, minimum = 5) {
  const reason = typeof value === "string" ? value.trim().slice(0, 500) : "";
  if (reason.length < minimum) {
    throw ApiError.badRequest(`Informe o motivo com pelo menos ${minimum} caracteres.`, "PLATFORM_REASON_REQUIRED");
  }
  if (sensitiveValue.test(reason)) {
    throw ApiError.badRequest("O motivo não pode conter credenciais ou segredos.", "PLATFORM_REASON_CONTAINS_SECRET");
  }
  return reason;
}

export function csvCell(value: unknown) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""').replace(/[\r\n]+/gu, " ")}"`;
}
