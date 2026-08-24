import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { epiText, loadCompany, loadProduct, prepareEpiMovement, prepareStockChange } from "@/lib/epi-service";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.return", "tratar a higienização de EPI devolvido");
    const before = await d1.prepare("SELECT * FROM fdp_epi_returns WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!before) throw ApiError.notFound("Devolução não encontrada.", "EPI_RETURN_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(before.company_id));
    const action = epiText(body.action, "a ação", 30, true);
    if (!["start", "complete", "reject"].includes(action)) throw ApiError.badRequest("Ação de higienização inválida.", "EPI_SANITIZATION_ACTION_INVALID");
    const current = String(before.sanitization_status);
    if ((action === "start" && current !== "awaiting") || (action !== "start" && !["awaiting", "in_progress"].includes(current))) {
      throw new ApiError(409, "EPI_SANITIZATION_CLOSED", "Esta higienização já foi concluída ou não está aguardando tratamento.");
    }
    const result = epiText(body.result, "o resultado", 1000, action !== "start");
    const product = await loadProduct(d1, workspace.id, String(before.product_id));
    const company = await loadCompany(d1, workspace.id, String(before.company_id));
    const nextStatus = action === "start" ? "in_progress" : action === "complete" ? "sanitized" : "rejected";
    const statements = [];
    if (action === "complete") statements.push(prepareStockChange(d1, {
      workspaceId: workspace.id, productId: product.id, stockLocationId: String(before.stock_location_id),
      delta: Number(before.quantity), actorId: user.id,
    }));
    statements.push(
      d1.prepare(`UPDATE fdp_epi_returns SET sanitization_status = ?,
        sanitization_started_at = CASE WHEN ? = 'in_progress' THEN COALESCE(sanitization_started_at, now()) ELSE sanitization_started_at END,
        sanitization_completed_at = CASE WHEN ? IN ('sanitized', 'rejected') THEN now() ELSE NULL END,
        sanitization_responsible_id = ?, sanitization_result = ?, back_to_stock = CASE WHEN ? = 'sanitized' THEN 1 ELSE back_to_stock END,
        updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
        .bind(nextStatus, nextStatus, nextStatus, user.id, result, nextStatus, user.id, workspace.id, id),
      prepareEpiMovement({
        workspaceId: workspace.id, companyId: String(before.company_id), cnpj: company.tax_id,
        movementDate: new Date().toISOString().slice(0, 10), movementType: action === "complete" ? "sanitization_completed" : "sanitizing",
        productId: product.id, epiName: product.name, caNumber: product.ca_number, size: product.size,
        employeeId: String(before.employee_id), quantity: Number(before.quantity), stockDelta: action === "complete" ? Number(before.quantity) : 0,
        unitValue: Number(product.unit_value), reason: action, status: nextStatus, sourceType: "sanitization", sourceId: id,
        responsibleId: user.id, stockLocationId: String(before.stock_location_id), notes: result, createdBy: user.id,
      }),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: `epi_sanitization.${action}`, entityType: "epi_return", entityId: id, before, after: { sanitizationStatus: nextStatus, result },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    );
    await d1.batch(statements);
    return Response.json({ sanitization: { returnId: id, status: nextStatus, result } });
  } catch (error) { return apiError(error); }
}
