import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { ApiError } from "./api-errors.ts";
import { validateIntegrationEndpoint } from "./integration-security.ts";
import { validateSolidesEndpoint } from "./solides.ts";
import { validateTangerinoEndpoint } from "./tangerino.ts";

export const integrationChannels = ["email", "whatsapp", "teams", "drive", "onedrive", "solides", "tangerino", "erp"] as const;
export type IntegrationChannel = typeof integrationChannels[number];
export const integrationResources = ["inbox", "employees", "hr_metrics", "files", "admissions"] as const;
export type IntegrationResource = typeof integrationResources[number];

const allowedCredentialKeys: Record<IntegrationChannel, ReadonlySet<string>> = {
  email: new Set(["token", "apiKey", "clientId", "clientSecret", "tenantId", "refreshToken"]),
  whatsapp: new Set(["token", "apiKey", "phoneNumberId"]),
  teams: new Set(["token", "clientId", "clientSecret", "tenantId", "refreshToken"]),
  drive: new Set(["token", "apiKey", "clientId", "clientSecret", "refreshToken", "serviceAccount"]),
  onedrive: new Set(["token", "clientId", "clientSecret", "tenantId", "refreshToken"]),
  solides: new Set(["token", "apiKey", "clientId", "clientSecret", "refreshToken"]),
  tangerino: new Set(["token", "apiKey"]),
  erp: new Set(["token", "apiKey", "clientId", "clientSecret", "xToken"]),
};

const safeFieldName = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u;
const transforms = new Set(["identity", "trim", "uppercase", "lowercase", "date", "number", "integer", "boolean"]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
}

export function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function parseChannel(value: unknown): IntegrationChannel {
  const channel = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!integrationChannels.includes(channel as IntegrationChannel)) throw ApiError.badRequest("Conector não suportado.", "INTEGRATION_CHANNEL_INVALID");
  return channel as IntegrationChannel;
}

function decodeVaultKey(raw: string) {
  const value = raw.trim();
  const key = /^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new ApiError(500, "VAULT_KEY_INVALID", "O cofre de credenciais não está configurado corretamente.");
  return key;
}

function vaultKeys() {
  const result = new Map<number, Buffer>();
  const configured = process.env.FDP_INTEGRATION_VAULT_KEYS;
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as Record<string, unknown>;
      for (const [version, raw] of Object.entries(parsed)) {
        const numericVersion = Number(version);
        if (Number.isInteger(numericVersion) && numericVersion > 0 && typeof raw === "string") result.set(numericVersion, decodeVaultKey(raw));
      }
    } catch {
      throw new ApiError(500, "VAULT_KEYS_INVALID", "O cofre de credenciais não está configurado corretamente.");
    }
  }
  if (!result.size && process.env.FDP_INTEGRATION_VAULT_KEY) result.set(1, decodeVaultKey(process.env.FDP_INTEGRATION_VAULT_KEY));
  // Nomear a variável é o que transforma "não salva" em algo acionável: quem vê
  // esta mensagem administra integrações e precisa saber o que falta no deployment.
  if (!result.size) throw new ApiError(503, "VAULT_NOT_CONFIGURED", "Cofre de credenciais não configurado neste deployment: defina FDP_INTEGRATION_VAULT_KEY (chave AES-256 em base64) e publique novamente antes de guardar segredos.");
  return result;
}

/** Returns the active vault key so other domains can seal secrets with the same rotation policy. */
export function currentVaultKey() {
  const keys = vaultKeys();
  const requested = Number(process.env.FDP_INTEGRATION_VAULT_KEY_VERSION || Math.max(...keys.keys()));
  const key = keys.get(requested);
  if (!key) throw new ApiError(500, "VAULT_KEY_VERSION_MISSING", "A versão ativa do cofre não está disponível.");
  return { key, version: requested };
}

/** Returns a previously used vault key so sealed payloads survive key rotation. */
export function vaultKeyByVersion(version: number) {
  const key = vaultKeys().get(version);
  if (!key) throw new ApiError(500, "VAULT_KEY_VERSION_MISSING", "A chave necessária para abrir o dado protegido não está disponível.");
  return key;
}

export function sanitizeCredentials(channelValue: unknown, value: unknown) {
  const channel = parseChannel(channelValue);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw ApiError.badRequest("Informe as credenciais do conector.", "CREDENTIALS_REQUIRED");
  const source = value as Record<string, unknown>;
  const allowed = allowedCredentialKeys[channel];
  const entries = Object.entries(source);
  if (!entries.length || entries.length > 12) throw ApiError.badRequest("Informe ao menos uma credencial válida.", "CREDENTIALS_INVALID");
  const sanitized: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!allowed.has(key) || typeof raw !== "string") throw ApiError.badRequest(`O campo de credencial ${key} não é aceito para este conector.`, "CREDENTIAL_FIELD_INVALID");
    const secret = raw.trim();
    if (secret.length < 8 || secret.length > 16_000) throw ApiError.badRequest(`A credencial ${key} possui tamanho inválido.`, "CREDENTIAL_VALUE_INVALID");
    sanitized[key] = secret;
  }
  if (Buffer.byteLength(stableJson(sanitized), "utf8") > 32 * 1024) throw ApiError.badRequest("O conjunto de credenciais excede 32 KB.", "CREDENTIALS_TOO_LARGE");
  return { channel, credentials: sanitized };
}

export function sealCredentials(channelValue: unknown, value: unknown) {
  const { channel, credentials } = sanitizeCredentials(channelValue, value);
  const plaintext = stableJson(credentials);
  const { key, version } = currentVaultKey();
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  cipher.setAAD(Buffer.from(`fila-dp:${channel}:v${version}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const fingerprint = createHmac("sha256", key).update(`${channel}:${plaintext}`).digest("hex");
  return {
    encryptedValue: encrypted.toString("base64"),
    initializationVector: initializationVector.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: version,
    fingerprint,
  };
}

export function openCredentials(channelValue: unknown, sealed: { encryptedValue: string; initializationVector: string; authTag: string; keyVersion: number }) {
  const channel = parseChannel(channelValue);
  const key = vaultKeys().get(sealed.keyVersion);
  if (!key) throw new ApiError(500, "VAULT_KEY_VERSION_MISSING", "A chave necessária para abrir a credencial não está disponível.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.initializationVector, "base64"));
    decipher.setAAD(Buffer.from(`fila-dp:${channel}:v${sealed.keyVersion}`, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.encryptedValue, "base64")), decipher.final()]).toString("utf8");
    return sanitizeCredentials(channel, JSON.parse(plaintext)).credentials;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "CREDENTIAL_DECRYPTION_FAILED", "Não foi possível abrir a credencial armazenada.");
  }
}

export type MappingField = { source: string; target: string; transform: string; required: boolean };
export function sanitizeMapping(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw ApiError.badRequest("Mapeamento inválido.", "MAPPING_INVALID");
  const source = value as Record<string, unknown>;
  const rawFields = Array.isArray(source.fields) ? source.fields : [];
  if (!rawFields.length || rawFields.length > 80) throw ApiError.badRequest("O mapeamento deve possuir entre 1 e 80 campos.", "MAPPING_FIELDS_INVALID");
  const fields: MappingField[] = rawFields.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw ApiError.badRequest("Campo de mapeamento inválido.", "MAPPING_FIELD_INVALID");
    const field = raw as Record<string, unknown>;
    const sourceField = typeof field.source === "string" ? field.source.trim() : "";
    const target = typeof field.target === "string" ? field.target.trim() : "";
    const transform = typeof field.transform === "string" ? field.transform.trim() : "identity";
    if (!safeFieldName.test(sourceField) || !safeFieldName.test(target) || !transforms.has(transform)) throw ApiError.badRequest("O mapeamento contém nomes ou transformações inválidas.", "MAPPING_FIELD_INVALID");
    return { source: sourceField, target, transform, required: field.required === true };
  });
  const externalIdField = typeof source.externalIdField === "string" ? source.externalIdField.trim() : "id";
  if (!safeFieldName.test(externalIdField)) throw ApiError.badRequest("Campo de identificador externo inválido.", "MAPPING_EXTERNAL_ID_INVALID");
  const mapping = { externalIdField, fields };
  return { mapping, checksum: createHash("sha256").update(stableJson(mapping)).digest("hex") };
}

export function mappingResource(value: unknown): IntegrationResource {
  const resource = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!integrationResources.includes(resource as IntegrationResource)) throw ApiError.badRequest("Recurso de integração inválido.", "MAPPING_RESOURCE_INVALID");
  return resource as IntegrationResource;
}

export function mappingDirection(value: unknown) {
  const direction = typeof value === "string" ? value.trim().toLowerCase() : "inbound";
  if (!["inbound", "outbound", "bidirectional"].includes(direction)) throw ApiError.badRequest("Direção de integração inválida.", "MAPPING_DIRECTION_INVALID");
  return direction as "inbound" | "outbound" | "bidirectional";
}

export function validateConnectorEndpoint(channel: string, value: unknown) {
  if (channel === "solides") return validateSolidesEndpoint(value);
  if (channel === "tangerino") return validateTangerinoEndpoint(value);
  const endpoint = typeof value === "string" ? value.trim().slice(0, 500) : "";
  if (!endpoint) throw ApiError.badRequest("Configure o endpoint oficial do conector.", "INTEGRATION_ENDPOINT_REQUIRED");
  const upper = channel.toUpperCase();
  const configuredEndpoint = process.env[`FDP_${upper}_ENDPOINT`] ?? "";
  const extraHosts = [process.env.FDP_INTEGRATION_ALLOWED_HOSTS, process.env[`FDP_${upper}_ALLOWED_HOSTS`]].filter(Boolean).join(",");
  return validateIntegrationEndpoint(channel, endpoint, configuredEndpoint, extraHosts);
}

export function publicCredentialFingerprint(value: string) {
  return value ? `sha256:${value.slice(0, 12)}` : "";
}

export function retryDelaySeconds(attempt: number) {
  return Math.min(3600, 30 * (2 ** Math.max(0, attempt - 1)));
}

export function safeIntegrationError(error: unknown) {
  if (error instanceof ApiError) return { code: error.code, message: error.message.slice(0, 500) };
  const raw = error instanceof Error ? error.message : "Falha inesperada no conector.";
  const sanitized = raw
    .replace(/(bearer|token|secret|password|api[_-]?key)\s*[:=]?\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/([?&](?:access_token|api_?key|client_secret|token)=)[^&\s]+/giu, "$1[redacted]")
    .slice(0, 500);
  return { code: "PROVIDER_REQUEST_FAILED", message: sanitized || "Falha inesperada no conector." };
}
