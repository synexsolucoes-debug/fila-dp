import type { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { contractorSettlementTarget, positiveMoney, requiredReason, type ContractorComponentDirection } from "@/lib/payments";
import { requireContractorProfile, requireCycle, upsertContractorClosing } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };
type Database = ReturnType<typeof getD1>;

async function loadComponent(d1: Database, workspaceId: string, id: string) {
  const component = await d1.prepare(`SELECT c.id, c.company_id, c.provider_id, c.payroll_cycle_id, c.closing_id, c.direction,
      c.component_type, c.amount, c.settlement_target, c.origin, c.status, k.status AS closing_status, k.excluded_at AS closing_excluded_at
    FROM fdp_contractor_components c
    LEFT JOIN fdp_contractor_closings k ON k.workspace_id = c.workspace_id AND k.id = c.closing_id
    WHERE c.workspace_id = ? AND c.id = ?`)
    .bind(workspaceId, id)
    .first<{
      id: string; company_id: string; provider_id: string; payroll_cycle_id: string; closing_id: string | null;
      direction: string; component_type: string; amount: string | number; settlement_target: string; origin: string;
      status: string; closing_status: string | null; closing_excluded_at: string | null;
    }>();
  if (!component) throw ApiError.notFound("Componente não encontrado.", "CONTRACTOR_COMPONENT_NOT_FOUND");
  if (component.closing_status === "closed" || component.closing_status === "paid") {
    throw ApiError.badRequest("O fechamento desta competência está concluído. Reabra com justificativa para alterar componentes.", "PAYMENT_CLOSING_LOCKED");
  }
  if (component.closing_excluded_at) {
    throw ApiError.notFound("Este pagamento foi excluído da competência.", "CONTRACTOR_CLOSING_NOT_FOUND");
  }
  if (component.origin === "fixed_item") {
    throw ApiError.badRequest(
      "Este lançamento vem de um valor fixo recorrente. Altere o lançamento fixo de origem para não perder a mudança na próxima reapuração.",
      "FIXED_COMPONENT_EDIT_REQUIRES_SOURCE",
    );
  }
  return component;
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const component = await loadComponent(d1, workspace.id, id);
    if (component.status !== "active") throw ApiError.badRequest("O componente está cancelado.", "COMPONENT_CANCELED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, component.company_id);

    const amount = positiveMoney(body.amount ?? component.amount, "Valor do componente");
    if (amount <= 0) throw ApiError.badRequest("Informe um valor maior que zero.", "COMPONENT_AMOUNT_REQUIRED");

    /* Incidência omitida mantém a que está gravada: quem só corrige o valor não
       deveria devolver o desconto para o lado errado sem ter pedido. */
    const settlementTarget = contractorSettlementTarget(
      body.settlementTarget ?? component.settlement_target,
      component.direction as ContractorComponentDirection,
    );

    await d1.batch([
      d1.prepare(`UPDATE fdp_contractor_components SET amount = ?, description = ?, component_quantity = ?, settlement_target = ?,
          document_reference = ?, note = ?
        WHERE workspace_id = ? AND id = ? AND status = 'active'`)
        .bind(amount, cleanText(body.description, 240), Math.max(Number(body.quantity) || 1, 0), settlementTarget,
          cleanText(body.documentReference, 160), cleanText(body.note, 300), workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_component.updated", entityType: "contractor_component", entityId: id,
        before: { amount: Number(component.amount), settlementTarget: component.settlement_target },
        after: { amount, settlementTarget },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    let recalculated = null;
    if (component.closing_id) {
      const profile = await requireContractorProfile(d1, workspace.id, component.provider_id);
      const cycle = await requireCycle(d1, workspace.id, component.company_id, component.payroll_cycle_id);
      recalculated = await upsertContractorClosing(d1, { workspaceId: workspace.id, profile, cycle, userId: user.id });
    }
    return Response.json({
      component: { id, amount, settlementTarget },
      closing: recalculated ? { id: recalculated.closingId, ...recalculated.calculation } : null,
    });
  } catch (error) {
    return apiError(error);
  }
}

/** Componentes não são apagados: cancelar preserva a trilha da competência. */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const component = await loadComponent(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, component.company_id);
    const reason = requiredReason(body.reason, "CANCELLATION_REASON_REQUIRED");

    await d1.batch([
      d1.prepare("UPDATE fdp_contractor_components SET status = 'canceled', canceled_reason = ? WHERE workspace_id = ? AND id = ? AND status = 'active'")
        .bind(reason, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_component.canceled", entityType: "contractor_component", entityId: id,
        before: { status: component.status, amount: Number(component.amount) }, after: { status: "canceled" },
        metadata: { reasonProvided: true },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    let recalculated = null;
    if (component.closing_id) {
      const profile = await requireContractorProfile(d1, workspace.id, component.provider_id);
      const cycle = await requireCycle(d1, workspace.id, component.company_id, component.payroll_cycle_id);
      recalculated = await upsertContractorClosing(d1, { workspaceId: workspace.id, profile, cycle, userId: user.id });
    }
    return Response.json({
      component: { id, status: "canceled" },
      closing: recalculated ? { id: recalculated.closingId, ...recalculated.calculation } : null,
    });
  } catch (error) {
    return apiError(error);
  }
}
