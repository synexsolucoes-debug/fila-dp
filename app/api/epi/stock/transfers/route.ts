import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { epiDate, epiQuantity, epiText, loadProduct, loadStockLocation, prepareEpiMovement, prepareStockChange } from "@/lib/epi-service";

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.stock.adjust", "transferir estoque entre locais");
    const product = await loadProduct(d1, workspace.id, epiText(body.productId, "o EPI", 120, true));
    const [source, target] = await Promise.all([
      loadStockLocation(d1, workspace.id, epiText(body.sourceStockLocationId, "o local de origem", 120, true)),
      loadStockLocation(d1, workspace.id, epiText(body.targetStockLocationId, "o local de destino", 120, true)),
    ]);
    if (source.id === target.id) throw ApiError.badRequest("Origem e destino precisam ser locais diferentes.", "EPI_TRANSFER_SAME_LOCATION");
    const quantity = epiQuantity(body.quantity, "Quantidade");
    const movementDate = epiDate(body.movementDate, "a data da transferência") as string;
    const idempotencyKey = epiText(request.headers.get("idempotency-key") ?? body.idempotencyKey, "a chave de idempotência", 160);
    if (idempotencyKey) {
      const replay = await d1.prepare("SELECT * FROM fdp_epi_movements WHERE workspace_id = ? AND idempotency_key = ?")
        .bind(workspace.id, idempotencyKey).first<Record<string, unknown>>();
      if (replay) return Response.json({ movement: replay, replayed: true });
    }
    const movementId = crypto.randomUUID();
    await d1.batch([
      prepareStockChange(d1, { workspaceId: workspace.id, productId: product.id, stockLocationId: source.id, delta: -quantity, actorId: user.id }),
      prepareStockChange(d1, { workspaceId: workspace.id, productId: product.id, stockLocationId: target.id, delta: quantity, actorId: user.id }),
      prepareEpiMovement({
        id: movementId, workspaceId: workspace.id, companyId: null, cnpj: "", movementDate, movementType: "stock_transfer",
        productId: product.id, epiName: product.name, caNumber: product.ca_number, size: product.size,
        quantity, stockDelta: 0, unitValue: Number(product.unit_value), reason: "transfer_between_locations", status: "completed",
        sourceType: "transfer", sourceId: movementId, responsibleId: user.id,
        stockLocationId: source.id, targetStockLocationId: target.id,
        idempotencyKey, notes: epiText(body.notes, "a observação", 2000), createdBy: user.id,
      }),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "epi_stock.transferred", entityType: "epi_stock_movement", entityId: movementId,
        after: { productId: product.id, sourceStockLocationId: source.id, targetStockLocationId: target.id, quantity },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ movement: { id: movementId, productId: product.id, source: source.id, target: target.id, quantity } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
