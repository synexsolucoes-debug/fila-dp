import { getD1, getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";

type Params = { params: Promise<{ id: string }> };

/**
 * Detalhe de uma identidade global.
 *
 * Separa deliberadamente as duas coisas que o console misturava: a identidade
 * da pessoa (nome, e-mail, situação, ativação) e **cada associação de
 * workspace**, com o papel daquela associação. Alterar o papel em um grupo não
 * pode ter efeito nos outros.
 *
 * Sessões aparecem sem token e sem endereço completo: dá para revogar sem
 * expor o que identificaria o dispositivo de terceiros.
 */
export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id } = await params;

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const user = await d1.prepare(`SELECT id, email, name, status, status_reason, status_changed_at, created_at,
          (password_hash IS NOT NULL) AS is_activated
        FROM fdp_users WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      if (!user) throw ApiError.notFound("Usuário não encontrado.", "USER_NOT_FOUND");

      const [memberships, sessions, audit] = await Promise.all([
        (async () => {
          const workspaces = await d1.prepare("SELECT id, name, status, owner_user_id FROM fdp_workspaces ORDER BY name").all<Record<string, unknown>>();
          const rows = await Promise.all(workspaces.results.map(async (workspace) => {
            const workspaceId = String(workspace.id);
            const scoped = getPlatformScopedD1({ workspaceId, userId: platform.userId });
            const membership = await scoped.prepare("SELECT role, joined_at FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?")
              .bind(workspaceId, id).first<Record<string, unknown>>();
            return membership ? { ...membership, workspace_id: workspaceId, name: workspace.name, workspace_status: workspace.status, is_owner: String(workspace.owner_user_id) === id } : null;
          }));
          return { results: rows.filter(Boolean) as Record<string, unknown>[] };
        })(),
        d1.prepare(`SELECT id, device_label, created_at, last_seen_at, expires_at
          FROM fdp_auth_sessions
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > now()
          ORDER BY last_seen_at DESC LIMIT 20`).bind(id).all<Record<string, unknown>>(),
        d1.prepare(`SELECT id, actor_email, action, created_at, after_json
          FROM fdp_platform_audit_events
          WHERE entity_type = 'user' AND entity_id = ?
          ORDER BY created_at DESC LIMIT 30`).bind(id).all<Record<string, unknown>>(),
      ]);

      const truthy = (value: unknown) => value === true || value === 1 || value === "t" || value === "true";
      const text = (value: unknown) => (value == null ? "" : String(value));

      return Response.json({
        user: {
          id: text(user.id), email: text(user.email), name: text(user.name),
          status: text(user.status) || "active", statusReason: text(user.status_reason),
          statusChangedAt: user.status_changed_at ? text(user.status_changed_at) : null,
          createdAt: text(user.created_at), isActivated: truthy(user.is_activated),
        },
        memberships: memberships.results.map((row) => ({
          workspaceId: text(row.workspace_id), workspaceName: text(row.name),
          workspaceStatus: text(row.workspace_status) || "active",
          role: text(row.role), joinedAt: text(row.joined_at), isOwner: truthy(row.is_owner),
        })),
        sessions: sessions.results.map((row) => ({
          id: text(row.id), deviceLabel: text(row.device_label) || "Dispositivo",
          createdAt: text(row.created_at), lastSeenAt: text(row.last_seen_at), expiresAt: text(row.expires_at),
        })),
        audit: audit.results.map((row) => ({
          id: text(row.id), actorEmail: text(row.actor_email), action: text(row.action),
          createdAt: text(row.created_at), after: row.after_json ? String(row.after_json).slice(0, 400) : "",
        })),
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
