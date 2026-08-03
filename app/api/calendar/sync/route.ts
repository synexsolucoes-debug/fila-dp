import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { calendarFingerprint, calendarProvider, refreshCalendarTokens, type CalendarTokens } from "@/lib/fila-dp-calendar";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { decryptSecret } from "@/lib/fila-dp-secrets";

async function providerRequest(url: string, token: string, method: string, body: Record<string, unknown>) {
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as { provider?: unknown };
    const provider = calendarProvider(String(body.provider ?? ""));
    if (!provider) return Response.json({ error: "Selecione Google ou Microsoft Calendar." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const connection = await d1.prepare(`SELECT c.id, c.external_calendar_id, c.status, cc.encrypted_payload, cc.token_expires_at
      FROM fdp_calendar_connections c
      LEFT JOIN fdp_calendar_credentials cc ON cc.connection_id = c.id
      WHERE c.workspace_id = ? AND c.user_id = ? AND c.provider = ?`)
      .bind(workspace.id, user.id, provider)
      .first<{ id: string; external_calendar_id: string | null; status: string; encrypted_payload: string | null; token_expires_at: string | null }>();
    if (!connection?.encrypted_payload) return Response.json({ error: "Conecte o calendário antes de sincronizar." }, { status: 409 });

    let tokens = decryptSecret<CalendarTokens>(connection.encrypted_payload);
    if (!connection.token_expires_at || new Date(connection.token_expires_at).getTime() <= Date.now() + 60_000) {
      const refreshed = await refreshCalendarTokens(provider, connection.encrypted_payload, new URL(request.url).origin);
      tokens = refreshed.tokens;
      await d1.prepare("UPDATE fdp_calendar_credentials SET encrypted_payload = ?, token_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE connection_id = ?")
        .bind(refreshed.encryptedPayload, refreshed.expiresAt, connection.id)
        .run();
    }

    const blocks = await d1.prepare("SELECT id, title, start_at, end_at, notes FROM fdp_planner_blocks WHERE workspace_id = ? AND user_id = ? ORDER BY start_at LIMIT 300")
      .bind(workspace.id, user.id)
      .all<{ id: string; title: string; start_at: string; end_at: string; notes: string }>();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const block of blocks.results) {
      const fingerprint = calendarFingerprint(block);
      const link = await d1.prepare("SELECT id, external_event_id, content_fingerprint FROM fdp_calendar_event_links WHERE connection_id = ? AND block_id = ?")
        .bind(connection.id, block.id)
        .first<{ id: string; external_event_id: string; content_fingerprint: string }>();
      if (link?.content_fingerprint === fingerprint) { skipped += 1; continue; }
      const calendarId = connection.external_calendar_id || "primary";
      const eventBody = provider === "google"
        ? { summary: block.title, description: block.notes || "Bloco criado no Fila DP", start: { dateTime: new Date(block.start_at).toISOString() }, end: { dateTime: new Date(block.end_at).toISOString() } }
        : { subject: block.title, body: { contentType: "text", content: block.notes || "Bloco criado no Fila DP" }, start: { dateTime: new Date(block.start_at).toISOString().replace(/Z$/, ""), timeZone: "UTC" }, end: { dateTime: new Date(block.end_at).toISOString().replace(/Z$/, ""), timeZone: "UTC" } };
      const createUrl = provider === "google"
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
        : calendarId === "primary" ? "https://graph.microsoft.com/v1.0/me/events" : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`;
      const updateUrl = link ? (provider === "google" ? `${createUrl}/${encodeURIComponent(link.external_event_id)}` : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(link.external_event_id)}`) : createUrl;
      let response = await providerRequest(updateUrl, tokens.accessToken, link ? "PATCH" : "POST", eventBody);
      if (link && response.status === 404) response = await providerRequest(createUrl, tokens.accessToken, "POST", eventBody);
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || !payload.id) throw new Error(String((payload.error as { message?: string } | undefined)?.message ?? `O calendário respondeu com status ${response.status}.`));
      await d1.prepare(`INSERT INTO fdp_calendar_event_links (id, connection_id, block_id, external_event_id, content_fingerprint, last_synced_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(connection_id, block_id) DO UPDATE SET external_event_id = excluded.external_event_id,
          content_fingerprint = excluded.content_fingerprint, last_synced_at = CURRENT_TIMESTAMP`)
        .bind(link?.id ?? crypto.randomUUID(), connection.id, block.id, String(payload.id), fingerprint)
        .run();
      if (link) updated += 1; else created += 1;
    }
    await d1.prepare("UPDATE fdp_calendar_connections SET status = 'connected', last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(connection.id).run();
    await recordActivity(workspace.id, null, auth.user.email, "calendar.synced", { provider, created, updated, skipped });
    return Response.json(await getWorkspaceSnapshot(auth.user), { headers: { "X-Fila-DP-Calendar-Sync": `${created}:${updated}:${skipped}` } });
  } catch (error) {
    return apiError(error);
  }
}
