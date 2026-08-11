import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { mappingDirection, mappingResource, sanitizeMapping } from "@/lib/integrations";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.status.read");
    const result = await d1.prepare(`SELECT id, resource_type, direction, version, status, mapping_json, checksum, published_at, created_at
      FROM fdp_integration_mappings WHERE workspace_id = ? AND integration_id = ? ORDER BY resource_type, direction, version DESC`).bind(workspace.id, id).all();
    return Response.json({ mappings: result.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");
    const integration = await d1.prepare("SELECT id FROM fdp_integrations WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first();
    if (!integration) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
    const body = await request.json() as Record<string, unknown>;
    const resourceType = mappingResource(body.resourceType);
    const direction = mappingDirection(body.direction);
    const { mapping, checksum } = sanitizeMapping(body.mapping);
    const mappingId = crypto.randomUUID();
    const current = await d1.prepare(`SELECT COALESCE(MAX(version), 0)::integer AS version FROM fdp_integration_mappings
      WHERE workspace_id = ? AND integration_id = ? AND resource_type = ? AND direction = ?`).bind(workspace.id, id, resourceType, direction).first<{ version: number }>();
    const version = Number(current?.version ?? 0) + 1;
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_integration_mappings (id, workspace_id, integration_id, resource_type, direction, version, mapping_json, checksum, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`).bind(mappingId, workspace.id, id, resourceType, direction, version, JSON.stringify(mapping), checksum, user.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.mapping_created", entityType: "integration_mapping", entityId: mappingId,
        after: { integrationId: id, resourceType, direction, version, checksum, mappedFields: mapping.fields.map((field) => field.target) }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ id: mappingId, integrationId: id, resourceType, direction, version, status: "draft", mapping, checksum }, { status: 201 });
  } catch (error) { return apiError(error); }
}
