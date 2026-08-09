import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { domainEventTypes, parseEventTypes } from "@/lib/outbox";
import { generateWebhookSecret, sealWebhookSecret, validateWebhookUrl } from "@/lib/webhooks";
import { cleanText } from "@/lib/registrations";

/** Endpoints de saída do workspace. O segredo aparece apenas na criação. */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "integrations.manage");
    const [endpoints, deliveries] = await Promise.all([
      d1.prepare(`SELECT id, name, url, event_types_json, status, failure_count, last_delivery_at, last_failure_at, created_at
        FROM fdp_webhook_endpoints WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50`).bind(workspace.id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT status, count(*)::int AS total FROM fdp_webhook_deliveries WHERE workspace_id = ? GROUP BY status`)
        .bind(workspace.id).all<{ status: string; total: number }>(),
    ]);
    return Response.json({
      endpoints: endpoints.results.map((row) => ({
        id: String(row.id), name: String(row.name), url: String(row.url),
        eventTypes: Array.isArray(row.event_types_json) ? row.event_types_json : JSON.parse(String(row.event_types_json || "[]")),
        status: String(row.status), failureCount: Number(row.failure_count),
        lastDeliveryAt: row.last_delivery_at, lastFailureAt: row.last_failure_at,
      })),
      deliveryTotals: Object.fromEntries(deliveries.results.map((row) => [String(row.status), Number(row.total)])),
      availableEvents: domainEventTypes,
    });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "integrations.manage");

    const name = cleanText(body.name, 120);
    if (!name) throw ApiError.badRequest("Informe um nome para o endpoint.", "WEBHOOK_NAME_REQUIRED");
    const url = validateWebhookUrl(body.url);
    const eventTypes = parseEventTypes(body.eventTypes);
    const secret = generateWebhookSecret();
    const sealed = sealWebhookSecret(secret);
    const id = crypto.randomUUID();

    const duplicate = await d1.prepare("SELECT id FROM fdp_webhook_endpoints WHERE workspace_id = ? AND url = ?").bind(workspace.id, url).first();
    if (duplicate) throw new ApiError(409, "WEBHOOK_URL_CONFLICT", "Já existe um endpoint com esta URL.");

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_webhook_endpoints (id, workspace_id, name, url, secret_encrypted, secret_iv, secret_tag, secret_key_version, event_types_json, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'active', ?)`)
        .bind(id, workspace.id, name, url, sealed.encryptedValue, sealed.initializationVector, sealed.authTag, sealed.keyVersion, JSON.stringify(eventTypes), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "webhook_endpoint.created", entityType: "webhook_endpoint", entityId: id,
        after: { name, url, eventTypes },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ endpoint: { id, name, url, eventTypes, status: "active" }, secret }, { status: 201 });
  } catch (error) { return apiError(error); }
}
