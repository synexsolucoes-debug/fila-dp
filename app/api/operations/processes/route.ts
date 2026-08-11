import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { assertNoAdmissionWorkflow, sanitizeProcessConfiguration } from "@/lib/operations";

export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user); requireCapability(workspace, "processes.read");
    const [definitions, versions] = await Promise.all([
      d1.prepare("SELECT * FROM fdp_process_definitions WHERE workspace_id = ? ORDER BY status, name").bind(workspace.id).all(),
      d1.prepare("SELECT * FROM fdp_process_versions WHERE workspace_id = ? ORDER BY definition_id, version DESC").bind(workspace.id).all(),
    ]); return Response.json({ processes: definitions.results, versions: versions.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "processes.manage");
    const code = cleanText(body.code, 60).toUpperCase().replace(/[^A-Z0-9_-]/g, "_"); const name = cleanText(body.name, 160); const category = cleanText(body.category, 80) || "general";
    if (!code || !name) throw ApiError.badRequest("Código e nome são obrigatórios.", "PROCESS_REQUIRED_FIELDS"); assertNoAdmissionWorkflow(code, name, category);
    if (await d1.prepare("SELECT id FROM fdp_process_definitions WHERE workspace_id = ? AND code = ?").bind(workspace.id, code).first()) throw new ApiError(409, "PROCESS_CODE_CONFLICT", "Já existe um processo com este código.");
    const definitionId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const configuration = sanitizeProcessConfiguration(body.configuration);
    await d1.batch([
      d1.prepare("INSERT INTO fdp_process_definitions (id, workspace_id, code, name, category, status) VALUES (?, ?, ?, ?, ?, 'active')").bind(definitionId, workspace.id, code, name, category),
      d1.prepare("INSERT INTO fdp_process_versions (id, workspace_id, definition_id, version, status, configuration_json, created_by) VALUES (?, ?, ?, 1, 'draft', ?::jsonb, ?)")
        .bind(versionId, workspace.id, definitionId, JSON.stringify(configuration), user.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "process.created", entityType: "process_definition", entityId: definitionId,
        after: { code, name, category, status: "active", draftVersion: 1 }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ process: { id: definitionId, code, name, category, status: "active" }, version: { id: versionId, version: 1, status: "draft", configuration } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
