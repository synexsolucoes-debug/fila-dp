import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { verifyIntegration } from "@/lib/integration-engine";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");
    const result = await verifyIntegration(d1, workspace.id, id);
    await prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.connection_verified", entityType: "integration", entityId: id,
      after: { connected: true, verifiedAt: result.verifiedAt }, requestId: request.headers.get("x-fila-dp-request-id") }).run();
    return Response.json(result);
  } catch (error) { return apiError(error); }
}
