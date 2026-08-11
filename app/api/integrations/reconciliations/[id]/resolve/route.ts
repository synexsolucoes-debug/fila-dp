import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.reconcile");
    const body = await request.json() as Record<string, unknown>;
    const resolution = String(body.resolution ?? "");
    if (!["link", "accept_external", "keep_internal", "ignore"].includes(resolution)) throw ApiError.badRequest("Resolução inválida.", "RECONCILIATION_RESOLUTION_INVALID");
    const note = text(body.note, 500);
    if (!note) throw ApiError.badRequest("Registre uma justificativa para a conciliação.", "RECONCILIATION_NOTE_REQUIRED");
    const internalId = resolution === "link" ? text(body.internalId, 160) : "";
    if (resolution === "link" && !internalId) throw ApiError.badRequest("Informe o registro interno que será vinculado.", "RECONCILIATION_INTERNAL_ID_REQUIRED");
    const resolved = await d1.prepare(`WITH updated AS (
        UPDATE fdp_integration_reconciliations SET status = CASE WHEN ? = 'ignore' THEN 'ignored' ELSE 'resolved' END,
          resolution = ?, resolution_note = ?, internal_id = CASE WHEN ? <> '' THEN ? ELSE internal_id END,
          resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ? AND status IN ('unmatched', 'conflict') RETURNING *
      ), item_updated AS (
        UPDATE fdp_integration_sync_items item SET status = CASE WHEN updated.status = 'ignored' THEN 'skipped' ELSE 'processed' END,
          target_id = CASE WHEN updated.internal_id <> '' THEN updated.internal_id ELSE item.target_id END, processed_at = CURRENT_TIMESTAMP
        FROM updated WHERE item.workspace_id = updated.workspace_id AND item.id = updated.item_id RETURNING item.id
      ), audited AS (
        INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, after_json, metadata_json, request_id)
        SELECT ?, ?, ?, ?, 'integration.reconciliation_resolved', 'integration_reconciliation', updated.id,
          jsonb_build_object('status', updated.status, 'resolution', updated.resolution, 'internalIdProvided', updated.internal_id <> ''),
          jsonb_build_object('noteProvided', true, 'differencesOmitted', true), ? FROM updated RETURNING id
      ) SELECT id, integration_id, run_id, item_id, entity_type, status, resolution, internal_id, resolved_at FROM updated`)
      .bind(resolution, resolution, note, internalId, internalId, user.id, workspace.id, id,
        crypto.randomUUID(), workspace.id, user.id, auth.user.email, request.headers.get("x-fila-dp-request-id"))
      .first<Record<string, unknown>>();
    if (!resolved) throw ApiError.notFound("Conciliação pendente não encontrada.", "RECONCILIATION_NOT_FOUND");
    return Response.json(resolved);
  } catch (error) { return apiError(error); }
}
