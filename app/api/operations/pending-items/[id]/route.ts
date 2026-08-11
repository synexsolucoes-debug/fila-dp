import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireCapability(workspace, "pending_items.manage");
    const current = await d1.prepare("SELECT * FROM fdp_operational_pending_items WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Pendência não encontrada.", "PENDING_ITEM_NOT_FOUND"); await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    const status = ["open", "in_progress", "resolved", "waived"].includes(String(body.status)) ? String(body.status) : String(current.status); const resolution = Object.hasOwn(body, "resolution") ? cleanText(body.resolution, 1000) : String(current.resolution);
    if (["resolved", "waived"].includes(status) && !resolution) throw ApiError.badRequest("Informe a resolução da pendência.", "PENDING_RESOLUTION_REQUIRED");
    const next = { status, resolution, ownerUserId: Object.hasOwn(body, "ownerUserId") ? cleanText(body.ownerUserId, 120) || null : current.owner_user_id };
    await d1.batch([
      d1.prepare("UPDATE fdp_operational_pending_items SET status = ?, resolution = ?, owner_user_id = ?, resolved_at = CASE WHEN ? IN ('resolved', 'waived') THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(status, resolution, next.ownerUserId, status, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "pending_item.updated", entityType: "operational_pending_item", entityId: id, before: current, after: next, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]); return Response.json({ pendingItem: { id, ...next } });
  } catch (error) { return apiError(error); }
}
