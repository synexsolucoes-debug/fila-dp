import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { parseEventTypes } from "@/lib/outbox";
import { cleanText } from "@/lib/registrations";

type Params = { params: Promise<{ id: string }> };

/** Detalhe com as últimas entregas: o cliente precisa ver o que falhou e por quê. */
export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");
    const endpoint = await d1.prepare(`SELECT id, name, url, event_types_json, status, failure_count FROM fdp_webhook_endpoints
      WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!endpoint) throw ApiError.notFound("Endpoint não encontrado.", "WEBHOOK_ENDPOINT_NOT_FOUND");
    const deliveries = await d1.prepare(`SELECT id, event_id, event_type, status, attempt, max_attempts, response_status, error_code,
        next_attempt_at, delivered_at, updated_at
      FROM fdp_webhook_deliveries WHERE workspace_id = ? AND endpoint_id = ? ORDER BY updated_at DESC LIMIT 50`)
      .bind(workspace.id, id).all<Record<string, unknown>>();
    return Response.json({ endpoint, deliveries: deliveries.results });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");

    const current = await d1.prepare("SELECT id, status, event_types_json FROM fdp_webhook_endpoints WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ id: string; status: string; event_types_json: unknown }>();
    if (!current) throw ApiError.notFound("Endpoint não encontrado.", "WEBHOOK_ENDPOINT_NOT_FOUND");

    const status = ["active", "paused", "disabled"].includes(cleanText(body.status, 20)) ? cleanText(body.status, 20) : String(current.status);
    const eventTypes = Object.hasOwn(body, "eventTypes")
      ? parseEventTypes(body.eventTypes)
      : (Array.isArray(current.event_types_json) ? current.event_types_json : JSON.parse(String(current.event_types_json || "[]")));

    await d1.batch([
      d1.prepare(`UPDATE fdp_webhook_endpoints SET status = ?, event_types_json = ?::jsonb, name = COALESCE(NULLIF(?, ''), name), updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(status, JSON.stringify(eventTypes), cleanText(body.name, 120), workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "webhook_endpoint.updated", entityType: "webhook_endpoint", entityId: id,
        before: { status: current.status }, after: { status, eventTypes },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ endpoint: { id, status, eventTypes } });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");
    const disabled = await d1.prepare(`UPDATE fdp_webhook_endpoints SET status = 'disabled', updated_at = now()
      WHERE workspace_id = ? AND id = ? AND status <> 'disabled' RETURNING id`).bind(workspace.id, id).first();
    if (!disabled) throw ApiError.notFound("Endpoint não encontrado ou já desativado.", "WEBHOOK_ENDPOINT_NOT_FOUND");
    await d1.batch([
      // Entregas ainda não enviadas de um endpoint desativado não devem ser tentadas.
      d1.prepare("UPDATE fdp_webhook_deliveries SET status = 'canceled', updated_at = now() WHERE workspace_id = ? AND endpoint_id = ? AND status IN ('pending', 'failed')")
        .bind(workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "webhook_endpoint.disabled", entityType: "webhook_endpoint", entityId: id,
        after: { status: "disabled" },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ endpoint: { id, status: "disabled" } });
  } catch (error) { return apiError(error); }
}
