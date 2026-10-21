import { getScopedD1 } from "@/db";
import { ApiError } from "./api-errors.ts";
import { clientAddress, consumePublicAuthRateLimit } from "./auth-rate-limit.ts";
import { hashPortalToken, parsePortalToken, samePortalHash } from "./contractor-invoice-portal.ts";

export { createPortalToken, hashPortalToken, parsePortalToken, portalExpiryFromDays } from "./contractor-invoice-portal.ts";

/**
 * Portal do colaborador do ERP DP (§4.42): o mesmo desenho do portal do
 * prestador e da ciência de EPI — segredo no link, só o hash no banco, o
 * inquilino tirado do próprio token, limite de tentativas e toda recusa com a
 * mesma resposta.
 */

export function employeePortalUrl(token: string, baseUrl = process.env.FDP_APP_URL ?? "") {
  const base = baseUrl.replace(/\/+$/u, "");
  if (!base) throw new ApiError(500, "APP_URL_NOT_CONFIGURED", "Configure FDP_APP_URL para gerar o link do portal do colaborador.");
  return `${base}/portal/colaborador/${encodeURIComponent(token)}`;
}

export { assertEmployeePortalLinkUsable, employeePortalLinkStatus, portalInstant, type EmployeePortalLinkRow, type EmployeePortalLinkStatus } from "./employee-portal-status.ts";

const genericNotFound = () => ApiError.notFound("Este link não é válido. Confira o endereço recebido ou procure o DP.", "EMPLOYEE_PORTAL_NOT_FOUND");

export type PortalLink = {
  id: string; workspace_id: string; company_id: string; employee_id: string; token_hash: string;
  expires_at: string; revoked_at: string | null; employee_name: string; registration_number: string;
  admission_date: string | Date; termination_date: string | Date | null; employment_status: string; employment_type: string;
  company_name: string;
};

/** Do token à linha do link, com a conexão presa ao inquilino do token. */
export async function resolveEmployeePortal(rawToken: string, request: Request) {
  const parsed = parsePortalToken(rawToken);
  if (!parsed) throw genericNotFound();
  const limit = await consumePublicAuthRateLimit("employee_portal", parsed.secret.slice(0, 32), clientAddress(request));
  if (!limit.allowed) {
    throw new ApiError(429, "EMPLOYEE_PORTAL_RATE_LIMITED", "Muitas tentativas neste link. Aguarde alguns minutos e tente de novo.",
      { retryAfterSeconds: limit.retryAfterSeconds });
  }
  const hash = hashPortalToken(parsed.workspaceId, parsed.secret);
  const d1 = getScopedD1({ workspaceId: parsed.workspaceId });
  const link = await d1.prepare(`SELECT link.id, link.workspace_id, link.company_id, link.employee_id, link.token_hash, link.expires_at, link.revoked_at,
      COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name, e.registration_number, e.admission_date, e.termination_date,
      e.employment_status, e.employment_type, COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name
    FROM fdp_employee_portal_links link
    JOIN fdp_employees e ON e.workspace_id = link.workspace_id AND e.id = link.employee_id
    JOIN fdp_companies c ON c.workspace_id = link.workspace_id AND c.id = link.company_id
    WHERE link.workspace_id = ? AND link.token_hash = ?`).bind(parsed.workspaceId, hash).first<PortalLink>();
  if (!link || !samePortalHash(link.token_hash, hash)) throw genericNotFound();
  return { d1, link };
}
