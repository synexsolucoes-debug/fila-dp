import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function secretMaterial() {
  const value = process.env.FDP_INTEGRATION_ENCRYPTION_KEY || process.env.FDP_AUTH_SECRET || "";
  if (!value) throw new Error("Defina FDP_INTEGRATION_ENCRYPTION_KEY para proteger as credenciais externas.");
  return createHmac("sha256", value).update("fila-dp-integrations-v1").digest();
}

export function encryptSecret(payload: Record<string, unknown>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretMaterial(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret<T extends Record<string, unknown>>(value: string): T {
  const [version, ivValue, tagValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("Credencial externa inválida.");
  const decipher = createDecipheriv("aes-256-gcm", secretMaterial(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const clear = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(clear) as T;
}

export function createSignedState(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secretMaterial()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function readSignedState<T extends { exp?: number }>(state: string): T {
  const [encoded, signature] = state.split(".");
  const expected = encoded ? createHmac("sha256", secretMaterial()).update(encoded).digest("base64url") : "";
  if (!encoded || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Estado OAuth inválido.");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("A autorização expirou. Tente novamente.");
  return payload;
}

