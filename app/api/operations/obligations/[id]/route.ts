import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validRequiredDate } from "@/lib/operations";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "obligations.manage");
    const current = await d1.prepare("SELECT * FROM fdp_compliance_obligations WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Obrigação não encontrada.", "OBLIGATION_NOT_FOUND"); await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    const status = ["open", "in_progress", "blocked", "completed"].includes(String(body.status)) ? String(body.status) : String(current.status);
    const next = { title: cleanText(body.title, 180) || String(current.title), dueDate: Object.hasOwn(body, "dueDate") ? validRequiredDate(body.dueDate) : String(current.due_date), status,
      ownerUserId: Object.hasOwn(body, "ownerUserId") ? cleanText(body.ownerUserId, 120) || null : current.owner_user_id, notes: Object.hasOwn(body, "notes") ? cleanText(body.notes, 1000) : String(current.notes) };
    await d1.batch([
      d1.prepare("UPDATE fdp_compliance_obligations SET title = ?, due_date = ?, status = ?, owner_user_id = ?, notes = ?, completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(next.title, next.dueDate, next.status, next.ownerUserId, next.notes, next.status, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "obligation.updated", entityType: "compliance_obligation", entityId: id, before: current, after: next, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ obligation: { id, ...next } });
  } catch (error) { return apiError(error); }
}
