import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { assertNoAdmissionWorkflow } from "@/lib/operations";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "processes.manage");
    const current = await d1.prepare("SELECT * FROM fdp_process_definitions WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Processo não encontrado.", "PROCESS_NOT_FOUND"); const name = cleanText(body.name, 160) || String(current.name); const category = cleanText(body.category, 80) || String(current.category); assertNoAdmissionWorkflow(current.code, name, category);
    const status = body.status === "inactive" ? "inactive" : body.status === "active" ? "active" : String(current.status);
    const next = { name, category, status }; await d1.batch([
      d1.prepare("UPDATE fdp_process_definitions SET name = ?, category = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?").bind(name, category, status, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "process.updated", entityType: "process_definition", entityId: id, before: current, after: next, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ process: { id, code: current.code, ...next } });
  } catch (error) { return apiError(error); }
}
