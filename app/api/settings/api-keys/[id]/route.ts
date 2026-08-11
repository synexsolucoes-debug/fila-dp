import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type Params = { params: Promise<{ id: string }> };

/** Revogação imediata: a chave para de autenticar na próxima requisição. */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");

    const revoked = await d1.prepare(`UPDATE fdp_api_keys SET status = 'revoked', revoked_at = now(), revoked_by = ?
      WHERE workspace_id = ? AND id = ? AND status = 'active' RETURNING id, name, prefix`)
      .bind(user.id, workspace.id, id).first<{ id: string; name: string; prefix: string }>();
    if (!revoked) throw ApiError.notFound("Chave não encontrada ou já revogada.", "API_KEY_NOT_FOUND");

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "api_key.revoked", entityType: "api_key", entityId: id,
      before: { status: "active" }, after: { status: "revoked", prefix: revoked.prefix },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ key: { id, status: "revoked" } });
  } catch (error) { return apiError(error); }
}
