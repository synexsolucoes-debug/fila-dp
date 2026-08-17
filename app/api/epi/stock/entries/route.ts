import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { epiDate, epiMoney, epiQuantity, epiText, loadCompany, loadProduct, loadStockLocation, prepareEpiMovement, prepareStockChange } from "@/lib/epi-service";

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.stock.adjust", "registrar entradas de estoque");
    const product = await loadProduct(d1, workspace.id, epiText(body.productId, "o EPI", 120, true));
    const companyId = epiText(body.companyId, "a empresa compradora", 120) || product.company_id;
    if (!companyId) throw ApiError.badRequest("Informe a empresa compradora para a rastreabilidade da entrada.", "EPI_PURCHASING_COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const company = await loadCompany(d1, workspace.id, companyId);
    const location = await loadStockLocation(d1, workspace.id, epiText(body.stockLocationId, "o local de destino", 120));
    const quantity = epiQuantity(body.quantity, "Quantidade");
    const movementDate = epiDate(body.movementDate, "a data da entrada") as string;
    const idempotencyKey = epiText(request.headers.get("idempotency-key") ?? body.idempotencyKey, "a chave de idempotência", 160);
    if (idempotencyKey) {
      const replay = await d1.prepare("SELECT * FROM fdp_epi_movements WHERE workspace_id = ? AND idempotency_key = ?")
        .bind(workspace.id, idempotencyKey).first<Record<string, unknown>>();
      if (replay) return Response.json({ movement: replay, replayed: true });
    }
    const movementId = crypto.randomUUID();
    const notes = epiText(body.notes, "a observação", 2000);
    await d1.batch([
      prepareStockChange(d1, { workspaceId: workspace.id, productId: product.id, stockLocationId: location.id, delta: quantity, actorId: user.id }),
      prepareEpiMovement({
        id: movementId, workspaceId: workspace.id, companyId, cnpj: company.tax_id, movementDate, movementType: "stock_entry",
        productId: product.id, epiName: product.name, caNumber: product.ca_number, size: product.size,
        quantity, stockDelta: quantity, unitValue: body.unitValue === undefined ? Number(product.unit_value) : epiMoney(body.unitValue, "Valor unitário"),
        reason: epiText(body.reason, "o motivo", 120) || "stock_replenishment", status: "completed",
        sourceType: "entry", sourceId: movementId, responsibleId: user.id, notes, createdBy: user.id,
        stockLocationId: location.id, idempotencyKey,
      }),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "epi_stock.entry", entityType: "epi_stock_movement", entityId: movementId,
        after: { productId: product.id, stockLocationId: location.id, quantity, movementDate, companyId },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ movement: { id: movementId, productId: product.id, stockLocationId: location.id, quantity } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
