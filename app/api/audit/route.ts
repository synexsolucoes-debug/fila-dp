import { ApiError, apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await getApiUser();
    if (!auth.user) return auth.response;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "audit.read");

    const search = new URL(request.url).searchParams;
    const limitValue = Number(search.get("limit") ?? 50);
    if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) {
      throw ApiError.badRequest("O limite deve estar entre 1 e 100.", "INVALID_AUDIT_LIMIT");
    }
    const before = search.get("before");
    if (before && Number.isNaN(new Date(before).getTime())) {
      throw ApiError.badRequest("Cursor de auditoria inválido.", "INVALID_AUDIT_CURSOR");
    }
    const entityType = text(search.get("entityType"), 80);
    const action = text(search.get("action"), 120);
    const clauses = ["workspace_id = ?"];
    const parameters: unknown[] = [workspace.id];
    if (before) { clauses.push("created_at < ?"); parameters.push(before); }
    if (entityType) { clauses.push("entity_type = ?"); parameters.push(entityType); }
    if (action) { clauses.push("action = ?"); parameters.push(action); }
    parameters.push(limitValue);

    const result = await d1.prepare(`SELECT id, actor_type, actor_user_id, actor_email, action, outcome,
        entity_type, entity_id, before_json, after_json, metadata_json, request_id, created_at
      FROM fdp_audit_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`)
      .bind(...parameters)
      .all<Record<string, unknown>>();

    return Response.json({
      events: result.results.map((row) => ({
        id: String(row.id),
        actorType: String(row.actor_type),
        actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
        actorEmail: String(row.actor_email),
        action: String(row.action),
        outcome: String(row.outcome),
        entityType: String(row.entity_type),
        entityId: row.entity_id ? String(row.entity_id) : null,
        before: row.before_json ?? {},
        after: row.after_json ?? {},
        metadata: row.metadata_json ?? {},
        requestId: row.request_id ? String(row.request_id) : null,
        createdAt: String(row.created_at),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
