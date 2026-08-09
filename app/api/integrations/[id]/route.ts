import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { validateConnectorEndpoint } from "@/lib/integrations";

type Context = { params: Promise<{ id: string }> };
const sensitiveKey = /token|password|secret|senha|chave|authorization|cookie|api.?key/iu;

function hasSensitiveConfig(value: unknown, depth = 0): boolean {
  if (depth > 5) return true;
  if (Array.isArray(value)) return value.some((item) => hasSensitiveConfig(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => sensitiveKey.test(key) || hasSensitiveConfig(item, depth + 1));
}

function safeRequestBody(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw ApiError.badRequest("O corpo configurado deve ser um objeto JSON.", "INTEGRATION_REQUEST_BODY_INVALID");
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024 || hasSensitiveConfig(value)) {
    throw ApiError.badRequest("A configuração contém campos secretos ou excede 16 KB.", "INTEGRATION_CONFIG_UNSAFE");
  }
  return value as Record<string, unknown>;
}

export async function PATCH(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "integrations.manage");
    const current = await d1.prepare("SELECT id, channel, display_name, status, config_json FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
    const body = await request.json() as Record<string, unknown>;
    const channel = String(current.channel);
    const endpointInput = text(body.endpoint, 500);
    const endpoint = endpointInput ? validateConnectorEndpoint(channel, endpointInput) : "";
    const displayName = text(body.displayName, 120) || String(current.display_name);
    const status = body.status === "paused" ? "paused" : "needs_credentials";
    const config = {
      ...(endpoint ? { endpoint } : {}),
      ...(body.requestBody ? { requestBody: safeRequestBody(body.requestBody) } : {}),
      ...(channel === "solides" && text(body.accountReference, 160) ? { accountReference: text(body.accountReference, 160) } : {}),
    };
    await d1.batch([
      d1.prepare("UPDATE fdp_integrations SET display_name = ?, status = ?, config_json = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(displayName, status, JSON.stringify(config), workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.configured", entityType: "integration", entityId: id,
        before: { displayName: current.display_name, status: current.status }, after: { displayName, status, configuredFields: Object.keys(config) }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ id, channel, displayName, status, configuredFields: Object.keys(config) });
  } catch (error) { return apiError(error); }
}
