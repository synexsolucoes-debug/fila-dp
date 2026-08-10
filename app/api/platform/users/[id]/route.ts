import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";
import type { WorkspaceRole } from "@/lib/fila-dp-types";

type Params = { params: Promise<{ id: string }> };
const roles: WorkspaceRole[] = ["admin", "member", "observer", "guest"];

/**
 * Administra um usuário global: bloquear, desbloquear, vincular e desvincular
 * de workspaces.
 *
 * Bloquear exige motivo. Nenhuma senha é lida, gravada ou devolvida: a
 * recuperação de acesso continua sendo o único caminho para definir senha.
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const before = await d1.prepare("SELECT id, email, name, status FROM fdp_users WHERE id = ?").bind(id).first<Record<string, unknown>>();
      if (!before) throw ApiError.notFound("Usuário não encontrado.", "USER_NOT_FOUND");

      const statements = [];
      const after: Record<string, unknown> = {};

      if (body.status !== undefined) {
        const status = cleanText(body.status, 20);
        if (!["active", "blocked"].includes(status)) throw ApiError.badRequest("Situação de usuário inválida.", "INVALID_USER_STATUS");
        const reason = cleanText(body.reason, 500);
        if (status === "blocked") {
          if (reason.length < 5) throw ApiError.badRequest("Informe o motivo do bloqueio.", "STATUS_REASON_REQUIRED");
          // Bloquear o último proprietário de um workspace deixaria o cliente
          // sem quem administre o próprio ambiente.
          const owned = await d1.prepare("SELECT count(*)::int AS total FROM fdp_workspaces WHERE owner_user_id = ? AND status = 'active'")
            .bind(id).first<{ total: number }>();
          if (Number(owned?.total ?? 0) > 0) {
            throw new ApiError(409, "OWNER_BLOCK_BLOCKED",
              `Este usuário é proprietário de ${owned?.total} workspace(s) ativo(s). Transfira a propriedade antes de bloquear.`);
          }
          // Sessões abertas caem junto: bloquear precisa ter efeito imediato.
          statements.push(d1.prepare("DELETE FROM fdp_auth_sessions WHERE user_id = ?").bind(id));
        }
        statements.push(d1.prepare("UPDATE fdp_users SET status = ?, status_reason = ?, status_changed_at = now() WHERE id = ?")
          .bind(status, status === "active" ? "" : reason, id));
        after.status = status;
      }

      if (body.workspaceId !== undefined) {
        const workspaceId = cleanText(body.workspaceId, 120);
        const workspace = await d1.prepare("SELECT id, name FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first<{ id: string; name: string }>();
        if (!workspace) throw ApiError.badRequest("Workspace inválido.", "WORKSPACE_NOT_FOUND");
        const action = cleanText(body.membership, 20) || "link";
        if (action === "unlink") {
          const owner = await d1.prepare("SELECT 1 AS owner FROM fdp_workspaces WHERE id = ? AND owner_user_id = ?").bind(workspaceId, id).first();
          if (owner) throw new ApiError(409, "OWNER_UNLINK_BLOCKED", "O proprietário não pode ser removido do próprio workspace. Transfira a propriedade primeiro.");
          statements.push(d1.prepare("DELETE FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, id));
          after.unlinkedFrom = workspace.name;
        } else {
          const role = cleanText(body.role, 20) || "member";
          if (!roles.includes(role as WorkspaceRole)) throw ApiError.badRequest("Papel inválido.", "INVALID_ROLE");
          statements.push(d1.prepare(`INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)
            ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`).bind(workspaceId, id, role));
          after.linkedTo = workspace.name;
          after.role = role;
        }
      }

      if (!statements.length) throw ApiError.badRequest("Nada para alterar.", "EMPTY_UPDATE");

      statements.push(d1.prepare(`INSERT INTO fdp_platform_audit_events
          (id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, request_id)
        VALUES (?, ?, ?, 'platform.user_updated', 'user', ?, ?::jsonb, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), platform.userId, platform.email, id,
          JSON.stringify({ status: before.status }), JSON.stringify(after), request.headers.get("x-fila-dp-request-id") ?? ""));

      await d1.batch(statements);
      return Response.json({ user: { id, email: before.email, ...after } });
    });
  } catch (error) { return apiError(error); }
}
