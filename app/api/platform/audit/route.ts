import { getD1, getPlatformScopedD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { csvCell, decodePlatformCursor, encodePlatformCursor, platformListLimit, sanitizePlatformValue } from "@/lib/platform-console";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";
type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const url = new URL(request.url);
    const workspaceId = cleanText(url.searchParams.get("workspaceId"), 120);
    const actor = cleanText(url.searchParams.get("actor"), 180).toLowerCase();
    const entity = cleanText(url.searchParams.get("entity"), 80).toLowerCase();
    const action = cleanText(url.searchParams.get("action"), 120).toLowerCase();
    const requestId = cleanText(url.searchParams.get("requestId"), 180);
    const from = cleanText(url.searchParams.get("from"), 30);
    const to = cleanText(url.searchParams.get("to"), 30);
    const csv = url.searchParams.get("format") === "csv";
    const limit = platformListLimit(url.searchParams.get("limit"), csv ? 500 : 40, csv ? 1_000 : 100);
    const cursor = decodePlatformCursor(url.searchParams.get("cursor"));

    return await withPlatformContext(platform, async () => {
      const global = getD1();
      const workspaces = await global.prepare("SELECT id, name FROM fdp_workspaces WHERE (? = '' OR id = ?) ORDER BY name")
        .bind(workspaceId, workspaceId).all<{ id: string; name: string }>();
      if (workspaceId && workspaces.results.length === 0) throw ApiError.badRequest("Workspace informado não existe.", "WORKSPACE_NOT_FOUND");

      const tenantEvents = await Promise.all(workspaces.results.map(async (workspace) => {
        const scoped = getPlatformScopedD1({ workspaceId: workspace.id, userId: platform.userId });
        const filters = ["workspace_id = ?"];
        const values: unknown[] = [workspace.id];
        if (actor) { filters.push("lower(actor_email) LIKE ?"); values.push(`%${actor}%`); }
        if (entity) { filters.push("lower(entity_type) = ?"); values.push(entity); }
        if (action) { filters.push("lower(action) LIKE ?"); values.push(`%${action}%`); }
        if (requestId) { filters.push("request_id = ?"); values.push(requestId); }
        if (from && /^\d{4}-\d{2}-\d{2}/u.test(from)) { filters.push("created_at >= ?::timestamptz"); values.push(from); }
        if (to && /^\d{4}-\d{2}-\d{2}/u.test(to)) { filters.push("created_at < (?::date + INTERVAL '1 day')"); values.push(to); }
        if (cursor) { filters.push("(created_at < ?::timestamptz OR (created_at = ?::timestamptz AND id < ?))"); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }
        const rows = await scoped.prepare(`SELECT id, actor_type, actor_user_id, actor_email, action, outcome,
            entity_type, entity_id, before_json, after_json, metadata_json, request_id, created_at
          FROM fdp_audit_events WHERE ${filters.join(" AND ")}
          ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...values, limit + 1).all<Row>();
        return rows.results.map((row) => ({ ...row, workspace_id: workspace.id, workspace_name: workspace.name, scope: "workspace" }));
      }));

      const platformFilters = ["1 = 1"];
      const platformValues: unknown[] = [];
      if (actor) { platformFilters.push("lower(actor_email) LIKE ?"); platformValues.push(`%${actor}%`); }
      if (entity) { platformFilters.push("lower(entity_type) = ?"); platformValues.push(entity); }
      if (action) { platformFilters.push("lower(action) LIKE ?"); platformValues.push(`%${action}%`); }
      if (requestId) { platformFilters.push("request_id = ?"); platformValues.push(requestId); }
      if (workspaceId) { platformFilters.push("(entity_id = ? OR after_json->>'workspaceId' = ?)"); platformValues.push(workspaceId, workspaceId); }
      if (from && /^\d{4}-\d{2}-\d{2}/u.test(from)) { platformFilters.push("created_at >= ?::timestamptz"); platformValues.push(from); }
      if (to && /^\d{4}-\d{2}-\d{2}/u.test(to)) { platformFilters.push("created_at < (?::date + INTERVAL '1 day')"); platformValues.push(to); }
      if (cursor) { platformFilters.push("(created_at < ?::timestamptz OR (created_at = ?::timestamptz AND id < ?))"); platformValues.push(cursor.createdAt, cursor.createdAt, cursor.id); }
      const platformRows = await global.prepare(`SELECT id, 'platform' AS actor_type, actor_user_id, actor_email, action,
          'success' AS outcome, entity_type, entity_id, before_json, after_json, '{}'::jsonb AS metadata_json,
          request_id, created_at FROM fdp_platform_audit_events WHERE ${platformFilters.join(" AND ")}
          ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...platformValues, limit + 1).all<Row>();

      const events = ([...tenantEvents.flat(), ...platformRows.results.map((row) => ({ ...row, workspace_id: "", workspace_name: "Plataforma", scope: "platform" }))] as Row[])
        .sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)) || text(b.id).localeCompare(text(a.id)))
        .slice(0, limit + 1)
        .map((row) => ({
          id: text(row.id), scope: text(row.scope), workspaceId: text(row.workspace_id), workspaceName: text(row.workspace_name),
          actorType: text(row.actor_type), actorUserId: text(row.actor_user_id), actorEmail: text(row.actor_email),
          action: text(row.action), outcome: text(row.outcome) || "success", entityType: text(row.entity_type), entityId: text(row.entity_id),
          before: sanitizePlatformValue(row.before_json), after: sanitizePlatformValue(row.after_json), metadata: sanitizePlatformValue(row.metadata_json),
          requestId: text(row.request_id), createdAt: text(row.created_at),
        }));
      const page = events.slice(0, limit);
      if (csv) {
        const header = ["horario", "escopo", "workspace", "ator", "tipo_ator", "acao", "resultado", "entidade", "identificador", "request_id", "antes", "depois"];
        const lines = [header.map(csvCell).join(","), ...page.map((event) => [event.createdAt, event.scope, event.workspaceName, event.actorEmail,
          event.actorType, event.action, event.outcome, event.entityType, event.entityId, event.requestId, event.before, event.after].map(csvCell).join(","))];
        return new Response(`\uFEFF${lines.join("\r\n")}`, { headers: {
          "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=auditoria-vinculato.csv", "Cache-Control": "no-store",
        } });
      }
      const next = events.length > limit ? page.at(-1) : null;
      return Response.json({ events: page, nextCursor: encodePlatformCursor(next ? { createdAt: next.createdAt, id: next.id } : null) }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
