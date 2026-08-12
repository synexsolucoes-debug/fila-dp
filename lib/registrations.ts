import { createHmac } from "node:crypto";
import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";

export { cleanText } from "./clean-text.ts";

export const catalogResources = {
  departments: { table: "fdp_departments", label: "Departamento" },
  positions: { table: "fdp_positions", label: "Cargo" },
  "cost-centers": { table: "fdp_cost_centers", label: "Centro de custo" },
  "work-schedules": { table: "fdp_work_schedules", label: "Jornada" },
} as const;

export type CatalogResource = keyof typeof catalogResources;

export function getCatalogResource(value: string) {
  const resource = catalogResources[value as CatalogResource];
  if (!resource) throw ApiError.notFound("Cadastro auxiliar não encontrado.", "CATALOG_NOT_FOUND");
  return resource;
}

export function optionalDate(value: unknown, required = false) {
  const raw = cleanText(value, 10);
  if (!raw && !required) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T12:00:00Z`))) {
    throw ApiError.badRequest("Informe uma data válida.", "INVALID_DATE");
  }
  return raw;
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

function isValidCpf(digits: string) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
    const remainder = (sum * 10) % 11;
    return (remainder === 10 ? 0 : remainder) === Number(digits[length]);
  };
  return check(9) && check(10);
}

export function protectCpf(value: unknown) {
  const digits = cleanText(value, 20).replace(/\D/g, "");
  if (!digits) return { cpfHash: "", cpfLast4: "" };
  if (!isValidCpf(digits)) throw ApiError.badRequest("CPF inválido.", "INVALID_CPF");
  const secret = process.env.FDP_PII_HASH_SECRET ?? process.env.FDP_AUTH_SECRET;
  if (!secret) throw new Error("Defina FDP_PII_HASH_SECRET para proteger identificadores pessoais.");
  return {
    cpfHash: createHmac("sha256", secret).update(`cpf:${digits}`).digest("hex"),
    cpfLast4: digits.slice(-4),
  };
}

export function publicEmployee<T extends Record<string, unknown>>(employee: T) {
  const safe: Record<string, unknown> = { ...employee };
  delete safe.cpf_hash;
  return safe;
}
