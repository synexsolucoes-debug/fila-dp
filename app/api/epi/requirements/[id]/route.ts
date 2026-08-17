import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { epiQuantity } from "@/lib/epi-service";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.edit", "editar EPIs obrigatórios");
    const before = await d1.prepare("SELECT * FROM fdp_epi_requirements WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!before) throw ApiError.notFound("Regra de EPI não encontrada.", "EPI_REQUIREMENT_NOT_FOUND");
    const companyId = String(before.company_id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const next = {
      quantity: body.quantity === undefined ? Number(before.quantity) : epiQuantity(body.quantity, "a quantidade obrigatória", { min: 1, max: 100 }),
      replacementDays: body.replacementDays === undefined ? Number(before.replacement_days) : epiQuantity(body.replacementDays, "o ciclo de troca", { min: 0, max: 3650 }),
      warningDays: body.warningDays === undefined ? Number(before.warning_days) : epiQuantity(body.warningDays, "a antecedência do alerta", { min: 0, max: 365 }),
      active: body.active === undefined ? Number(before.active) === 1 : Boolean(body.active),
      notes: body.notes === undefined ? String(before.notes) : cleanText(body.notes, 1000),
    };
    await d1.batch([
      d1.prepare(`UPDATE fdp_epi_requirements SET quantity = ?, replacement_days = ?, warning_days = ?,
        active = ?, notes = ?, updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
        .bind(next.quantity, next.replacementDays, next.warningDays, next.active ? 1 : 0, next.notes, user.id, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "epi_requirement.updated", entityType: "epi_requirement", entityId: id, before, after: next,
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ requirement: { id, companyId, ...next } });
  } catch (error) { return apiError(error); }
}
