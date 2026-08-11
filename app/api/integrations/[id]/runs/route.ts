import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { queueIntegrationRun } from "@/lib/integration-engine";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.run");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const idempotencyKey = text(request.headers.get("idempotency-key") ?? body.idempotencyKey, 180) || `manual:${crypto.randomUUID()}`;
    const run = await queueIntegrationRun(d1, { workspaceId: workspace.id, integrationId: id, mappingId: text(body.mappingId, 120) || undefined, triggerType: "manual", requestedBy: user.id, idempotencyKey });
    await prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.run_queued", entityType: "integration_run", entityId: String(run.id),
      after: { integrationId: id, mappingId: run.mapping_id, triggerType: "manual", status: run.status }, metadata: { idempotencyKey }, requestId: request.headers.get("x-fila-dp-request-id") }).run();
    return Response.json({ run }, { status: 202 });
  } catch (error) { return apiError(error); }
}
