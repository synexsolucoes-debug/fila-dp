import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { findPsychologyClosing } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };

/** Detalhe do fechamento: consultas que o compõem, ajustes e pagamento. */
export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "psychology.payments.read");
    const closing = await findPsychologyClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);

    const [sessions, adjustments, payment, provider] = await Promise.all([
      d1.prepare(`SELECT s.id, s.employee_id, s.session_date, s.session_quantity, s.unit_amount, s.total_amount, s.status,
          s.administrative_note, s.origin, e.full_name AS employee_name, e.registration_number
        FROM fdp_psychology_sessions s JOIN fdp_employees e ON e.workspace_id = s.workspace_id AND e.id = s.employee_id
        WHERE s.workspace_id = ? AND s.closing_id = ? ORDER BY s.session_date, e.full_name`).bind(workspace.id, id).all(),
      d1.prepare(`SELECT id, kind, amount, reason, previous_amount, new_amount, created_by, created_at
        FROM fdp_psychology_adjustments WHERE workspace_id = ? AND closing_id = ? ORDER BY created_at`).bind(workspace.id, id).all(),
      d1.prepare(`SELECT id, amount, method, status, scheduled_date, paid_date, invoice_number, invoice_amount, invoice_issue_date,
          invoice_status, receipt_reference, note FROM fdp_psychology_payments WHERE workspace_id = ? AND closing_id = ?`)
        .bind(workspace.id, id).first(),
      d1.prepare("SELECT id, legal_name, trade_name, code FROM fdp_auxiliary_providers WHERE workspace_id = ? AND id = ?")
        .bind(workspace.id, closing.provider_id).first(),
    ]);

    return Response.json({
      closing,
      provider,
      sessions: sessions.results,
      adjustments: adjustments.results,
      payment,
      permissions: {
        manage: hasCapability(workspace, "psychology.payments.manage"),
        close: hasCapability(workspace, "psychology.payments.close"),
        reopen: hasCapability(workspace, "payments.reopen"),
      },
      privacyBoundary: "Somente informação administrativa e financeira do pagamento das consultas.",
    });
  } catch (error) {
    return apiError(error);
  }
}
