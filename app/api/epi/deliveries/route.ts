import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import {
  applyStockChange, attachmentIds, employeeDisplayName, epiDate, epiMoney, epiQuantity, epiText,
  loadCompany, loadEmployee, loadProduct, parseDeliveryStatus, parseRegistrationReason, prepareEpiMovement,
  verifiedAttachments,
} from "@/lib/epi-service";

/**
 * Entrega de EPI ao colaborador.
 *
 * A ordem das operações é a que importa aqui: o estoque é debitado **antes** de
 * a entrega ser gravada, porque é o débito que pode falhar. Se ele falha —
 * saldo insuficiente, duas entregas simultâneas disputando a última unidade —
 * nada mais acontece, e a recusa diz o que fazer. O caminho inverso deixaria a
 * entrega registrada contra um estoque que não tinha o equipamento.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar entregas de EPI");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ deliveries: [], nextCursor: null });

    const where = ["d.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`d.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids);
    }
    if (companyId) { where.push("d.company_id = ?"); values.push(companyId); }
    const employeeId = cleanText(url.searchParams.get("employeeId"), 120);
    if (employeeId) { where.push("d.employee_id = ?"); values.push(employeeId); }
    const status = cleanText(url.searchParams.get("status"), 40);
    if (status) { where.push("d.status = ?"); values.push(status); }
    if (url.searchParams.get("outstanding") === "true") where.push("d.quantity > d.settled_quantity AND d.status <> 'canceled'");
    const from = epiDate(url.searchParams.get("from"), "a data inicial", false);
    if (from) { where.push("d.delivered_on >= ?"); values.push(from); }
    const to = epiDate(url.searchParams.get("to"), "a data final", false);
    if (to) { where.push("d.delivered_on <= ?"); values.push(to); }
    const cursor = cleanText(url.searchParams.get("cursor"), 120);
    if (cursor) { where.push("d.id > ?"); values.push(cursor); }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

    const result = await d1.prepare(`SELECT d.*, p.name AS epi_name, p.epi_type, p.model, p.brand,
        e.full_name AS employee_full_name, e.social_name AS employee_social_name, e.registration_number,
        c.legal_name AS company_legal_name, c.trade_name AS company_trade_name, c.tax_id AS company_tax_id,
        (SELECT COUNT(*) FROM fdp_epi_attachments a WHERE a.workspace_id = d.workspace_id AND a.entity_type = 'delivery' AND a.entity_id = d.id) AS attachments_count
      FROM fdp_epi_deliveries d
      JOIN fdp_epi_products p ON p.workspace_id = d.workspace_id AND p.id = d.product_id
      JOIN fdp_employees e ON e.workspace_id = d.workspace_id AND e.id = d.employee_id
      JOIN fdp_companies c ON c.workspace_id = d.workspace_id AND c.id = d.company_id
      WHERE ${where.join(" AND ")} ORDER BY d.id LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit);
    return Response.json({ deliveries: rows, nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.deliver", "entregar EPI ao colaborador");
    const companyId = epiText(body.companyId, "a empresa", 120, true);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const [company, product, employee] = await Promise.all([
      loadCompany(d1, workspace.id, companyId),
      loadProduct(d1, workspace.id, companyId, epiText(body.productId, "o EPI", 120, true)),
      loadEmployee(d1, workspace.id, companyId, epiText(body.employeeId, "o colaborador", 120, true)),
    ]);
    if (["discarded", "lost", "inactive"].includes(product.status)) {
      throw ApiError.badRequest("Este EPI está fora de circulação e não pode ser entregue.", "EPI_PRODUCT_UNAVAILABLE");
    }

    const quantity = epiQuantity(body.quantity, "Quantidade");
    const deliveredOn = epiDate(body.deliveredOn, "a data da entrega") as string;
    const delivery = {
      id: crypto.randomUUID(), companyId, productId: product.id, employeeId: employee.id, deliveredOn, quantity,
      positionName: epiText(body.positionName, "o cargo", 160) || employee.position_name || "",
      departmentName: epiText(body.departmentName, "o setor", 160) || employee.department_name || "",
      caNumber: epiText(body.caNumber, "o CA", 40) || product.ca_number,
      size: epiText(body.size, "o tamanho", 40) || product.size,
      unitValue: body.unitValue === undefined ? Number(product.unit_value) : epiMoney(body.unitValue, "Valor unitário"),
      responsibleUserId: epiText(body.responsibleUserId, "o responsável", 120) || user.id,
      deliveryReason: parseRegistrationReason(body.deliveryReason),
      status: parseDeliveryStatus(body.status ?? "delivered"),
      signatureName: epiText(body.signatureName, "a assinatura", 160),
      notes: epiText(body.notes, "a observação", 2000),
    };
    const attachments = await verifiedAttachments(d1, workspace.id, attachmentIds(body.attachmentIds));

    // Débito primeiro: é a única etapa que pode ser recusada pelo saldo.
    await applyStockChange(d1, workspace.id, product.id, -quantity, "delivered", user.id);
    try {
      await d1.batch([
        d1.prepare(`INSERT INTO fdp_epi_deliveries
          (id, workspace_id, company_id, product_id, employee_id, delivered_on, position_name, department_name,
           ca_number, size, quantity, unit_value, responsible_user_id, delivery_reason, status, signature_name,
           signed_at, notes, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(delivery.id, workspace.id, companyId, product.id, employee.id, deliveredOn, delivery.positionName,
            delivery.departmentName, delivery.caNumber, delivery.size, quantity, delivery.unitValue,
            delivery.responsibleUserId, delivery.deliveryReason, delivery.status, delivery.signatureName,
            delivery.status === "signed" ? new Date().toISOString() : null, delivery.notes, user.id, user.id),
        prepareEpiMovement({
          workspaceId: workspace.id, companyId, cnpj: company.tax_id, movementDate: deliveredOn,
          movementType: "delivery", productId: product.id, epiName: product.name, caNumber: delivery.caNumber,
          size: delivery.size, employeeId: employee.id, employeeName: employeeDisplayName(employee),
          quantity, stockDelta: -quantity, unitValue: delivery.unitValue, reason: delivery.deliveryReason,
          status: delivery.status, sourceType: "delivery", sourceId: delivery.id,
          responsibleId: delivery.responsibleUserId, attachments, notes: delivery.notes, createdBy: user.id,
        }),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_delivery.created",
          entityType: "epi_delivery", entityId: delivery.id, after: delivery,
          metadata: { employeeId: employee.id, productId: product.id, quantity, attachments: attachments.length },
          requestId: request.headers.get("x-fila-dp-request-id"),
        }),
      ]);
    } catch (error) {
      // O estoque já saiu; sem a devolução do saldo o equipamento sumiria da
      // contagem sem entrega nenhuma para explicar onde foi parar.
      await applyStockChange(d1, workspace.id, product.id, quantity, null, user.id).catch(() => undefined);
      throw error;
    }
    return Response.json({ delivery }, { status: 201 });
  } catch (error) { return apiError(error); }
}
