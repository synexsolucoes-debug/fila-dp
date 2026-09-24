import { ApiError } from "./api-errors.ts";

/**
 * Link assinado genérico, passo 1: dar ciência da entrega de EPI.
 *
 * O token, o hash e o prazo são exatamente os do portal do prestador
 * (`lib/contractor-invoice-portal.ts`) — mesma primitiva, reaproveitada de
 * propósito. O que muda aqui é só o endereço da página e o que a rota
 * pública faz com o link depois de resolvido.
 */
export { createPortalToken, hashPortalToken, parsePortalToken, samePortalHash, portalExpiryFromDays } from "./contractor-invoice-portal.ts";

export function epiAckLinkUrl(token: string, baseUrl = process.env.FDP_APP_URL ?? "") {
  const base = baseUrl.replace(/\/+$/u, "");
  if (!base) {
    throw new ApiError(500, "APP_URL_NOT_CONFIGURED",
      "Configure FDP_APP_URL para gerar o link de ciência de EPI.");
  }
  return `${base}/portal/epi/${encodeURIComponent(token)}`;
}

export type EpiAckLinkStatus = "active" | "acknowledged" | "revoked" | "expired";

export type EpiAckLinkRow = {
  revoked_at?: string | Date | null;
  acknowledged_at?: string | Date | null;
  expires_at: string | Date;
};

/** Mesma ordem de sobreposição do portal do prestador — revogado > ciente > vencido. */
export function epiAckLinkStatus(row: EpiAckLinkRow, now = new Date()): EpiAckLinkStatus {
  if (row.revoked_at) return "revoked";
  if (row.acknowledged_at) return "acknowledged";
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "active";
}

export function assertEpiAckLinkUsable(row: EpiAckLinkRow, now = new Date()) {
  const status = epiAckLinkStatus(row, now);
  if (status === "active") return;
  if (status === "revoked") {
    throw new ApiError(410, "EPI_ACK_LINK_REVOKED",
      "Este link foi cancelado pela empresa. Procure o DP para receber um novo.");
  }
  if (status === "expired") {
    throw new ApiError(410, "EPI_ACK_LINK_EXPIRED",
      "O prazo deste link terminou. Procure o DP para receber um novo.");
  }
  throw new ApiError(409, "EPI_ACK_LINK_ACKNOWLEDGED",
    "Esta entrega já foi confirmada. Se precisar corrigir, procure o DP.");
}
