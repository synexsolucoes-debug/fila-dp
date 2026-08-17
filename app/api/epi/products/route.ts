import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import {
  epiDate, epiMoney, epiQuantity, epiText, loadStockLocation, parseEpiType, parseProductStatus,
  parseRegistrationReason, prepareEpiMovement, prepareStockChange,
} from "@/lib/epi-service";

/**
 * Cadastro de EPI e consulta do estoque.
 *
 * O catálogo, o SKU e o saldo são do workspace. CNPJ existe somente nos
 * eventos de consumo (entrega, devolução, dano, descarte e desconto).
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar o Controle de EPI");
    const url = new URL(request.url);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const where = ["p.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    const search = cleanText(url.searchParams.get("search"), 120);
    if (search) { where.push("p.name ILIKE ?"); values.push(`%${search}%`); }
    for (const [param, column] of [["ca", "p.ca_number"], ["size", "p.size"], ["status", "p.status"], ["type", "p.epi_type"], ["reason", "p.registration_reason"]] as const) {
      const value = cleanText(url.searchParams.get(param), 60);
      if (value) { where.push(`${column} = ?`); values.push(value); }
    }
    const from = epiDate(url.searchParams.get("from"), "a data inicial", false);
    if (from) { where.push("p.registered_on >= ?"); values.push(from); }
    const to = epiDate(url.searchParams.get("to"), "a data final", false);
    if (to) { where.push("p.registered_on <= ?"); values.push(to); }
    const cursor = cleanText(url.searchParams.get("cursor"), 120);
    if (cursor) { where.push("p.id > ?"); values.push(cursor); }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const assignedCompanyIds = access.unrestricted ? null : [...access.companyIds];
    const assignedScope = assignedCompanyIds === null ? "true"
      : assignedCompanyIds.length ? `d.company_id IN (${assignedCompanyIds.map(() => "?").join(",")})` : "false";
    const assignedValues = assignedCompanyIds ?? [];

    const result = await d1.prepare(`SELECT p.*,
        COALESCE((SELECT SUM(b.quantity) FROM fdp_stock_balances b
          WHERE b.workspace_id = p.workspace_id AND b.product_id = p.id), 0) AS available_quantity,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'name', l.name, 'quantity', b.quantity) ORDER BY l.name)
          FROM fdp_stock_balances b JOIN fdp_stock_locations l
            ON l.workspace_id = b.workspace_id AND l.id = b.stock_location_id
          WHERE b.workspace_id = p.workspace_id AND b.product_id = p.id), '[]'::jsonb) AS stock_locations,
        (SELECT COALESCE(SUM(d.quantity - d.settled_quantity), 0) FROM fdp_epi_deliveries d
          WHERE d.workspace_id = p.workspace_id AND d.product_id = p.id AND ${assignedScope} AND d.status <> 'canceled') AS assigned_quantity
      FROM fdp_epi_products p
      WHERE ${where.join(" AND ")} ORDER BY p.id LIMIT ?`).bind(...assignedValues, ...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit);
    return Response.json({ products: rows, nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.create", "cadastrar EPI");
    const product = {
      id: crypto.randomUUID(),
      name: epiText(body.name, "o nome do EPI", 160, true),
      epiType: parseEpiType(body.epiType),
      caNumber: epiText(body.caNumber, "o número do CA", 40, true),
      size: epiText(body.size, "o tamanho", 40, true),
      brand: epiText(body.brand, "a marca", 120, true),
      model: epiText(body.model, "o modelo", 120, true),
      unitValue: epiMoney(body.unitValue, "Valor unitário"),
      stockQuantity: epiQuantity(body.stockQuantity, "Quantidade em estoque", { min: 0 }),
      registeredOn: epiDate(body.registeredOn, "a data do cadastro") as string,
      status: parseProductStatus(body.status ?? "active"),
      registrationReason: parseRegistrationReason(body.registrationReason),
      notes: epiText(body.notes, "a observação", 2000),
      productExpiresOn: epiDate(body.productExpiresOn, "a validade do produto", false),
      caExpiresOn: epiDate(body.caExpiresOn, "a validade do CA", false),
      supplier: epiText(body.supplier, "o fornecedor", 160),
      internalCode: epiText(body.internalCode, "o código interno", 80),
    };
    if (product.internalCode) {
      const duplicate = await d1.prepare("SELECT id FROM fdp_epi_products WHERE workspace_id = ? AND internal_code = ?")
        .bind(workspace.id, product.internalCode).first();
      if (duplicate) throw new ApiError(409, "EPI_INTERNAL_CODE_CONFLICT", "Já existe um EPI com este código interno neste grupo.");
    }
    const location = await loadStockLocation(d1, workspace.id, epiText(body.stockLocationId, "o local de estoque", 120));

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_epi_products
        (id, workspace_id, name, epi_type, ca_number, size, brand, model, unit_value, stock_quantity,
         registered_on, status, registration_reason, notes, product_expires_on, ca_expires_on, supplier, internal_code, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(product.id, workspace.id, product.name, product.epiType, product.caNumber, product.size,
          product.brand, product.model, product.unitValue, 0, product.registeredOn, product.status,
          product.registrationReason, product.notes, product.productExpiresOn, product.caExpiresOn, product.supplier,
          product.internalCode, user.id, user.id),
      prepareStockChange(d1, {
        workspaceId: workspace.id, productId: product.id, stockLocationId: location.id,
        delta: product.stockQuantity, actorId: user.id,
      }),
      // O cadastro é a primeira movimentação do equipamento. Sem ela, o razão
      // começaria na entrega e o relatório por competência perderia a entrada.
      prepareEpiMovement({
        workspaceId: workspace.id, companyId: null, cnpj: "", movementDate: product.registeredOn,
        movementType: "registration", productId: product.id, epiName: product.name, caNumber: product.caNumber,
        size: product.size, quantity: product.stockQuantity, stockDelta: product.stockQuantity,
        unitValue: product.unitValue, reason: product.registrationReason, status: product.status,
        sourceType: "product", sourceId: product.id, responsibleId: user.id, notes: product.notes, createdBy: user.id,
        stockLocationId: location.id,
      }),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_product.created",
        entityType: "epi_product", entityId: product.id, after: product,
        metadata: { scope: "workspace", stockQuantity: product.stockQuantity }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ product }, { status: 201 });
  } catch (error) { return apiError(error); }
}
