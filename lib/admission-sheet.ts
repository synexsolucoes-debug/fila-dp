/**
 * O envelope cifrado da ficha de contratação.
 *
 * ## Por que não reusar `sealCredentials`
 *
 * O cofre de `lib/integrations.ts` é de **credencial**: ele valida canal,
 * recusa chave fora da lista permitida e exige tamanho mínimo de segredo. Uma
 * ficha não é credencial — tem quarenta e poucos campos, muitos vazios, e
 * nenhum deles é senha. Passar a ficha por aquela validação exigiria afrouxá-la,
 * e afrouxar validação de credencial para caber outra coisa é como se perde a
 * garantia dos dois lados.
 *
 * O que é reusado é o que deve ser: as **chaves** (`currentVaultKey`,
 * `vaultKeyByVersion`), com rotação e versionamento já resolvidos.
 *
 * ## O dado adicional autenticado separa os dois cofres
 *
 * O AAD daqui é `fila-dp:admission-sheet:v{versão}`, e o de credencial é
 * `fila-dp:{canal}:v{versão}`. Como o AAD entra na verificação da tag do
 * GCM, um envelope de credencial não abre como ficha nem o contrário — mesmo
 * com a mesma chave, mesmo se alguém trocar as linhas de lugar no banco. Sem
 * isso, os dois envelopes seriam intercambiáveis e a separação existiria só no
 * nome da coluna.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "./api-errors.ts";
import { registrationFormFields, type RegistrationFormRaw } from "./employee-registration-form.ts";
import { currentVaultKey, vaultKeyByVersion } from "./integrations.ts";

export { chooseRegistrationFormAttachment, REGISTRATION_FORM_FILENAME } from "./registration-form-file.ts";

export type SealedSheet = {
  encryptedValue: string;
  initializationVector: string;
  authTag: string;
  keyVersion: number;
};

const additionalData = (version: number) => Buffer.from(`fila-dp:admission-sheet:v${version}`, "utf8");

const knownKeys = new Set(registrationFormFields.map((field) => field.key));

/**
 * Só entram chaves do mapa de campos, e só texto.
 *
 * O envelope é escrito a partir de uma leitura de PDF — e leitura de arquivo é
 * entrada não confiável. Sem esta peneira, um documento adulterado poderia
 * enfiar chaves arbitrárias no JSON que a tela depois renderiza.
 */
export function sanitizeSheetFields(value: unknown): RegistrationFormRaw {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.badRequest("Ficha inválida.", "ADMISSION_SHEET_INVALID");
  }
  const fields: RegistrationFormRaw = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!knownKeys.has(key) || typeof raw !== "string") continue;
    const text = raw.replace(/\s+/gu, " ").trim().slice(0, 220);
    if (text) fields[key] = text;
  }
  return fields;
}

/** Ordem estável das chaves: o mesmo conteúdo produz sempre o mesmo texto claro. */
function stableJson(fields: RegistrationFormRaw) {
  return JSON.stringify(Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]])));
}

export function sealSheet(fields: RegistrationFormRaw): SealedSheet {
  const plaintext = stableJson(sanitizeSheetFields(fields));
  const { key, version } = currentVaultKey();
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  cipher.setAAD(additionalData(version));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    encryptedValue: encrypted.toString("base64"),
    initializationVector: initializationVector.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: version,
  };
}

export function openSheet(sealed: SealedSheet): RegistrationFormRaw {
  const key = vaultKeyByVersion(sealed.keyVersion);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.initializationVector, "base64"));
    decipher.setAAD(additionalData(sealed.keyVersion));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.encryptedValue, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return sanitizeSheetFields(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "ADMISSION_SHEET_DECRYPTION_FAILED", "Não foi possível abrir a ficha guardada.");
  }
}

/**
 * Avisos da leitura, sem valor de documento.
 *
 * Eles vão para coluna aberta, então a peneira é o que garante que continuem
 * sendo metadado: os avisos nascem em `registration-form-pdf` e em
 * `employee-registration-form` nomeando **rótulos**, nunca conteúdo. O teto de
 * tamanho e de quantidade existe porque coluna aberta cresce sem ninguém olhar.
 */
export function sanitizeSheetWarnings(value: unknown) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.replace(/\s+/gu, " ").trim().slice(0, 200))
    .filter(Boolean))]
    .slice(0, 60);
}
