import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { findContractorClosing } from "@/lib/payment-service";
import { requiredReason } from "@/lib/payments";

type Params = { params: Promise<{ id: string }> };

/**
 * Detalhe do fechamento PJ: o usuário deve responder de imediato
 * quanto pagar, quanto pedir de nota e quanto carregar no Caju.
 */
export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.read");
    const closing = await findContractorClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);

    const [full, components, provider] = await Promise.all([
      d1.prepare(`SELECT * FROM fdp_contractor_closings WHERE workspace_id = ? AND id = ? AND excluded_at IS NULL`).bind(workspace.id, id).first<Record<string, unknown>>(),
      d1.prepare(`SELECT id, direction, component_type, description, component_quantity, amount, settlement_target, origin,
          document_reference, status, created_at
        FROM fdp_contractor_components WHERE workspace_id = ? AND closing_id = ? ORDER BY direction, component_type`).bind(workspace.id, id).all(),
      d1.prepare(`SELECT a.id, a.code, a.legal_name, a.trade_name, a.tax_id, p.contract_reference, p.role_title, p.complement_platform, p.complement_external_id
        FROM fdp_auxiliary_providers a JOIN fdp_contractor_profiles p ON p.workspace_id = a.workspace_id AND p.provider_id = a.id
        WHERE a.workspace_id = ? AND a.id = ?`).bind(workspace.id, closing.provider_id).first(),
    ]);

    return Response.json({
      closing: full,
      provider,
      components: components.results,
      permissions: {
        manage: hasCapability(workspace, "contractors.payments.manage"),
        close: hasCapability(workspace, "contractors.payments.close"),
        reopen: hasCapability(workspace, "payments.reopen"),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * "Excluir pagamento" é exclusão lógica: a linha sai da operação e dos totais,
 * mas o fechamento original continua no banco e na auditoria.
 */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const closing = await findContractorClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);
    if (closing.status === "paid" || closing.status === "closed") {
      requireCapability(workspace, "payments.reopen");
    }
    const reason = requiredReason(body.reason, "CONTRACTOR_CLOSING_EXCLUSION_REASON_REQUIRED");

    await d1.batch([
      d1.prepare(`UPDATE fdp_contractor_closings
        SET excluded_at = now(), excluded_by = ?, exclusion_reason = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND excluded_at IS NULL`)
        .bind(user.id, reason, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id,
        actorUserId: user.id,
        actorEmail: auth.user.email,
        action: "contractor_closing.excluded",
        entityType: "contractor_closing",
        entityId: id,
        before: {
          status: closing.status,
          competence: closing.competence,
          providerId: closing.provider_id,
          netAmount: Number(closing.net_amount),
          invoiceExpectedAmount: Number(closing.invoice_expected_amount),
          complementAmount: Number(closing.complement_amount),
          cajuAmount: Number(closing.caju_amount),
        },
        after: { excluded: true },
        metadata: { reasonProvided: true },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ closing: { id, excluded: true } });
  } catch (error) {
    return apiError(error);
  }
}
