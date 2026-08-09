import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { sanitizeProcessConfiguration } from "@/lib/operations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace.role, "processes.manage");
    if (!await d1.prepare("SELECT id FROM fdp_process_definitions WHERE workspace_id = ? AND id = ? AND status = 'active'").bind(workspace.id, id).first()) throw ApiError.notFound("Processo ativo não encontrado.", "PROCESS_NOT_FOUND");
    const latest = await d1.prepare("SELECT version, configuration_json FROM fdp_process_versions WHERE workspace_id = ? AND definition_id = ? ORDER BY version DESC LIMIT 1").bind(workspace.id, id).first<{ version: number; configuration_json: Record<string, unknown> }>();
    const configuration = Object.hasOwn(body, "configuration") ? sanitizeProcessConfiguration(body.configuration) : sanitizeProcessConfiguration(latest?.configuration_json ?? {}); const version = Number(latest?.version ?? 0) + 1; const versionId = crypto.randomUUID();
    await d1.batch([
      d1.prepare("INSERT INTO fdp_process_versions (id, workspace_id, definition_id, version, status, configuration_json, created_by) VALUES (?, ?, ?, ?, 'draft', ?::jsonb, ?)").bind(versionId, workspace.id, id, version, JSON.stringify(configuration), user.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "process.version_created", entityType: "process_version", entityId: versionId, after: { definitionId: id, version, status: "draft", stepCount: configuration.steps.length }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ version: { id: versionId, definitionId: id, version, status: "draft", configuration } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
