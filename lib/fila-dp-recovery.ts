import { createHash, randomBytes } from "node:crypto";

function recoverySecret() {
  return process.env.FDP_AUTH_SECRET || (process.env.NODE_ENV === "production" ? "" : "fila-dp-local-recovery-secret");
}

export function createRecoveryToken() {
  const secret = recoverySecret();
  if (!secret) throw new Error("A recuperação de acesso exige FDP_AUTH_SECRET configurado.");
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRecoveryToken(token, secret) };
}

export function hashRecoveryToken(token: string, secret = recoverySecret()) {
  if (!secret) throw new Error("A recuperação de acesso exige FDP_AUTH_SECRET configurado.");
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}
