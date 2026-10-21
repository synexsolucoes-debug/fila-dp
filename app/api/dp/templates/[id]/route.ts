import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { templateBody, templateFromRow, validateTemplateInput } from "@/lib/dp-recurring";

/**
 * Edita uma rotina. Vale para os períodos que ainda não foram gerados: a
 * demanda já criada segue com o título e o prazo com que nasceu.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "alterar rotinas do DP");
    const row = await d1.prepare("SELECT * FROM fdp_recurring_templates WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!row) throw ApiError.notFound("Rotina não encontrada.", "RECURRING_TEMPLATE_NOT_FOUND");
    const before = templateFromRow(row);
    const merged = { ...before, ...Object.fromEntries(Object.entries(templateBody({ ...before, ...body })).filter(([, value]) => value !== undefined)), code: before.code };
    const problem = validateTemplateInput(merged);
    if (problem) throw ApiError.badRequest(problem, "RECURRING_TEMPLATE_INVALID");
    await d1.batch([
      d1.prepare(`UPDATE fdp_recurring_templates SET name = ?, description = ?, frequency = ?, day_start = ?, day_end = ?, weekday = ?,
          scope = ?, company_ids = ?::jsonb, process_type = ?, list_week_movements = ?, active = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(merged.name, merged.description, merged.frequency,
          merged.frequency === "weekly" ? 1 : merged.dayStart, merged.frequency === "weekly" ? 1 : merged.dayEnd,
          merged.frequency === "weekly" ? merged.weekday : null, merged.scope,
          merged.companyIds ? JSON.stringify(merged.companyIds) : null, merged.processType, merged.listWeekMovements, merged.active,
          workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "recurring_template.updated", entityType: "recurring_template", entityId: id,
        before: { ...before }, after: { ...merged }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ updated: true });
  } catch (error) { return apiError(error); }
}
