import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { calendarOAuthConfig, calendarProvider } from "@/lib/fila-dp-calendar";
import { getWorkspaceContext, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { createSignedState } from "@/lib/fila-dp-secrets";

type RouteContext = { params: Promise<{ provider: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { provider: rawProvider } = await context.params;
    const provider = calendarProvider(rawProvider);
    if (!provider) return Response.json({ error: "Provedor não suportado." }, { status: 404 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    let connection = await d1.prepare("SELECT id FROM fdp_calendar_connections WHERE workspace_id = ? AND user_id = ? AND provider = ?")
      .bind(workspace.id, user.id, provider)
      .first<{ id: string }>();
    if (!connection) {
      connection = { id: crypto.randomUUID() };
      await d1.prepare(`INSERT INTO fdp_calendar_connections
        (id, workspace_id, user_id, provider, status, config_json)
        VALUES (?, ?, ?, ?, 'needs_credentials', '{}')`)
        .bind(connection.id, workspace.id, user.id, provider)
        .run();
    }
    const origin = new URL(request.url).origin;
    const config = calendarOAuthConfig(provider, origin);
    const state = createSignedState({ provider, connectionId: connection.id, workspaceId: workspace.id, userId: user.id, exp: Math.floor(Date.now() / 1000) + 10 * 60 });
    const authorization = new URL(config.authorizeUrl);
    authorization.searchParams.set("client_id", config.clientId);
    authorization.searchParams.set("redirect_uri", config.redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", config.scope);
    authorization.searchParams.set("state", state);
    if (provider === "google") {
      authorization.searchParams.set("access_type", "offline");
      authorization.searchParams.set("prompt", "consent");
      authorization.searchParams.set("include_granted_scopes", "true");
    } else {
      authorization.searchParams.set("response_mode", "query");
      authorization.searchParams.set("prompt", "select_account");
    }
    return Response.redirect(authorization);
  } catch (error) {
    return apiError(error);
  }
}

