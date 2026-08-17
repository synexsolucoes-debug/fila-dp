import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { epiDiscountTriggerLabels, epiReturnConditionLabels, returnRouting } from "@/lib/epi";
import {
  attachmentIds, createDiscountRequest, employeeDisplayName, epiDate, epiQuantity, epiText,
  loadCompany, loadEmployee, loadProduct, loadStockLocation, parseReturnCondition, prepareEpiMovement,
  prepareStockChange, verifiedAttachments,
} from "@/lib/epi-service";

/**
 * Devolução de EPI pelo colaborador.
 *
 * O destino do equipamento não é escolhido no formulário: ele é consequência da
 * condição informada, calculada por `returnRouting`. Higienizado volta ao
 * estoque; pendente vai para higienização; danificado ou inutilizado entra na
 * fila de descarte; não devolvido e extraviado abrem demanda para o DP
 * analisar possível desconto — nunca o desconto em si.
 *
 * A tela mostra a consequência antes de gravar, para que a pessoa saiba o que
 * está acionando ao classificar.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar devoluções de EPI");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ returns: [], nextCursor: null });

    const where = ["r.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`r.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids);
    }
    if (companyId) { where.push("r.company_id = ?"); values.push(companyId); }
    const employeeId = cleanText(url.searchParams.get("employeeId"), 120);
    if (employeeId) { where.push("r.employee_id = ?"); values.push(employeeId); }
    const condition = cleanText(url.searchParams.get("condition"), 60);
    if (condition) { where.push("r.epi_condition = ?"); values.push(condition); }
    if (url.searchParams.get("sanitizing") === "true") where.push("r.needs_sanitizing = 1");
    const from = epiDate(url.searchParams.get("from"), "a data inicial", false);
    if (from) { where.push("r.returned_on >= ?"); values.push(from); }
    const to = epiDate(url.searchParams.get("to"), "a data final", false);
    if (to) { where.push("r.returned_on <= ?"); values.push(to); }
    const cursor = cleanText(url.searchParams.get("cursor"), 120);
    if (cursor) { where.push("r.id > ?"); values.push(cursor); }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

    const result = await d1.prepare(`SELECT r.*, p.name AS epi_name, e.full_name AS employee_full_name,
        e.social_name AS employee_social_name, c.trade_name AS company_trade_name, c.legal_name AS company_legal_name,
        (SELECT COUNT(*) FROM fdp_epi_attachments a WHERE a.workspace_id = r.workspace_id AND a.entity_type = 'return' AND a.entity_id = r.id) AS attachments_count
      FROM fdp_epi_returns r
      JOIN fdp_epi_products p ON p.workspace_id = r.workspace_id AND p.id = r.product_id
      JOIN fdp_employees e ON e.workspace_id = r.workspace_id AND e.id = r.employee_id
      JOIN fdp_companies c ON c.workspace_id = r.workspace_id AND c.id = r.company_id
      WHERE ${where.join(" AND ")} ORDER BY r.id LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit);
    return Response.json({ returns: rows, nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.return", "registrar devolução de EPI");
    const deliveryId = epiText(body.deliveryId, "a entrega de origem", 120, true);
    const delivery = await d1.prepare(`SELECT id, company_id, product_id, employee_id, quantity, settled_quantity,
        status, ca_number, size, unit_value, delivered_on FROM fdp_epi_deliveries WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, deliveryId).first<{
        id: string; company_id: string; product_id: string; employee_id: string; quantity: number;
        settled_quantity: number; status: string; ca_number: string; size: string; unit_value: string | number; delivered_on: string;
      }>();
    if (!delivery) throw ApiError.notFound("Entrega não encontrada.", "EPI_DELIVERY_NOT_FOUND");
    if (delivery.status === "canceled") throw ApiError.badRequest("Esta entrega foi cancelada e não admite devolução.", "EPI_DELIVERY_CANCELED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, delivery.company_id);

    const outstanding = Number(delivery.quantity) - Number(delivery.settled_quantity);
    if (outstanding <= 0) throw ApiError.badRequest("Esta entrega já foi totalmente baixada.", "EPI_DELIVERY_ALREADY_SETTLED");
    const quantity = epiQuantity(body.quantity, "Quantidade devolvida", { min: 1, max: outstanding });
    const condition = parseReturnCondition(body.epiCondition ?? body.condition);
    const routing = returnRouting(condition);
    const returnedOn = epiDate(body.returnedOn, "a data da devolução") as string;
    const notes = epiText(body.notes, "a observação", 2000);
    const attachments = await verifiedAttachments(d1, workspace.id, attachmentIds(body.attachmentIds));

    const [company, product, employee] = await Promise.all([
      loadCompany(d1, workspace.id, delivery.company_id),
      loadProduct(d1, workspace.id, delivery.product_id),
      loadEmployee(d1, workspace.id, delivery.company_id, delivery.employee_id),
    ]);

    const returnId = crypto.randomUUID();
    const statements = [] as ReturnType<typeof prepareEpiMovement>[];
    const idempotencyKey = epiText(request.headers.get("idempotency-key") ?? body.idempotencyKey, "a chave de idempotência", 160);
    if (idempotencyKey) {
      const replay = await d1.prepare("SELECT * FROM fdp_epi_returns WHERE workspace_id = ? AND idempotency_key = ?")
        .bind(workspace.id, idempotencyKey).first<Record<string, unknown>>();
      if (replay) return Response.json({ return: replay, replayed: true });
    }
    const location = await loadStockLocation(d1, workspace.id, epiText(body.stockLocationId, "o local de estoque", 120));
    let disposalId: string | null = null;
    let discountRequestId: string | null = null;
    let demandCardId: string | null = null;

    if (routing.backToStock) {
      // Volta ao estoque de fato, e o saldo sobe na mesma requisição em que a
      // devolução é aceita. Marcar "devolvido" sem repor deixaria o EPI fora
      // das duas contagens: nem com o colaborador, nem disponível.
      statements.push(prepareStockChange(d1, {
        workspaceId: workspace.id, productId: product.id, stockLocationId: location.id,
        delta: quantity, actorId: user.id,
      }));
    }

    if (routing.sendToDisposal && routing.disposalReason) {
      disposalId = crypto.randomUUID();
      statements.push(d1.prepare(`INSERT INTO fdp_epi_disposals
        (id, workspace_id, company_id, product_id, employee_id, disposal_date, quantity, ca_number, size,
         disposal_reason, responsible_user_id, status, origin_type, origin_id, notes, created_by, updated_by,
         stock_location_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_disposal', 'return', ?, ?, ?, ?, ?, ?)`)
        .bind(disposalId, workspace.id, delivery.company_id, product.id, employee.id, returnedOn, quantity,
          delivery.ca_number, delivery.size, routing.disposalReason, user.id, returnId,
          `Devolução classificada como ${epiReturnConditionLabels[condition]}.`, user.id, user.id,
          location.id, idempotencyKey ? `${idempotencyKey}:disposal` : ""));
    }

    if (routing.generateDpDemand && routing.discountTrigger) {
      const analysis = await createDiscountRequest(d1, {
        workspaceId: workspace.id, boardId: board.id, companyId: delivery.company_id, company, employee, product,
        deliveryId: delivery.id, deliveredOn: delivery.delivered_on, occurredOn: returnedOn, quantity,
        unitValue: Number(delivery.unit_value), trigger: routing.discountTrigger,
        triggerLabel: epiDiscountTriggerLabels[routing.discountTrigger],
        note: notes || epiReturnConditionLabels[condition],
        analystUserId: epiText(body.analystUserId, "o responsável pela análise", 120) || null,
        attachments, actorUserId: user.id, actorEmail: auth.user.email,
      });
      discountRequestId = analysis.id;
      demandCardId = analysis.cardId;
      statements.push(...analysis.statements);
    }

    statements.push(
      d1.prepare(`INSERT INTO fdp_epi_returns
        (id, workspace_id, company_id, delivery_id, product_id, employee_id, returned_on, quantity, ca_number, size,
         epi_condition, received_by, needs_sanitizing, back_to_stock, send_to_disposal, generate_dp_demand,
         discount_request_id, disposal_id, notes, created_by, updated_by, stock_location_id, idempotency_key,
         sanitization_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(returnId, workspace.id, delivery.company_id, delivery.id, product.id, employee.id, returnedOn, quantity,
          delivery.ca_number, delivery.size, condition, epiText(body.receivedBy, "o responsável pelo recebimento", 120) || user.id,
          routing.needsSanitizing ? 1 : 0, routing.backToStock ? 1 : 0, routing.sendToDisposal ? 1 : 0,
          routing.generateDpDemand ? 1 : 0, discountRequestId, disposalId, notes, user.id, user.id,
          location.id, idempotencyKey, routing.needsSanitizing ? "awaiting" : "not_required"),
      // A baixa na entrega é o que faz o colaborador deixar de constar com o
      // equipamento. Sem ela, "EPIs ativos com o colaborador" nunca zeraria.
      d1.prepare("UPDATE fdp_epi_deliveries SET settled_quantity = settled_quantity + ?, updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
        .bind(quantity, user.id, workspace.id, delivery.id),
      prepareEpiMovement({
        workspaceId: workspace.id, companyId: delivery.company_id, cnpj: company.tax_id, movementDate: returnedOn,
        movementType: routing.needsSanitizing ? "sanitizing" : "return", productId: product.id, epiName: product.name,
        caNumber: delivery.ca_number, size: delivery.size, employeeId: employee.id,
        employeeName: employeeDisplayName(employee), quantity, stockDelta: routing.backToStock ? quantity : 0,
        unitValue: Number(delivery.unit_value), reason: condition, condition, status: routing.productStatus,
        generateDpDemand: routing.generateDpDemand, demandId: demandCardId, discountRequestId,
        sourceType: "return", sourceId: returnId, responsibleId: user.id, attachments, notes, createdBy: user.id,
        stockLocationId: location.id, idempotencyKey: idempotencyKey ? `${idempotencyKey}:movement` : "",
      }),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_return.created",
        entityType: "epi_return", entityId: returnId,
        after: { returnId, deliveryId: delivery.id, condition, quantity, ...routing },
        metadata: { disposalId, discountRequestId, demandCardId }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    );

    await d1.batch(statements);
    return Response.json({
      return: { id: returnId, deliveryId: delivery.id, condition, quantity, ...routing },
      disposalId, discountRequestId, demandCardId,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
