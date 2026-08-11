import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { findContractorClosing } from "@/lib/payment-service";

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
      d1.prepare(`SELECT * FROM fdp_contractor_closings WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>(),
      d1.prepare(`SELECT id, direction, component_type, description, component_quantity, amount, origin, document_reference, status, created_at
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
