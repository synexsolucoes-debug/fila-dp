import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { verifyIntegration } from "@/lib/integration-engine";
import { queueSankhyaRun } from "@/lib/sankhya/queue";
import { wakeSankhyaWorker } from "@/lib/sankhya/actions-dispatch";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const integration = await d1.prepare("SELECT channel FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ channel: string }>();
    if (!integration) return Response.json({ error: "Integração não encontrada." }, { status: 404 });
    if (integration.channel === "sankhya_browser") {
      requireCapability(workspace, "integrations.execute");
      const run = await queueSankhyaRun(d1, { workspaceId: workspace.id, integrationId: id, requestedBy: user.id, triggerType: "health_check", idempotencyKey: `health:${crypto.randomUUID()}` });
      await prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "sankhya.connection_test_queued", entityType: "integration_run", entityId: String(run.id),
        after: { integrationId: id, status: run.status }, requestId: request.headers.get("x-fila-dp-request-id") }).run();
      const workerDispatch = await wakeSankhyaWorker({ workspaceId: workspace.id, userId: user.id, connectorId: id, syncRunId: String(run.id) });
      return Response.json({ queued: true, run, workerDispatch: workerDispatch.status }, { status: 202 });
    }
    requireCapability(workspace, "integrations.manage");
    const result = await verifyIntegration(d1, workspace.id, id);
    await prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.connection_verified", entityType: "integration", entityId: id,
      after: { connected: true, verifiedAt: result.verifiedAt }, requestId: request.headers.get("x-fila-dp-request-id") }).run();
    return Response.json(result);
  } catch (error) { return apiError(error); }
}
