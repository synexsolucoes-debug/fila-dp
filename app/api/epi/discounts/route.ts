import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { epiDiscountTriggerLabels } from "@/lib/epi";
import {
  attachmentIds, createDiscountRequest, epiDate, epiMoney, epiQuantity, epiText, loadCompany,
  loadEmployee, loadProduct, parseDiscountTrigger, verifiedAttachments,
} from "@/lib/epi-service";

/**
 * Análises de possível desconto.
 *
 * Toda linha aqui tem uma demanda no quadro do DP por trás — as automáticas,
 * abertas pela devolução e pela troca, e as manuais, abertas por esta rota. O
 * valor nunca é lançado: ele fica registrado como "em análise" até que alguém
 * com `epi.discount.analyze` decida, e mesmo a decisão só grava o parecer.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar análises de desconto de EPI");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ discounts: [], nextCursor: null });

    const where = ["dr.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`dr.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids);
    }
    if (companyId) { where.push("dr.company_id = ?"); values.push(companyId); }
    const employeeId = cleanText(url.searchParams.get("employeeId"), 120);
    if (employeeId) { where.push("dr.employee_id = ?"); values.push(employeeId); }
    const status = cleanText(url.searchParams.get("status"), 40);
    if (status) { where.push("dr.status = ?"); values.push(status); }
    if (url.searchParams.get("open") === "true") where.push("dr.status IN ('awaiting_dp_analysis', 'awaiting_approval')");
    const from = epiDate(url.searchParams.get("from"), "a data inicial", false);
    if (from) { where.push("dr.occurred_on >= ?"); values.push(from); }
    const to = epiDate(url.searchParams.get("to"), "a data final", false);
    if (to) { where.push("dr.occurred_on <= ?"); values.push(to); }
    const cursor = cleanText(url.searchParams.get("cursor"), 120);
    if (cursor) { where.push("dr.id > ?"); values.push(cursor); }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

    const result = await d1.prepare(`SELECT dr.*, p.name AS epi_name, e.full_name AS employee_full_name,
        e.social_name AS employee_social_name, e.registration_number,
        c.trade_name AS company_trade_name, c.legal_name AS company_legal_name, c.tax_id AS company_tax_id,
        card.title AS demand_title, card.archived AS demand_archived,
        (SELECT COUNT(*) FROM fdp_epi_attachments a WHERE a.workspace_id = dr.workspace_id AND a.entity_type = 'discount' AND a.entity_id = dr.id) AS attachments_count
      FROM fdp_epi_discount_requests dr
      JOIN fdp_epi_products p ON p.workspace_id = dr.workspace_id AND p.id = dr.product_id
      JOIN fdp_employees e ON e.workspace_id = dr.workspace_id AND e.id = dr.employee_id
      JOIN fdp_companies c ON c.workspace_id = dr.workspace_id AND c.id = dr.company_id
      LEFT JOIN fdp_cards card ON card.workspace_id = dr.workspace_id AND card.id = dr.card_id
      WHERE ${where.join(" AND ")} ORDER BY dr.id LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit);
    return Response.json({
      discounts: rows,
      canAnalyze: workspace.role === "admin" || workspace.role === "member",
      nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null,
    });
  } catch (error) { return apiError(error); }
}

/** Solicitação manual de desconto — o gatilho que não vem de outra rotina. */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.discount.analyze", "abrir análise de desconto de EPI");
    const companyId = epiText(body.companyId, "a empresa", 120, true);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const [company, product, employee] = await Promise.all([
      loadCompany(d1, workspace.id, companyId),
      loadProduct(d1, workspace.id, epiText(body.productId, "o EPI", 120, true)),
      loadEmployee(d1, workspace.id, companyId, epiText(body.employeeId, "o colaborador", 120, true)),
    ]);
    const deliveryId = epiText(body.deliveryId, "a entrega", 120) || null;
    const delivery = deliveryId
      ? await d1.prepare("SELECT id, delivered_on, unit_value FROM fdp_epi_deliveries WHERE workspace_id = ? AND id = ? AND company_id = ?")
        .bind(workspace.id, deliveryId, companyId).first<{ id: string; delivered_on: string; unit_value: string | number }>()
      : null;
    if (deliveryId && !delivery) throw ApiError.notFound("Entrega não encontrada.", "EPI_DELIVERY_NOT_FOUND");

    const trigger = parseDiscountTrigger(body.triggerReason ?? "manual_request");
    const idempotencyKey = epiText(request.headers.get("idempotency-key") ?? body.idempotencyKey, "a chave de idempotência", 160);
    if (idempotencyKey) {
      const replay = await d1.prepare("SELECT * FROM fdp_epi_discount_requests WHERE workspace_id = ? AND idempotency_key = ?")
        .bind(workspace.id, idempotencyKey).first<Record<string, unknown>>();
      if (replay) return Response.json({ discount: replay, replayed: true });
    }
    const quantity = epiQuantity(body.quantity ?? 1, "Quantidade");
    const unitValue = body.unitValue === undefined
      ? Number(delivery?.unit_value ?? product.unit_value)
      : epiMoney(body.unitValue, "Valor unitário");
    const analysis = await createDiscountRequest(d1, {
      workspaceId: workspace.id, boardId: board.id, companyId, company, employee, product,
      deliveryId: delivery?.id ?? null, deliveredOn: delivery?.delivered_on ?? null,
      occurredOn: epiDate(body.occurredOn, "a data da ocorrência") as string,
      quantity, unitValue, trigger, triggerLabel: epiDiscountTriggerLabels[trigger],
      note: epiText(body.reasonNote, "o motivo", 2000, true),
      analystUserId: epiText(body.analystUserId, "o responsável pela análise", 120) || user.id,
      attachments: await verifiedAttachments(d1, workspace.id, attachmentIds(body.attachmentIds)),
      actorUserId: user.id, actorEmail: auth.user.email, idempotencyKey,
    });
    await d1.batch([
      ...analysis.statements,
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_discount.created",
        entityType: "epi_discount_request", entityId: analysis.id,
        after: { id: analysis.id, trigger, quantity, unitValue, totalValue: analysis.totalValue, cardId: analysis.cardId },
        metadata: { manual: true, employeeId: employee.id }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({
      discount: { id: analysis.id, cardId: analysis.cardId, title: analysis.title, totalValue: analysis.totalValue, status: "awaiting_dp_analysis" },
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
