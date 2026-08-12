import { getD1, getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";
import { decodePlatformCursor, encodePlatformCursor, platformListLimit, requiredPlatformReason } from "@/lib/platform-console";
import { ApiError } from "@/lib/api-errors";
import type { WorkspaceRole } from "@/lib/fila-dp-types";

export const dynamic = "force-dynamic";

/** Usuários globais do SaaS, com os workspaces de cada um. Nenhuma senha é devolvida. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const url = new URL(request.url);
    const query = cleanText(url.searchParams.get("q"), 160).toLowerCase();
    const status = cleanText(url.searchParams.get("status"), 20);
    if (status && !["active", "blocked", "pending", "inactive", "never_accessed"].includes(status)) throw ApiError.badRequest("Filtro de situação inválido.", "INVALID_USER_STATUS_FILTER");
    const limit = platformListLimit(url.searchParams.get("limit"));
    const cursor = decodePlatformCursor(url.searchParams.get("cursor"));

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const filters = ["1 = 1"];
      const values: unknown[] = [];
      if (query) { filters.push("(lower(u.email) LIKE ? OR lower(u.name) LIKE ?)"); values.push(`%${query}%`, `%${query}%`); }
      if (status === "pending") filters.push("(u.password_hash IS NULL OR u.password_hash = '')");
      else if (status === "never_accessed") filters.push("NOT EXISTS (SELECT 1 FROM fdp_auth_sessions session_filter WHERE session_filter.user_id = u.id)");
      else if (status === "inactive") filters.push("EXISTS (SELECT 1 FROM fdp_auth_sessions session_filter WHERE session_filter.user_id = u.id) AND COALESCE((SELECT max(session_filter.last_seen_at) FROM fdp_auth_sessions session_filter WHERE session_filter.user_id = u.id), u.created_at) < now() - interval '90 days'");
      else if (status) { filters.push("u.status = ?"); values.push(status); }
      if (cursor) { filters.push("(u.created_at < ?::timestamptz OR (u.created_at = ?::timestamptz AND u.id < ?))"); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }

      const rows = await d1.prepare(`SELECT u.id, u.email, u.name, u.status, u.status_reason, u.created_at,
          (u.password_hash IS NOT NULL AND u.password_hash <> '') AS has_password,
          (SELECT max(s.last_seen_at) FROM fdp_auth_sessions s WHERE s.user_id = u.id) AS last_seen_at
        FROM fdp_users u WHERE ${filters.join(" AND ")} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`)
        .bind(...values, limit + 1).all<Record<string, unknown>>();
      // A projeção nunca inclui hash nem salt: só se existe senha definida.
      const page = rows.results.slice(0, limit);
      const userIds = page.map((row) => String(row.id));
      const memberships = new Map<string, string[]>();
      if (userIds.length) {
        const workspaces = await d1.prepare("SELECT id, name FROM fdp_workspaces ORDER BY name").all<{ id: string; name: string }>();
        const placeholders = userIds.map(() => "?").join(", ");
        const scopedRows = await Promise.all(workspaces.results.map(async (workspace) => {
          const scoped = getPlatformScopedD1({ workspaceId: workspace.id, userId: platform.userId });
          const result = await scoped.prepare(`SELECT user_id, role FROM fdp_workspace_members
            WHERE workspace_id = ? AND user_id IN (${placeholders})`).bind(workspace.id, ...userIds).all<{ user_id: string; role: string }>();
          return result.results.map((row) => ({ ...row, workspaceName: workspace.name }));
        }));
        for (const membership of scopedRows.flat()) {
          const current = memberships.get(membership.user_id) ?? [];
          current.push(`${membership.workspaceName} (${membership.role})`);
          memberships.set(membership.user_id, current);
        }
      }
      const users: Record<string, unknown>[] = page.map((row): Record<string, unknown> => { const linked = memberships.get(String(row.id)) ?? []; return { ...row, workspaces: linked.length, workspace_names: linked.join(", ") }; });
      const next = rows.results.length > limit ? users.at(-1) : null;
      return Response.json({ users, nextCursor: encodePlatformCursor(next ? { createdAt: String(next.created_at), id: String(next.id) } : null) }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}

const roles: WorkspaceRole[] = ["admin", "member", "observer", "guest"];

/** Cria uma identidade pendente e, opcionalmente, o primeiro vínculo tenant-aware. */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const body = await request.json() as Record<string, unknown>;
    if (body.confirmed !== true) throw ApiError.badRequest("Confirme explicitamente a criação da identidade.", "PLATFORM_CONFIRMATION_REQUIRED");
    const reason = requiredPlatformReason(body.reason);
    const email = cleanText(body.email, 180).toLowerCase();
    const name = cleanText(body.name, 160) || email.split("@")[0] || "Novo usuário";
    const workspaceId = cleanText(body.workspaceId, 120);
    const role = (cleanText(body.role, 20) || "member") as WorkspaceRole;
    if (!/^\S+@\S+\.\S+$/u.test(email)) throw ApiError.badRequest("Informe um e-mail válido.", "USER_EMAIL_INVALID");
    if (!roles.includes(role)) throw ApiError.badRequest("Papel inválido.", "INVALID_ROLE");

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      if (await d1.prepare("SELECT id FROM fdp_users WHERE email = ?").bind(email).first()) {
        throw new ApiError(409, "USER_EMAIL_CONFLICT", "Já existe uma identidade com este e-mail.");
      }
      const workspace = workspaceId
        ? await d1.prepare("SELECT id, name FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first<{ id: string; name: string }>()
        : null;
      if (workspaceId && !workspace) throw ApiError.badRequest("Workspace inválido.", "WORKSPACE_NOT_FOUND");
      const userId = crypto.randomUUID();
      const transaction = workspaceId ? getPlatformScopedD1({ workspaceId, userId: platform.userId }) : d1;
      const statements = workspaceId
        ? [transaction.prepare(`WITH lock AS (
            SELECT pg_advisory_xact_lock(hashtext(?))
          ), entitlement AS (
            SELECT GREATEST(subscription.seat_quantity, plan.included_seats)::integer AS seat_limit
            FROM fdp_workspace_subscriptions subscription JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
            WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
          )
          INSERT INTO fdp_users (id, email, name)
          SELECT ?, ?, ? FROM entitlement
          WHERE (SELECT COUNT(*) FROM fdp_workspace_members WHERE workspace_id = ?) < entitlement.seat_limit`)
          .bind(workspaceId, workspaceId, userId, email, name, workspaceId),
          transaction.prepare(`INSERT INTO fdp_workspace_members (workspace_id, user_id, role)
            SELECT ?, id, ? FROM fdp_users WHERE id = ?`).bind(workspaceId, role, userId)]
        : [transaction.prepare("INSERT INTO fdp_users (id, email, name) VALUES (?, ?, ?)").bind(userId, email, name)];
      statements.push(transaction.prepare(`INSERT INTO fdp_platform_audit_events
          (id, actor_user_id, actor_email, action, entity_type, entity_id, after_json, request_id)
        SELECT ?, ?, ?, 'platform.user_created', 'user', ?, ?::jsonb, ?
        WHERE EXISTS (SELECT 1 FROM fdp_users WHERE id = ?)`)
        .bind(crypto.randomUUID(), platform.userId, platform.email, userId,
          JSON.stringify({ email, name, workspaceId: workspaceId || null, workspaceName: workspace?.name ?? null, role: workspaceId ? role : null, activation: "pending", reason }),
          request.headers.get("x-fila-dp-request-id") ?? "", userId));
      const results = await transaction.batch(statements);
      if (workspaceId && Number(results[0]?.meta?.changes ?? 0) !== 1) {
        throw new ApiError(409, "PLAN_SEAT_LIMIT", "O plano atual atingiu o limite de usuários ou a assinatura não está ativa.");
      }
      return Response.json({ user: { id: userId, email, name, status: "active", activation: "pending", workspaceId: workspaceId || null, role: workspaceId ? role : null } }, { status: 201 });
    });
  } catch (error) { return apiError(error); }
}
