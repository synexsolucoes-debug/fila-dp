import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Resolver um retroativo do ERP DP: **lançado** (a diferença entrou na folha —
 * diga em qual) ou **dispensado** (diga por quê). Reabrir também é possível,
 * para o lançamento feito por engano. Tudo com trilha na auditoria.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "movements.manage");
    const status = body.status === "posted" || body.status === "waived" || body.status === "open" ? body.status : "";
    if (!status) throw ApiError.badRequest("Informe se o retroativo foi lançado, dispensado ou reaberto.", "RETRO_STATUS_INVALID");
    const resolution = status === "open" ? "" : cleanText(body.resolution, 500);
    if (status !== "open" && !resolution) {
      throw ApiError.badRequest(status === "posted" ? "Diga em qual folha a diferença foi lançada." : "Diga por que o retroativo foi dispensado.", "RETRO_RESOLUTION_REQUIRED");
    }
    const current = await d1.prepare("SELECT id, company_id, status, resolution FROM fdp_erp_retroactive_items WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Retroativo não encontrado.", "RETRO_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    await d1.batch([
      d1.prepare(`UPDATE fdp_erp_retroactive_items SET status = ?, resolution = ?,
          resolved_by = CASE WHEN ? = 'open' THEN NULL ELSE ? END,
          resolved_at = CASE WHEN ? = 'open' THEN NULL ELSE now() END, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(status, resolution, status, user.id, status, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: `erp.retroactive.${status}`, entityType: "erp_retroactive_item", entityId: id,
        before: { status: current.status, resolution: current.resolution }, after: { status, resolution },
        metadata: { scope: "company", companyId: String(current.company_id) },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ id, status, resolution });
  } catch (error) { return apiError(error); }
}
