import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { queueIntegrationRun } from "@/lib/integration-engine";

/** Compatibility endpoint: synchronization is now queued and never performs provider I/O in the browser request. */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const channel = text(body.channel, 40).toLowerCase();
    if (!channel) throw ApiError.badRequest("Informe o conector.", "INTEGRATION_CHANNEL_REQUIRED");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.run");
    const integration = await d1.prepare("SELECT id FROM fdp_integrations WHERE workspace_id = ? AND channel = ?").bind(workspace.id, channel).first<{ id: string }>();
    if (!integration) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
    const idempotencyKey = text(request.headers.get("idempotency-key") ?? body.idempotencyKey, 180) || `manual:${crypto.randomUUID()}`;
    const run = await queueIntegrationRun(d1, { workspaceId: workspace.id, integrationId: integration.id, mappingId: text(body.mappingId, 120) || undefined, triggerType: "manual", requestedBy: user.id, idempotencyKey });
    await prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.run_queued", entityType: "integration_run", entityId: String(run.id),
      after: { integrationId: integration.id, channel, mappingId: run.mapping_id, status: run.status }, metadata: { legacyEndpoint: true, idempotencyKey }, requestId: request.headers.get("x-fila-dp-request-id") }).run();
    return Response.json({ queued: true, run }, { status: 202 });
  } catch (error) { return apiError(error); }
}
