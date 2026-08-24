import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { queueIntegrationRun } from "@/lib/integration-engine";
import { queueSankhyaRun } from "@/lib/sankhya/queue";
import { ApiError } from "@/lib/api-errors";
import { wakeSankhyaWorker } from "@/lib/sankhya/actions-dispatch";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const idempotencyKey = text(request.headers.get("idempotency-key") ?? body.idempotencyKey, 180) || `manual:${crypto.randomUUID()}`;
    const integration = await d1.prepare("SELECT channel FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ channel: string }>();
    if (!integration) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
    const isSankhya = integration.channel === "sankhya_browser";
    const run = isSankhya
      ? (requireCapability(workspace, "integrations.execute"), await queueSankhyaRun(d1, { workspaceId: workspace.id, integrationId: id, triggerType: "manual", requestedBy: user.id, idempotencyKey }))
      : (requireCapability(workspace, "integrations.run"), await queueIntegrationRun(d1, { workspaceId: workspace.id, integrationId: id, mappingId: text(body.mappingId, 120) || undefined, triggerType: "manual", requestedBy: user.id, idempotencyKey }));
    await prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.run_queued", entityType: "integration_run", entityId: String(run.id),
      after: { integrationId: id, mappingId: run.mapping_id, triggerType: "manual", status: run.status }, metadata: { idempotencyKey }, requestId: request.headers.get("x-fila-dp-request-id") }).run();
    const workerDispatch = isSankhya
      ? await wakeSankhyaWorker({ workspaceId: workspace.id, userId: user.id, connectorId: id, syncRunId: String(run.id) })
      : null;
    return Response.json({ run, workerDispatch: workerDispatch?.status }, { status: 202 });
  } catch (error) { return apiError(error); }
}
