import { getD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requiredPlatformReason, sanitizePlatformValue } from "@/lib/platform-console";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";

type Row = Record<string, unknown>;
const operations = new Set(["block", "unblock", "revoke_sessions"]);

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const body = await request.json() as Row;
    const userIds = Array.isArray(body.userIds) ? [...new Set(body.userIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 120))].slice(0, 50) : [];
    const operation = typeof body.operation === "string" ? body.operation : "";
    if (!userIds.length) throw ApiError.badRequest("Selecione ao menos uma identidade.", "BULK_USERS_REQUIRED");
    if (!operations.has(operation)) throw ApiError.badRequest("Ação em massa inválida.", "INVALID_BULK_OPERATION");

    return await withPlatformContext(platform, async () => {
      const d1 = getD1(); const placeholders = userIds.map(() => "?").join(",");
      const rows = await d1.prepare(`SELECT users.id, users.email, users.name, users.status,
          (SELECT count(*)::int FROM fdp_workspaces workspace WHERE workspace.owner_user_id = users.id AND workspace.status = 'active') AS owned_active_workspaces
        FROM fdp_users users WHERE users.id IN (${placeholders}) ORDER BY users.email`).bind(...userIds).all<Row>();
      if (rows.results.length !== userIds.length) throw ApiError.badRequest("A seleção contém identidade inexistente.", "BULK_USER_NOT_FOUND");
      const blockers = operation === "block" ? rows.results.filter((row) => Number(row.owned_active_workspaces) > 0 || String(row.id) === platform.userId) : [];
      const preview = { operation, selected: rows.results.length, affected: rows.results.map((row) => ({ id: row.id, email: row.email, status: row.status })), blockers: blockers.map((row) => ({ id: row.id, email: row.email, reason: String(row.id) === platform.userId ? "operador atual" : "proprietário de workspace ativo" })) };
      if (body.preview === true) return Response.json(sanitizePlatformValue(preview));
      if (body.confirmed !== true) throw ApiError.badRequest("Confirme explicitamente a ação em massa.", "PLATFORM_CONFIRMATION_REQUIRED");
      const reason = requiredPlatformReason(body.reason);
      if (blockers.length) throw new ApiError(409, "BULK_OPERATION_BLOCKED", `A operação possui ${blockers.length} identidade(s) protegida(s). Transfira a propriedade ou remova o operador atual da seleção.`);
      const requestId = request.headers.get("x-fila-dp-request-id") ?? "";
      const statements = rows.results.flatMap((row) => {
        const id = String(row.id); const before = sanitizePlatformValue({ status: row.status });
        const after = operation === "block" ? { status: "blocked", sessions: "revoked", reason } : operation === "unblock" ? { status: "active", reason } : { status: row.status, sessions: "revoked", reason };
        const mutation = operation === "block"
          ? d1.prepare("UPDATE fdp_users SET status = 'blocked', status_reason = ?, status_changed_at = now() WHERE id = ?").bind(reason, id)
          : operation === "unblock"
            ? d1.prepare("UPDATE fdp_users SET status = 'active', status_reason = '', status_changed_at = now() WHERE id = ?").bind(id)
            : d1.prepare("UPDATE fdp_auth_sessions SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL").bind(id);
        const revoke = operation === "block" ? [d1.prepare("UPDATE fdp_auth_sessions SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL").bind(id)] : [];
        const audit = d1.prepare(`INSERT INTO fdp_platform_audit_events
          (id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, request_id)
          VALUES (?, ?, ?, ?, 'user', ?, ?::jsonb, ?::jsonb, ?)`)
          .bind(crypto.randomUUID(), platform.userId, platform.email, `platform.user_bulk_${operation}`, id, JSON.stringify(before), JSON.stringify(sanitizePlatformValue(after)), requestId);
        return [mutation, ...revoke, audit];
      });
      await d1.batch(statements);
      return Response.json({ ok: true, operation, affected: rows.results.length });
    });
  } catch (error) { return apiError(error); }
}
