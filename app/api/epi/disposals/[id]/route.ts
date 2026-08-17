import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { disposalTouchesStock } from "@/lib/epi";
import { applyStockChange, epiText, loadCompany, loadProduct, prepareEpiMovement } from "@/lib/epi-service";

type RouteContext = { params: Promise<{ id: string }> };

type DisposalRow = {
  id: string; company_id: string; product_id: string; employee_id: string | null; quantity: number;
  ca_number: string; size: string; disposal_reason: string; status: string; origin_type: "manual" | "return" | "damage";
  disposal_date: string;
};

/**
 * Confirmação, cancelamento e reavaliação do descarte.
 *
 * Confirmar é definitivo por desenho: o gatilho no banco recusa qualquer
 * alteração posterior, e o EPI não volta ao estoque. Quem quiser desfazer
 * precisa fazê-lo **antes** de confirmar — daí existirem "Cancelado" e
 * "Reavaliado" como estados próprios, com motivo escrito.
 *
 * A baixa de estoque só acontece quando o descarte saiu do estoque. O que veio
 * de devolução ou de troca já foi debitado na entrega; debitar de novo tiraria
 * duas unidades por uma.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.dispose", "confirmar o descarte de EPI");
    const before = await d1.prepare("SELECT * FROM fdp_epi_disposals WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<DisposalRow>();
    if (!before) throw ApiError.notFound("Descarte não encontrado.", "EPI_DISPOSAL_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, before.company_id);
    if (before.status !== "awaiting_disposal") {
      throw new ApiError(409, "EPI_DISPOSAL_CLOSED",
        `Este descarte já está em "${before.status}" e não aceita nova decisão. Abra um novo registro se precisar tratar o equipamento outra vez.`);
    }

    const action = epiText(body.action, "a ação", 30, true);
    if (!["confirm", "cancel", "reevaluate"].includes(action)) {
      throw ApiError.badRequest("Ação inválida para o descarte.", "EPI_INVALID_DISPOSAL_ACTION");
    }
    const notes = epiText(body.notes, "o motivo", 2000, action !== "confirm");
    const [company, product] = await Promise.all([
      loadCompany(d1, workspace.id, before.company_id),
      loadProduct(d1, workspace.id, before.company_id, before.product_id),
    ]);

    if (action === "confirm") {
      const touchesStock = disposalTouchesStock(before.origin_type);
      if (touchesStock) {
        await applyStockChange(d1, workspace.id, before.product_id, -Number(before.quantity), "discarded", user.id);
      }
      try {
        await d1.batch([
          d1.prepare(`UPDATE fdp_epi_disposals SET status = 'disposed', confirmed_by = ?, confirmed_at = now(),
            notes = CASE WHEN ? = '' THEN notes ELSE ? END, updated_by = ?, updated_at = now()
            WHERE workspace_id = ? AND id = ?`)
            .bind(user.id, notes, notes, user.id, workspace.id, id),
          ...(touchesStock ? [] : [d1.prepare("UPDATE fdp_epi_products SET status = 'discarded', updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
            .bind(user.id, workspace.id, before.product_id)]),
          prepareEpiMovement({
            workspaceId: workspace.id, companyId: before.company_id, cnpj: company.tax_id,
            movementDate: new Date().toISOString().slice(0, 10), movementType: "disposal",
            productId: before.product_id, epiName: product.name, caNumber: before.ca_number, size: before.size,
            employeeId: before.employee_id, quantity: Number(before.quantity),
            stockDelta: touchesStock ? -Number(before.quantity) : 0, unitValue: Number(product.unit_value),
            reason: before.disposal_reason, status: "disposed", sourceType: "disposal", sourceId: id,
            responsibleId: user.id, notes, createdBy: user.id,
          }),
          prepareAuditEvent({
            workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_disposal.confirmed",
            entityType: "epi_disposal", entityId: id, before, after: { status: "disposed", confirmedBy: user.id },
            metadata: { stockRemoved: touchesStock ? Number(before.quantity) : 0, origin: before.origin_type },
            requestId: request.headers.get("x-fila-dp-request-id"),
          }),
        ]);
      } catch (error) {
        if (touchesStock) await applyStockChange(d1, workspace.id, before.product_id, Number(before.quantity), null, user.id).catch(() => undefined);
        throw error;
      }
      return Response.json({ disposal: { id, status: "disposed" } });
    }

    const status = action === "cancel" ? "canceled" : "reevaluated";
    await d1.batch([
      d1.prepare("UPDATE fdp_epi_disposals SET status = ?, notes = ?, updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
        .bind(status, notes, user.id, workspace.id, id),
      // Reavaliar devolve o equipamento à higienização: ele não foi descartado,
      // então precisa de um estado que diga o que fazer com ele em seguida.
      ...(status === "reevaluated"
        ? [d1.prepare("UPDATE fdp_epi_products SET status = 'sanitizing', updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
          .bind(user.id, workspace.id, before.product_id)]
        : []),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: status === "canceled" ? "epi_disposal.canceled" : "epi_disposal.reevaluated",
        entityType: "epi_disposal", entityId: id, before, after: { status, notes },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ disposal: { id, status, notes } });
  } catch (error) { return apiError(error); }
}
