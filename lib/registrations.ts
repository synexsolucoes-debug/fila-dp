import { createHmac } from "node:crypto";
import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";

export { cleanText } from "./clean-text.ts";

export const catalogResources = {
  departments: { table: "fdp_departments", label: "Departamento" },
  positions: { table: "fdp_positions", label: "Cargo" },
  "cost-centers": { table: "fdp_cost_centers", label: "Centro de custo" },
  "work-schedules": { table: "fdp_work_schedules", label: "Jornada" },
  unions: { table: "fdp_unions", label: "Sindicato" },
  establishments: { table: "fdp_establishments", label: "Unidade" },
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
  const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(raw) ? new Date(`${raw}T12:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw ApiError.badRequest("Informe uma data válida.", "INVALID_DATE");
  }
  return raw;
}

/** Normaliza `date` do PostgreSQL (texto ou Date) para o contrato HTTP AAAA-MM-DD. */
export function dateFromDatabase(value: unknown, field = "Data") {
  if (value === null || value === undefined || value === "") return null;
  const raw = value instanceof Date
    ? (Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10))
    : String(value).trim().slice(0, 10);
  try {
    return optionalDate(raw, true);
  } catch {
    throw ApiError.badRequest(`${field} inválida.`, "INVALID_DATE");
  }
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

export function isValidCpf(digits: string) {
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

/**
 * Recusa vincular o colaborador a um departamento, cargo, centro de custo ou
 * unidade desativado.
 *
 * `status` sempre existiu nesses quatro cadastros e sempre podia ser desligado
 * pela própria tela de cadastros auxiliares, mas nada no cadastro do
 * colaborador olhava para ele — só a EPI já excluía posição inativa da sua
 * própria checagem (`app/api/epi/dashboard/route.ts`). Um cargo desativado
 * continuava aceitando gente nova.
 *
 * Cada tabela tem sua própria consulta, de propósito: um nome de tabela
 * interpolado no SQL sairia da verificação estática de `verify:sql` (não há
 * como parametrizar identificador), e essa checagem é justamente o que
 * mantém o produto livre de injeção por essa porta.
 *
 * Só valida os campos presentes em `scope`: quem chama decide o que mudou
 * (§4.23) — reenviar o valor antigo de um vínculo já inativo antes desta
 * checagem existir não pode travar uma edição que não mexeu nele.
 */
export async function assertActiveScope(d1: D1Database, workspaceId: string, scope: {
  departmentId?: string | null; positionId?: string | null;
  costCenterId?: string | null; establishmentId?: string | null;
}): Promise<void> {
  if (scope.departmentId) {
    const row = await d1.prepare("SELECT status FROM fdp_departments WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, scope.departmentId).first<{ status: string }>();
    if (row?.status === "inactive") {
      throw new ApiError(422, "EMPLOYEE_DEPARTMENT_INACTIVE", "Este departamento está desativado e não aceita novo vínculo.");
    }
  }
  if (scope.positionId) {
    const row = await d1.prepare("SELECT status FROM fdp_positions WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, scope.positionId).first<{ status: string }>();
    if (row?.status === "inactive") {
      throw new ApiError(422, "EMPLOYEE_POSITION_INACTIVE", "Este cargo está desativado e não aceita novo vínculo.");
    }
  }
  if (scope.costCenterId) {
    const row = await d1.prepare("SELECT status FROM fdp_cost_centers WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, scope.costCenterId).first<{ status: string }>();
    if (row?.status === "inactive") {
      throw new ApiError(422, "EMPLOYEE_COST_CENTER_INACTIVE", "Este centro de custo está desativado e não aceita novo vínculo.");
    }
  }
  if (scope.establishmentId) {
    const row = await d1.prepare("SELECT status FROM fdp_establishments WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, scope.establishmentId).first<{ status: string }>();
    if (row?.status === "inactive") {
      throw new ApiError(422, "EMPLOYEE_ESTABLISHMENT_INACTIVE", "Esta unidade está desativada e não aceita novo vínculo.");
    }
  }
}
