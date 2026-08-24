import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { damageRouting, epiDamageReasonLabels, epiDiscountTriggerLabels } from "@/lib/epi";
import {
  attachmentIds, createDiscountRequest, employeeDisplayName, epiDate, epiQuantity, epiText,
  loadCompany, loadEmployee, loadProduct, loadStockLocation, parseDamageDecision, parseDamageReason,
  prepareEpiMovement, prepareStockChange, verifiedAttachments,
} from "@/lib/epi-service";

/**
 * Troca de EPI por danificação.
 *
 * A decisão da análise governa tudo o que acontece depois — baixa do
 * equipamento antigo, entrega do novo, ida para descarte, ida para higienização
 * e abertura da demanda de desconto. A tabela dessas consequências mora em
 * `damageRouting`, não espalhada em `if` aqui, porque ela é a mesma regra que a
 * tela precisa mostrar antes de a pessoa confirmar.
 *
 * "Enviar para análise de desconto" é o único caminho que abre demanda, e ele
 * abre uma análise — não um desconto.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar danificações de EPI");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ damages: [], nextCursor: null });

    const where = ["dm.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`dm.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids);
    }
    if (companyId) { where.push("dm.company_id = ?"); values.push(companyId); }
    const employeeId = cleanText(url.searchParams.get("employeeId"), 120);
    if (employeeId) { where.push("dm.employee_id = ?"); values.push(employeeId); }
    const decision = cleanText(url.searchParams.get("decision"), 60);
    if (decision) { where.push("dm.decision = ?"); values.push(decision); }
    const from = epiDate(url.searchParams.get("from"), "a data inicial", false);
    if (from) { where.push("dm.occurred_on >= ?"); values.push(from); }
    const to = epiDate(url.searchParams.get("to"), "a data final", false);
    if (to) { where.push("dm.occurred_on <= ?"); values.push(to); }
    const cursor = cleanText(url.searchParams.get("cursor"), 120);
    if (cursor) { where.push("dm.id > ?"); values.push(cursor); }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

    const result = await d1.prepare(`SELECT dm.*, p.name AS epi_name, rp.name AS replacement_epi_name,
        e.full_name AS employee_full_name, e.social_name AS employee_social_name, c.trade_name AS company_trade_name,
        c.legal_name AS company_legal_name,
        (SELECT COUNT(*) FROM fdp_epi_attachments a WHERE a.workspace_id = dm.workspace_id AND a.entity_type = 'damage' AND a.entity_id = dm.id) AS attachments_count
      FROM fdp_epi_damages dm
      JOIN fdp_epi_products p ON p.workspace_id = dm.workspace_id AND p.id = dm.product_id
      LEFT JOIN fdp_epi_products rp ON rp.workspace_id = dm.workspace_id AND rp.id = dm.replacement_product_id
      JOIN fdp_employees e ON e.workspace_id = dm.workspace_id AND e.id = dm.employee_id
      JOIN fdp_companies c ON c.workspace_id = dm.workspace_id AND c.id = dm.company_id
      WHERE ${where.join(" AND ")} ORDER BY dm.id LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit);
    return Response.json({ damages: rows, nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.damage", "registrar danificação de EPI");
    const companyId = epiText(body.companyId, "a empresa", 120, true);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const decision = parseDamageDecision(body.decision);
    const routing = damageRouting(decision);
    const damageReason = parseDamageReason(body.damageReason);
    const occurredOn = epiDate(body.occurredOn, "a data da ocorrência") as string;
    const description = epiText(body.description, "a descrição do ocorrido", 2000, true);
    const notes = epiText(body.notes, "a observação", 2000);
    const attachments = await verifiedAttachments(d1, workspace.id, attachmentIds(body.attachmentIds));
    const analystUserId = epiText(body.analystUserId, "o responsável pela análise", 120) || user.id;

    const [company, product, employee] = await Promise.all([
      loadCompany(d1, workspace.id, companyId),
      loadProduct(d1, workspace.id, epiText(body.productId, "o EPI danificado", 120, true)),
      loadEmployee(d1, workspace.id, companyId, epiText(body.employeeId, "o colaborador", 120, true)),
    ]);

    const deliveryId = epiText(body.deliveryId, "a entrega de origem", 120) || null;
    const delivery = deliveryId
      ? await d1.prepare("SELECT id, quantity, settled_quantity, status FROM fdp_epi_deliveries WHERE workspace_id = ? AND id = ? AND company_id = ?")
        .bind(workspace.id, deliveryId, companyId).first<{ id: string; quantity: number; settled_quantity: number; status: string }>()
      : null;
    if (deliveryId && !delivery) throw ApiError.notFound("Entrega de origem não encontrada.", "EPI_DELIVERY_NOT_FOUND");
    const outstanding = delivery ? Number(delivery.quantity) - Number(delivery.settled_quantity) : Number.MAX_SAFE_INTEGER;
    const quantity = epiQuantity(body.quantity ?? 1, "Quantidade danificada", { min: 1, max: Math.max(outstanding, 1) });
    if (delivery && quantity > outstanding) {
      throw ApiError.badRequest("A quantidade danificada é maior do que a que ainda está com o colaborador.", "EPI_QUANTITY_ABOVE_OUTSTANDING");
    }

    // O EPI de reposição só é exigido quando a decisão prevê entregar um novo.
    const replacementProductId = epiText(body.replacementProductId, "o novo EPI", 120) || null;
    if (routing.deliverReplacement && decision === "exchange_without_discount" && !replacementProductId) {
      throw ApiError.badRequest("Informe o novo EPI que será entregue na troca.", "EPI_REPLACEMENT_REQUIRED");
    }
    const replacement = replacementProductId ? await loadProduct(d1, workspace.id, replacementProductId) : null;
    const replacementQuantity = replacement ? epiQuantity(body.replacementQuantity ?? quantity, "Quantidade do novo EPI") : 0;
    const location = await loadStockLocation(d1, workspace.id, epiText(body.stockLocationId, "o local de estoque", 120));
    const idempotencyKey = epiText(request.headers.get("idempotency-key") ?? body.idempotencyKey, "a chave de idempotência", 160);
    if (idempotencyKey) {
      const replay = await d1.prepare("SELECT * FROM fdp_epi_damages WHERE workspace_id = ? AND idempotency_key = ?")
        .bind(workspace.id, idempotencyKey).first<Record<string, unknown>>();
      if (replay) return Response.json({ damage: replay, replayed: true });
    }

    const damageId = crypto.randomUUID();
    const statements = [] as ReturnType<typeof prepareEpiMovement>[];
    let disposalId: string | null = null;
    let discountRequestId: string | null = null;
    let demandCardId: string | null = null;
    let replacementDeliveryId: string | null = null;

    if (routing.settleOldDelivery && delivery) {
      statements.push(d1.prepare("UPDATE fdp_epi_deliveries SET settled_quantity = settled_quantity + ?, updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
        .bind(quantity, user.id, workspace.id, delivery.id));
    }

    if (routing.createDisposal && routing.disposalReason) {
      disposalId = crypto.randomUUID();
      statements.push(d1.prepare(`INSERT INTO fdp_epi_disposals
        (id, workspace_id, company_id, product_id, employee_id, disposal_date, quantity, ca_number, size,
         disposal_reason, responsible_user_id, status, origin_type, origin_id, notes, created_by, updated_by,
         stock_location_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_disposal', 'damage', ?, ?, ?, ?, ?, ?)`)
        .bind(disposalId, workspace.id, companyId, product.id, employee.id, occurredOn, quantity,
          product.ca_number, product.size, routing.disposalReason, analystUserId, damageId,
          `Danificação: ${epiDamageReasonLabels[damageReason]}.`, user.id, user.id,
          location.id, idempotencyKey ? `${idempotencyKey}:disposal` : ""));
    }

    if (routing.discountTrigger) {
      const analysis = await createDiscountRequest(d1, {
        workspaceId: workspace.id, boardId: board.id, companyId, company, employee, product,
        deliveryId: delivery?.id ?? null, deliveredOn: null, occurredOn, quantity,
        unitValue: Number(product.unit_value), trigger: routing.discountTrigger,
        triggerLabel: epiDiscountTriggerLabels[routing.discountTrigger],
        note: `${epiDamageReasonLabels[damageReason]}. ${description}`.slice(0, 2000),
        analystUserId, attachments, actorUserId: user.id, actorEmail: auth.user.email,
      });
      discountRequestId = analysis.id;
      demandCardId = analysis.cardId;
      statements.push(...analysis.statements);
    }

    if (replacement && routing.deliverReplacement && replacementQuantity > 0) {
      // A entrega do substituto é uma entrega comum: debita estoque, gera termo
      // e entra no histórico do colaborador como qualquer outra.
      statements.push(prepareStockChange(d1, {
        workspaceId: workspace.id, productId: replacement.id, stockLocationId: location.id,
        delta: -replacementQuantity, actorId: user.id,
      }));
      replacementDeliveryId = crypto.randomUUID();
      statements.push(
        d1.prepare(`INSERT INTO fdp_epi_deliveries
          (id, workspace_id, company_id, product_id, employee_id, delivered_on, position_name, department_name,
           ca_number, size, quantity, unit_value, responsible_user_id, delivery_reason, status, notes, created_by, updated_by,
           stock_location_id, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'damage_replacement', 'pending_signature', ?, ?, ?, ?, ?)`)
          .bind(replacementDeliveryId, workspace.id, companyId, replacement.id, employee.id, occurredOn,
            employee.position_name ?? "", employee.department_name ?? "",
            epiText(body.replacementCaNumber, "o CA do novo EPI", 40) || replacement.ca_number,
            epiText(body.replacementSize, "o tamanho do novo EPI", 40) || replacement.size,
            replacementQuantity, Number(replacement.unit_value), analystUserId,
            `Substituição por danificação registrada em ${occurredOn}.`, user.id, user.id,
            location.id, idempotencyKey ? `${idempotencyKey}:replacement` : ""),
        prepareEpiMovement({
          workspaceId: workspace.id, companyId, cnpj: company.tax_id, movementDate: occurredOn,
          movementType: "exchange", productId: replacement.id, epiName: replacement.name,
          caNumber: replacement.ca_number, size: replacement.size, employeeId: employee.id,
          employeeName: employeeDisplayName(employee), quantity: replacementQuantity,
          stockDelta: -replacementQuantity, unitValue: Number(replacement.unit_value),
          reason: "damage_replacement", status: "pending_signature", sourceType: "delivery",
          sourceId: replacementDeliveryId, responsibleId: analystUserId, createdBy: user.id,
          stockLocationId: location.id, idempotencyKey: idempotencyKey ? `${idempotencyKey}:replacement-movement` : "",
        }),
      );
    }

    statements.push(
      d1.prepare(`INSERT INTO fdp_epi_damages
        (id, workspace_id, company_id, employee_id, product_id, delivery_id, occurred_on, quantity, damage_reason,
         description, analyst_user_id, decision, replacement_product_id, replacement_ca_number, replacement_size,
         replacement_quantity, replacement_delivery_id, disposal_id, discount_request_id, notes, created_by, updated_by,
         stock_location_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(damageId, workspace.id, companyId, employee.id, product.id, delivery?.id ?? null, occurredOn, quantity,
          damageReason, description, analystUserId, decision, replacement?.id ?? null,
          epiText(body.replacementCaNumber, "o CA do novo EPI", 40), epiText(body.replacementSize, "o tamanho do novo EPI", 40),
          replacementQuantity, replacementDeliveryId, disposalId, discountRequestId, notes, user.id, user.id,
          location.id, idempotencyKey),
      prepareEpiMovement({
        workspaceId: workspace.id, companyId, cnpj: company.tax_id, movementDate: occurredOn,
        movementType: routing.productStatus === "sanitizing" ? "sanitizing" : "exchange", productId: product.id,
        epiName: product.name, caNumber: product.ca_number, size: product.size, employeeId: employee.id,
        employeeName: employeeDisplayName(employee), quantity, stockDelta: 0, unitValue: Number(product.unit_value),
        reason: damageReason, condition: "returned_damaged", status: decision,
        generateDpDemand: Boolean(routing.discountTrigger), demandId: demandCardId, discountRequestId,
        sourceType: "damage", sourceId: damageId, responsibleId: analystUserId, attachments,
        notes: description, createdBy: user.id, stockLocationId: location.id,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:movement` : "",
      }),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_damage.created",
        entityType: "epi_damage", entityId: damageId,
        after: { damageId, decision, damageReason, quantity, employeeId: employee.id, productId: product.id },
        metadata: { disposalId, discountRequestId, demandCardId, replacementDeliveryId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    );

    await d1.batch(statements);
    return Response.json({
      damage: { id: damageId, decision, damageReason, quantity, ...routing },
      disposalId, discountRequestId, demandCardId, replacementDeliveryId,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
