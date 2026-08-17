import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";

export const areaModuleKeys = ["epi.owner", "epi.discount_analysis"] as const;
export type AreaModuleKey = typeof areaModuleKeys[number];

export function areaCode(value: unknown) {
  const code = cleanText(value, 40).toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!code) throw ApiError.badRequest("Informe um código válido para a área.", "AREA_CODE_REQUIRED");
  return code;
}

export function areaName(value: unknown) {
  const name = cleanText(value, 120);
  if (!name) throw ApiError.badRequest("Informe o nome da área.", "AREA_NAME_REQUIRED");
  return name;
}

export function areaModuleList(value: unknown, catalogKeys: readonly string[] = []): string[] {
  if (!Array.isArray(value)) return [];
  const result = [...new Set(value.map((item) => cleanText(item, 60)))];
  const allowed = new Set<string>([...areaModuleKeys, ...catalogKeys]);
  const invalid = result.find((item) => !allowed.has(item));
  if (invalid) throw ApiError.badRequest(`Roteamento de módulo inválido: ${invalid}.`, "AREA_MODULE_INVALID");
  return result;
}

export async function resolveAreaModule(
  d1: { prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } } },
  workspaceId: string,
  moduleKey: AreaModuleKey,
) {
  const area = await d1.prepare(`SELECT a.id, a.name, a.code FROM fdp_area_module_assignments ma
    JOIN fdp_areas a ON a.workspace_id = ma.workspace_id AND a.id = ma.area_id
    WHERE ma.workspace_id = ? AND ma.module_key = ? AND a.status = 'active'`)
    .bind(workspaceId, moduleKey).first<{ id: string; name: string; code: string }>();
  if (!area) {
    const label = moduleKey === "epi.owner" ? "responsável pelo EPI/SESMT" : "responsável pela análise do DP";
    throw ApiError.badRequest(
      `Configure uma área ativa como ${label} em Cadastros > Áreas antes de continuar.`,
      "AREA_MODULE_NOT_CONFIGURED",
    );
  }
  return area;
}

export async function validateActiveAreaIds(
  d1: { prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } } },
  workspaceId: string,
  values: readonly (string | null)[],
) {
  const ids = [...new Set(values.filter((value): value is string => Boolean(value)))];
  if (!ids.length) return;
  const found = await d1.prepare(`SELECT id FROM fdp_areas WHERE workspace_id = ? AND status = 'active' AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(workspaceId, ...ids).all<{ id: string }>();
  if (found.results.length !== ids.length) throw ApiError.badRequest("Uma das áreas informadas não existe ou está inativa.", "AREA_NOT_ACTIVE");
}
