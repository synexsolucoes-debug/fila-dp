import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { enumOr, workItemStatuses } from "@/lib/operations";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "competences.manage");
    const current = await d1.prepare("SELECT * FROM fdp_payroll_cycle_items WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Item de fechamento não encontrado.", "CLOSING_ITEM_NOT_FOUND"); await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    const next = { title: cleanText(body.title, 180) || String(current.title), status: enumOr(body.status, workItemStatuses, current.status as typeof workItemStatuses[number]),
      ownerUserId: Object.hasOwn(body, "ownerUserId") ? cleanText(body.ownerUserId, 120) || null : current.owner_user_id, dueDate: Object.hasOwn(body, "dueDate") ? optionalDate(body.dueDate) : current.due_date, notes: Object.hasOwn(body, "notes") ? cleanText(body.notes, 1000) : String(current.notes) };
    await d1.batch([
      d1.prepare("UPDATE fdp_payroll_cycle_items SET title = ?, status = ?, owner_user_id = ?, due_date = ?, notes = ?, completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(next.title, next.status, next.ownerUserId, next.dueDate, next.notes, next.status, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "closing_item.updated", entityType: "payroll_cycle_item", entityId: id, before: current, after: next, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ item: { id, ...next } });
  } catch (error) { return apiError(error); }
}
