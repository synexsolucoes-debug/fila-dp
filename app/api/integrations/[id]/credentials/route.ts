import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { publicCredentialFingerprint, sealCredentials } from "@/lib/integrations";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");
    const integration = await d1.prepare("SELECT id, channel FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ id: string; channel: string }>();
    if (!integration) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
    const body = await request.json() as { credentials?: unknown; expiresAt?: unknown };
    const sealed = sealCredentials(integration.channel, body.credentials);
    const expiresAt = typeof body.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/u.test(body.expiresAt) ? body.expiresAt : null;
    const credentialId = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`UPDATE fdp_integration_credentials SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, rotated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'`).bind(workspace.id, id),
      d1.prepare(`INSERT INTO fdp_integration_credentials
        (id, workspace_id, integration_id, credential_type, encrypted_value, initialization_vector, auth_tag, key_version, fingerprint, expires_at, created_by)
        VALUES (?, ?, ?, 'provider_auth', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(credentialId, workspace.id, id, sealed.encryptedValue, sealed.initializationVector, sealed.authTag, sealed.keyVersion, sealed.fingerprint, expiresAt, user.id),
      d1.prepare("UPDATE fdp_integrations SET status = 'needs_credentials', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.credential_rotated", entityType: "integration", entityId: id,
        after: { credentialType: "provider_auth", keyVersion: sealed.keyVersion, fingerprint: publicCredentialFingerprint(sealed.fingerprint), expiresAt, secretStored: true }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ credentialId, status: "active", verified: false, keyVersion: sealed.keyVersion, fingerprint: publicCredentialFingerprint(sealed.fingerprint), expiresAt }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");
    const integration = await d1.prepare("SELECT id FROM fdp_integrations WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first();
    if (!integration) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
    await d1.batch([
      d1.prepare("UPDATE fdp_integration_credentials SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND integration_id = ? AND status = 'active'").bind(workspace.id, id),
      d1.prepare("UPDATE fdp_integrations SET status = 'needs_credentials', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?").bind(workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.credential_revoked", entityType: "integration", entityId: id,
        after: { credentialType: "provider_auth", status: "revoked" }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ revoked: true });
  } catch (error) { return apiError(error); }
}
