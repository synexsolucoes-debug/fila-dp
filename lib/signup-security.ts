import { createHash, createHmac, randomBytes } from "node:crypto";
import { ApiError } from "./api-errors.ts";

const EMAIL_MAX_LENGTH = 254;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function signupSecret() {
  const secret = String(process.env.FDP_AUTH_SECRET ?? "").trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", "O cadastro está temporariamente indisponível.");
  }
  return secret || "vinculato-local-signup-secret";
}

export function normalizeSignupEmail(value: unknown) {
  const email = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw ApiError.badRequest("Informe um e-mail válido.", "INVALID_EMAIL");
  }
  return email;
}

export function validateSignupPassword(value: unknown) {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 200) {
    throw ApiError.badRequest("A senha deve ter entre 8 e 200 caracteres.", "INVALID_PASSWORD");
  }
  return password;
}

export function cleanSignupName(value: unknown, field: "person" | "workspace") {
  const limit = field === "person" ? 120 : 160;
  const result = String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit);
  if (result.length < 2) {
    throw ApiError.badRequest(
      field === "person" ? "Informe seu nome." : "Informe o nome da organização.",
      field === "person" ? "NAME_REQUIRED" : "WORKSPACE_NAME_REQUIRED",
    );
  }
  return result;
}

export function requireLegalAcceptance(terms: unknown, privacy: unknown) {
  if (terms !== true || privacy !== true) {
    throw ApiError.badRequest("Aceite os Termos de Uso e a Política de Privacidade para continuar.", "LEGAL_ACCEPTANCE_REQUIRED");
  }
  return {
    termsVersion: String(process.env.FDP_TERMS_VERSION ?? "2026-09-03").slice(0, 40),
    privacyVersion: String(process.env.FDP_PRIVACY_VERSION ?? "2026-09-03").slice(0, 40),
  };
}

export function createSignupConfirmationToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashSignupConfirmationToken(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString() };
}

export function createSignupProvisioningIds() {
  return {
    requestId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    boardId: crypto.randomUUID(),
  };
}

export function hashSignupConfirmationToken(token: string) {
  return createHash("sha256").update(`${signupSecret()}:${token}`).digest("hex");
}

export function signupRequestFingerprint(email: string, address: string) {
  return createHmac("sha256", signupSecret()).update(`signup:${email}:${address}`).digest("hex");
}

export function requireSelfSignupEnabled(enabled: boolean) {
  if (!enabled) {
    throw new ApiError(503, "SELF_SIGNUP_DISABLED", "O cadastro gratuito está temporariamente indisponível.");
  }
}

/** A posse do token é a autorização da rota pública de confirmação. */
export function requireSignupConfirmationRequest(value: unknown) {
  const token = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{40,80}$/u.test(token)) {
    throw ApiError.badRequest("Este link de confirmação expirou ou já foi utilizado.", "SIGNUP_TOKEN_INVALID");
  }
  return token;
}

export const signupTokenTtlHours = TOKEN_TTL_MS / (60 * 60 * 1000);
