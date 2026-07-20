import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const provider = ["google", "microsoft"].includes(String(body.provider)) ? String(body.provider) : "google";
    const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config as Record<string, unknown> : {};
    if (Object.keys(config).some((key) => /token|password|secret|senha|chave/i.test(key))) return Response.json({ error: "Tokens devem ficar no ambiente seguro." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    await d1.prepare(`INSERT INTO fdp_calendar_connections (id, workspace_id, user_id, provider, status, config_json, external_calendar_id, updated_at)
      VALUES (?, ?, ?, ?, 'needs_credentials', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, provider) DO UPDATE SET status = excluded.status, config_json = excluded.config_json, external_calendar_id = excluded.external_calendar_id, updated_at = CURRENT_TIMESTAMP`).bind(crypto.randomUUID(), workspace.id, user.id, provider, JSON.stringify(config), text(body.externalCalendarId, 180) || null).run();
    await recordActivity(workspace.id, null, auth.user.email, "calendar.connection_updated", { provider });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) { return apiError(error); }
}
