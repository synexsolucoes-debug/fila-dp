import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import {
  epiDate, epiMoney, epiQuantity, epiText, loadStockLocation, parseEpiType, parseProductStatus,
  parseRegistrationReason, prepareEpiMovement, prepareStockChange,
} from "@/lib/epi-service";

type RouteContext = { params: Promise<{ id: string }> };

async function productOf(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"], workspaceId: string, id: string) {
  const product = await d1.prepare("SELECT * FROM fdp_epi_products WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, id).first<Record<string, unknown>>();
  if (!product) throw ApiError.notFound("EPI não encontrado.", "EPI_PRODUCT_NOT_FOUND");
  return product;
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar o Controle de EPI");
    const product = await productOf(d1, workspace.id, id);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) {
      const movements = await d1.prepare(`SELECT * FROM fdp_epi_movements
        WHERE workspace_id = ? AND product_id = ? AND company_id IS NULL
        ORDER BY movement_date DESC, created_at DESC LIMIT 100`).bind(workspace.id, id).all<Record<string, unknown>>();
      return Response.json({ product, movements: movements.results, deliveries: [] });
    }
    const companyIds = [...access.companyIds];
    const movementCompanyClause = access.unrestricted
      ? "" : ` AND (company_id IS NULL OR company_id IN (${companyIds.map(() => "?").join(",")}))`;
    const deliveryCompanyClause = access.unrestricted
      ? "" : ` AND d.company_id IN (${companyIds.map(() => "?").join(",")})`;
    const [movements, deliveries] = await Promise.all([
      d1.prepare(`SELECT * FROM fdp_epi_movements WHERE workspace_id = ? AND product_id = ?
        ${movementCompanyClause}
        ORDER BY movement_date DESC, created_at DESC LIMIT 100`)
        .bind(workspace.id, id, ...companyIds).all<Record<string, unknown>>(),
      d1.prepare(`SELECT d.*, e.full_name AS employee_full_name, e.social_name AS employee_social_name
        FROM fdp_epi_deliveries d
        JOIN fdp_employees e ON e.workspace_id = d.workspace_id AND e.id = d.employee_id
        WHERE d.workspace_id = ? AND d.product_id = ?
        ${deliveryCompanyClause}
        ORDER BY d.delivered_on DESC LIMIT 100`)
        .bind(workspace.id, id, ...companyIds).all<Record<string, unknown>>(),
    ]);
    return Response.json({ product, movements: movements.results, deliveries: deliveries.results });
  } catch (error) { return apiError(error); }
}

/**
 * Edição do cadastro.
 *
 * O SKU e o saldo pertencem ao workspace; entregas, devoluções e descartes
 * registram separadamente a empresa consumidora.
 *
 * O ajuste de estoque é registrado como movimentação própria, com o motivo, em
 * vez de sobrescrever o saldo em silêncio.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.edit", "editar o cadastro de EPI");
    const before = await productOf(d1, workspace.id, id);
    const next = {
      name: body.name === undefined ? String(before.name) : epiText(body.name, "o nome do EPI", 160, true),
      epiType: body.epiType === undefined ? String(before.epi_type) : parseEpiType(body.epiType),
      caNumber: body.caNumber === undefined ? String(before.ca_number) : epiText(body.caNumber, "o número do CA", 40, true),
      size: body.size === undefined ? String(before.size) : epiText(body.size, "o tamanho", 40, true),
      brand: body.brand === undefined ? String(before.brand) : epiText(body.brand, "a marca", 120, true),
      model: body.model === undefined ? String(before.model) : epiText(body.model, "o modelo", 120, true),
      unitValue: body.unitValue === undefined ? Number(before.unit_value) : epiMoney(body.unitValue, "Valor unitário"),
      status: body.status === undefined ? String(before.status) : parseProductStatus(body.status),
      registrationReason: body.registrationReason === undefined ? String(before.registration_reason) : parseRegistrationReason(body.registrationReason),
      notes: body.notes === undefined ? String(before.notes) : epiText(body.notes, "a observação", 2000),
      productExpiresOn: body.productExpiresOn === undefined ? (before.product_expires_on as string | null) : epiDate(body.productExpiresOn, "a validade do produto", false),
      caExpiresOn: body.caExpiresOn === undefined ? (before.ca_expires_on as string | null) : epiDate(body.caExpiresOn, "a validade do CA", false),
      supplier: body.supplier === undefined ? String(before.supplier) : epiText(body.supplier, "o fornecedor", 160),
      internalCode: body.internalCode === undefined ? String(before.internal_code) : epiText(body.internalCode, "o código interno", 80),
    };
    const currentStock = Number(before.stock_quantity ?? 0);
    const stockQuantity = body.stockQuantity === undefined ? currentStock : epiQuantity(body.stockQuantity, "Quantidade em estoque", { min: 0 });
    const stockDelta = stockQuantity - currentStock;
    const adjustmentNote = epiText(body.stockAdjustmentReason, "o motivo do ajuste", 240);
    if (stockDelta !== 0 && !adjustmentNote) {
      throw ApiError.badRequest("Informe o motivo do ajuste de estoque.", "EPI_STOCK_ADJUSTMENT_REASON_REQUIRED");
    }
    if (next.internalCode && next.internalCode !== String(before.internal_code)) {
      const duplicate = await d1.prepare("SELECT id FROM fdp_epi_products WHERE workspace_id = ? AND internal_code = ? AND id <> ?")
        .bind(workspace.id, next.internalCode, id).first();
      if (duplicate) throw new ApiError(409, "EPI_INTERNAL_CODE_CONFLICT", "Já existe um EPI com este código interno neste grupo.");
    }
    const location = stockDelta !== 0 ? await loadStockLocation(d1, workspace.id, epiText(body.stockLocationId, "o local de estoque", 120)) : null;
    if (stockDelta !== 0) requireNamedCapability(workspace, "epi.stock.adjust", "ajustar o saldo de estoque");

    const statements = [
      d1.prepare(`UPDATE fdp_epi_products SET name = ?, epi_type = ?, ca_number = ?, size = ?, brand = ?, model = ?,
        unit_value = ?, status = ?, registration_reason = ?, notes = ?, product_expires_on = ?,
        ca_expires_on = ?, supplier = ?, internal_code = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(next.name, next.epiType, next.caNumber, next.size, next.brand, next.model, next.unitValue,
          next.status, next.registrationReason, next.notes, next.productExpiresOn, next.caExpiresOn,
          next.supplier, next.internalCode, user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_product.updated",
        entityType: "epi_product", entityId: id, before, after: { ...next, stockQuantity },
        metadata: { stockDelta, adjustmentNote }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ];
    if (stockDelta !== 0) {
      statements.splice(1, 0, prepareStockChange(d1, {
        workspaceId: workspace.id, productId: id, stockLocationId: location!.id, delta: stockDelta, actorId: user.id,
      }));
      statements.splice(1, 0, prepareEpiMovement({
        workspaceId: workspace.id, companyId: null, cnpj: "",
        movementDate: new Date().toISOString().slice(0, 10), movementType: "manual_adjustment",
        productId: id, epiName: next.name, caNumber: next.caNumber, size: next.size,
        quantity: Math.abs(stockDelta), stockDelta, unitValue: next.unitValue,
        reason: "manual_adjustment", status: next.status, sourceType: "product", sourceId: id,
        responsibleId: user.id, notes: adjustmentNote, createdBy: user.id,
        stockLocationId: location!.id,
      }));
    }
    await d1.batch(statements);
    return Response.json({ product: { id, ...next, stockQuantity } });
  } catch (error) { return apiError(error); }
}

/**
 * Baixa do cadastro.
 *
 * Inativa em vez de apagar, e a diferença é deliberada. O cadastro de um EPI é
 * prova documental de segurança do trabalho: dele pendem o termo que o
 * colaborador assinou, a evidência do descarte e o razão que o auditor lê.
 * Remover a linha levaria tudo isso junto — e o banco recusaria de qualquer
 * forma, porque a movimentação é append-only e a referência é `restrict`.
 *
 * O EPI ainda entregue a alguém não é inativado nem por essa via: primeiro a
 * devolução, depois a baixa. Inativar antes deixaria colaborador com
 * equipamento fora de qualquer relatório.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.delete", "dar baixa em cadastro de EPI");
    const before = await productOf(d1, workspace.id, id);
    if (before.status === "inactive") throw ApiError.badRequest("Este cadastro já está inativo.", "EPI_PRODUCT_ALREADY_INACTIVE");
    const outstanding = await d1.prepare(`SELECT COALESCE(SUM(quantity - settled_quantity), 0) AS pending
      FROM fdp_epi_deliveries WHERE workspace_id = ? AND product_id = ? AND status <> 'canceled'`)
      .bind(workspace.id, id).first<{ pending: string | number }>();
    if (Number(outstanding?.pending ?? 0) > 0) {
      throw new ApiError(409, "EPI_PRODUCT_IN_USE",
        `Este EPI ainda está com ${Number(outstanding?.pending)} unidade(s) em poder de colaboradores. Registre a devolução ou o descarte antes de inativar o cadastro.`);
    }
    await d1.batch([
      d1.prepare("UPDATE fdp_epi_products SET status = 'inactive', updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
        .bind(user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_product.inactivated",
        entityType: "epi_product", entityId: id, before, after: { ...before, status: "inactive" },
        metadata: { retainedHistory: true }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ product: { id, status: "inactive" } });
  } catch (error) { return apiError(error); }
}
