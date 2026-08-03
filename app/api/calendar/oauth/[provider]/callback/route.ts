import { getD1 } from "@/db";
import { getApiUser } from "@/lib/fila-dp-api";
import { calendarProvider, exchangeCalendarCode } from "@/lib/fila-dp-calendar";
import { encryptSecret, readSignedState } from "@/lib/fila-dp-secrets";

type RouteContext = { params: Promise<{ provider: string }> };
type OAuthState = { provider: string; connectionId: string; workspaceId: string; userId: string; exp: number };

function panelRedirect(request: Request, result: "connected" | "error", message?: string) {
  const target = new URL("/painel", request.url);
  target.searchParams.set("calendar", result);
  if (message) target.searchParams.set("calendar_message", message.slice(0, 180));
  return Response.redirect(target);
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return Response.redirect(new URL("/login?return_to=/painel", request.url));
  try {
    const { provider: rawProvider } = await context.params;
    const provider = calendarProvider(rawProvider);
    if (!provider) return panelRedirect(request, "error", "Provedor de calendário inválido.");
    const url = new URL(request.url);
    const providerError = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (providerError) return panelRedirect(request, "error", providerError);
    const code = url.searchParams.get("code") ?? "";
    const state = readSignedState<OAuthState>(url.searchParams.get("state") ?? "");
    if (!code || state.provider !== provider) throw new Error("A resposta do provedor está incompleta.");

    const d1 = getD1();
    const user = await d1.prepare("SELECT id FROM fdp_users WHERE email = ?").bind(auth.user.email.toLowerCase()).first<{ id: string }>();
    if (!user || user.id !== state.userId) throw new Error("A autorização pertence a outro usuário.");
    const connection = await d1.prepare(`SELECT c.id FROM fdp_calendar_connections c
      JOIN fdp_workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = c.user_id
      WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.provider = ?`)
      .bind(state.connectionId, state.workspaceId, state.userId, provider)
      .first<{ id: string }>();
    if (!connection) throw new Error("A conexão de calendário não foi encontrada.");

    const exchanged = await exchangeCalendarCode(provider, code, url.origin);
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_calendar_credentials (connection_id, encrypted_payload, token_expires_at, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(connection_id) DO UPDATE SET encrypted_payload = excluded.encrypted_payload,
          token_expires_at = excluded.token_expires_at, updated_at = CURRENT_TIMESTAMP`)
        .bind(connection.id, encryptSecret(exchanged.tokens), exchanged.expiresAt),
      d1.prepare("UPDATE fdp_calendar_connections SET status = 'connected', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(connection.id),
    ]);
    return panelRedirect(request, "connected");
  } catch (error) {
    console.error("[fila-dp][calendar] oauth-callback", { error: error instanceof Error ? error.message : String(error) });
    return panelRedirect(request, "error", error instanceof Error ? error.message : "Falha ao conectar o calendário.");
  }
}

