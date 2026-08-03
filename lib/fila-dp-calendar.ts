import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/fila-dp-secrets";

export type CalendarProvider = "google" | "microsoft";
export type CalendarTokens = { accessToken: string; refreshToken?: string; tokenType?: string; scope?: string };

export function calendarProvider(value: string): CalendarProvider | null {
  return value === "google" || value === "microsoft" ? value : null;
}

export function calendarOAuthConfig(provider: CalendarProvider, origin: string) {
  if (provider === "google") {
    const clientId = process.env.FDP_GOOGLE_CALENDAR_CLIENT_ID ?? "";
    const clientSecret = process.env.FDP_GOOGLE_CALENDAR_CLIENT_SECRET ?? "";
    if (!clientId || !clientSecret) throw new Error("Configure as credenciais OAuth do Google Calendar.");
    return {
      clientId,
      clientSecret,
      redirectUri: `${origin}/api/calendar/oauth/google/callback`,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/calendar.events",
    };
  }
  const clientId = process.env.FDP_MICROSOFT_CALENDAR_CLIENT_ID || process.env.FDP_MICROSOFT_CLIENT_ID || "";
  const clientSecret = process.env.FDP_MICROSOFT_CALENDAR_CLIENT_SECRET || process.env.FDP_MICROSOFT_CLIENT_SECRET || "";
  const tenant = process.env.FDP_MICROSOFT_TENANT_ID || "common";
  if (!clientId || !clientSecret) throw new Error("Configure as credenciais OAuth do Microsoft Calendar.");
  return {
    clientId,
    clientSecret,
    redirectUri: `${origin}/api/calendar/oauth/microsoft/callback`,
    authorizeUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    scope: "offline_access Calendars.ReadWrite",
  };
}

export async function exchangeCalendarCode(provider: CalendarProvider, code: string, origin: string) {
  const config = calendarOAuthConfig(provider, origin);
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirectUri, grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || !payload.access_token) throw new Error(String(payload.error_description ?? payload.error ?? "O provedor recusou a autorização do calendário."));
  return {
    tokens: {
      accessToken: String(payload.access_token),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : undefined,
      tokenType: payload.token_type ? String(payload.token_type) : "Bearer",
      scope: payload.scope ? String(payload.scope) : undefined,
    } satisfies CalendarTokens,
    expiresAt: new Date(Date.now() + Math.max(60, Number(payload.expires_in ?? 3600)) * 1000).toISOString(),
  };
}

export async function refreshCalendarTokens(provider: CalendarProvider, encryptedPayload: string, origin: string) {
  const current = decryptSecret<CalendarTokens>(encryptedPayload);
  if (!current.refreshToken) throw new Error("O provedor não forneceu token de renovação. Reconecte o calendário.");
  const config = calendarOAuthConfig(provider, origin);
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: current.refreshToken, grant_type: "refresh_token", ...(provider === "microsoft" ? { scope: config.scope } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || !payload.access_token) throw new Error(String(payload.error_description ?? payload.error ?? "Não foi possível renovar o calendário."));
  const tokens: CalendarTokens = {
    accessToken: String(payload.access_token),
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : current.refreshToken,
    tokenType: payload.token_type ? String(payload.token_type) : current.tokenType,
    scope: payload.scope ? String(payload.scope) : current.scope,
  };
  return { tokens, encryptedPayload: encryptSecret(tokens), expiresAt: new Date(Date.now() + Math.max(60, Number(payload.expires_in ?? 3600)) * 1000).toISOString() };
}

export function calendarFingerprint(block: { title: string; start_at: string; end_at: string; notes: string }) {
  return createHash("sha256").update(JSON.stringify(block)).digest("hex");
}

