import { ApiError } from "./api-errors.ts";

/** Situação do link do portal do colaborador (§4.42). Puro, para os testes e as rotas. */

export type EmployeePortalLinkStatus = "active" | "revoked" | "expired";
export type EmployeePortalLinkRow = { revoked_at?: string | Date | null; expires_at: string | Date };

export function employeePortalLinkStatus(row: EmployeePortalLinkRow, now = new Date()): EmployeePortalLinkStatus {
  if (row.revoked_at) return "revoked";
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "active";
}

/** O portal é consulta contínua: só revogado e vencido fecham a porta. */
export function assertEmployeePortalLinkUsable(row: EmployeePortalLinkRow, now = new Date()) {
  const status = employeePortalLinkStatus(row, now);
  if (status === "revoked") throw new ApiError(410, "EMPLOYEE_PORTAL_REVOKED", "Este link foi cancelado pela empresa. Peça um novo ao DP.");
  if (status === "expired") throw new ApiError(410, "EMPLOYEE_PORTAL_EXPIRED", "O prazo deste link terminou. Peça um novo ao DP.");
}

/** O driver do PostgreSQL devolve `timestamptz` como `Date`: a API manda ISO. */
export function portalInstant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}
