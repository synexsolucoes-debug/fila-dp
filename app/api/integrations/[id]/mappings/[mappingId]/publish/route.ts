import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type Context = { params: Promise<{ id: string; mappingId: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id, mappingId } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "integrations.manage");
    const published = await d1.prepare(`WITH target AS (
        SELECT id, resource_type, direction, version, checksum FROM fdp_integration_mappings
        WHERE workspace_id = ? AND integration_id = ? AND id = ? AND status = 'draft'
      ), archived AS (
        UPDATE fdp_integration_mappings mapping SET status = 'archived', updated_at = CURRENT_TIMESTAMP
        FROM target WHERE mapping.workspace_id = ? AND mapping.integration_id = ? AND mapping.status = 'active'
          AND mapping.resource_type = target.resource_type AND mapping.direction = target.direction RETURNING mapping.id
      ), activated AS (
        UPDATE fdp_integration_mappings mapping SET status = 'active', published_at = CURRENT_TIMESTAMP, published_by = ?, updated_at = CURRENT_TIMESTAMP
        FROM target WHERE mapping.id = target.id AND (SELECT COUNT(*) FROM archived) >= 0 RETURNING mapping.*
      ), audited AS (
        INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, after_json, metadata_json, request_id)
        SELECT ?, ?, ?, ?, 'integration.mapping_published', 'integration_mapping', activated.id,
          jsonb_build_object('integrationId', activated.integration_id, 'resourceType', activated.resource_type, 'direction', activated.direction, 'version', activated.version, 'checksum', activated.checksum),
          jsonb_build_object('mappingValuesOmitted', true), ? FROM activated RETURNING id
      ) SELECT id, resource_type, direction, version, status, checksum, published_at FROM activated`)
      .bind(workspace.id, id, mappingId, workspace.id, id, user.id, crypto.randomUUID(), workspace.id, user.id, auth.user.email, request.headers.get("x-fila-dp-request-id"))
      .first<Record<string, unknown>>();
    if (!published) throw ApiError.notFound("Mapeamento em rascunho não encontrado.", "MAPPING_DRAFT_NOT_FOUND");
    return Response.json(published);
  } catch (error) { return apiError(error); }
}
