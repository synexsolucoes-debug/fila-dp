import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import {
  applyStockChange, employeeDisplayName, epiText, loadCompany, loadEmployee, loadProduct,
  parseDeliveryStatus, prepareEpiMovement,
} from "@/lib/epi-service";

type RouteContext = { params: Promise<{ id: string }> };

type DeliveryRow = {
  id: string; company_id: string; product_id: string; employee_id: string; quantity: number;
  settled_quantity: number; status: string; ca_number: string; size: string; unit_value: string | number;
  delivered_on: string; signature_name: string;
};

async function deliveryOf(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"], workspaceId: string, id: string) {
  const delivery = await d1.prepare("SELECT * FROM fdp_epi_deliveries WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, id).first<DeliveryRow>();
  if (!delivery) throw ApiError.notFound("Entrega não encontrada.", "EPI_DELIVERY_NOT_FOUND");
  return delivery;
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar entregas de EPI");
    const delivery = await deliveryOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, delivery.company_id);
    const [attachments, returns] = await Promise.all([
      d1.prepare(`SELECT id, attachment_kind, filename, content_type, size_bytes, created_at
        FROM fdp_epi_attachments WHERE workspace_id = ? AND entity_type = 'delivery' AND entity_id = ? ORDER BY created_at`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare("SELECT * FROM fdp_epi_returns WHERE workspace_id = ? AND delivery_id = ? ORDER BY returned_on")
        .bind(workspace.id, id).all<Record<string, unknown>>(),
    ]);
    return Response.json({ delivery, attachments: attachments.results, returns: returns.results });
  } catch (error) { return apiError(error); }
}

/**
 * Assinatura e cancelamento da entrega.
 *
 * São os dois únicos campos que mudam depois de gravada. Quantidade, EPI e
 * colaborador não: alterá-los reescreveria um termo já assinado, e o caminho
 * correto para corrigir uma entrega errada é cancelá-la — o que devolve o
 * estoque e deixa o registro do cancelamento no razão.
 *
 * Cancelar só é possível enquanto nada foi devolvido contra a entrega. Depois
 * disso a devolução já contou o equipamento de volta, e desfazer a entrega
 * somaria a unidade duas vezes.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.deliver", "atualizar entregas de EPI");
    const before = await deliveryOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, before.company_id);
    if (before.status === "canceled") throw ApiError.badRequest("Esta entrega já foi cancelada.", "EPI_DELIVERY_CANCELED");

    const status = parseDeliveryStatus(body.status ?? before.status);
    const signatureName = body.signatureName === undefined ? before.signature_name : epiText(body.signatureName, "a assinatura", 160);
    if (status === "signed" && !signatureName) {
      throw ApiError.badRequest("Informe quem assinou o termo de entrega.", "EPI_SIGNATURE_REQUIRED");
    }

    if (status === "canceled") {
      if (Number(before.settled_quantity) > 0) {
        throw new ApiError(409, "EPI_DELIVERY_SETTLED",
          "Esta entrega já tem devolução registrada e não pode ser cancelada. Registre a movimentação corretiva no estoque.");
      }
      const reason = epiText(body.canceledReason, "o motivo do cancelamento", 400, true);
      const [company, product, employee] = await Promise.all([
        loadCompany(d1, workspace.id, before.company_id),
        loadProduct(d1, workspace.id, before.company_id, before.product_id),
        loadEmployee(d1, workspace.id, before.company_id, before.employee_id),
      ]);
      await applyStockChange(d1, workspace.id, before.product_id, Number(before.quantity), "in_stock", user.id);
      await d1.batch([
        d1.prepare(`UPDATE fdp_epi_deliveries SET status = 'canceled', canceled_reason = ?, updated_by = ?, updated_at = now()
          WHERE workspace_id = ? AND id = ?`).bind(reason, user.id, workspace.id, id),
        prepareEpiMovement({
          workspaceId: workspace.id, companyId: before.company_id, cnpj: company.tax_id,
          movementDate: new Date().toISOString().slice(0, 10), movementType: "manual_adjustment",
          productId: before.product_id, epiName: product.name, caNumber: before.ca_number, size: before.size,
          employeeId: before.employee_id, employeeName: employeeDisplayName(employee),
          quantity: Number(before.quantity), stockDelta: Number(before.quantity), unitValue: Number(before.unit_value),
          reason: "manual_adjustment", status: "canceled", sourceType: "delivery", sourceId: id,
          responsibleId: user.id, notes: reason, createdBy: user.id,
        }),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_delivery.canceled",
          entityType: "epi_delivery", entityId: id, before, after: { status: "canceled", canceledReason: reason },
          metadata: { restoredStock: Number(before.quantity) }, requestId: request.headers.get("x-fila-dp-request-id"),
        }),
      ]);
      return Response.json({ delivery: { id, status: "canceled", canceledReason: reason } });
    }

    await d1.batch([
      d1.prepare(`UPDATE fdp_epi_deliveries SET status = ?, signature_name = ?,
        signed_at = CASE WHEN ? = 'signed' THEN COALESCE(signed_at, now()) ELSE signed_at END,
        notes = COALESCE(?, notes), updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(status, signatureName, status, body.notes === undefined ? null : epiText(body.notes, "a observação", 2000), user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_delivery.updated",
        entityType: "epi_delivery", entityId: id, before, after: { status, signatureName },
        metadata: { signed: status === "signed" }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ delivery: { id, status, signatureName } });
  } catch (error) { return apiError(error); }
}
