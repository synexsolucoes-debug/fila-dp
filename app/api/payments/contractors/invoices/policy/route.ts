import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { requiredPaymentEnum } from "@/lib/payments";
import { invoiceReviewPolicies, sanitizeRequiredChecks } from "@/lib/contractor-invoices";
import { loadInvoicePolicy } from "@/lib/contractor-invoice-service";

/**
 * A política de nota fiscal do grupo.
 *
 * Duas decisões, e as duas são de quem opera o financeiro, não de quem faz o
 * deploy: o pagamento sai sem nota aprovada? e quais itens do checklist são
 * obrigatórios para aprovar? Deixar isso em código significaria que mudar de
 * ideia custa uma release — e a primeira consequência prática seria alguém
 * contornando a regra por fora do sistema.
 */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.read");
    return Response.json({ policy: await loadInvoicePolicy(d1, workspace.id) });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.update");

    const before = await loadInvoicePolicy(d1, workspace.id);
    const reviewPolicy = requiredPaymentEnum(body.reviewPolicy, invoiceReviewPolicies, "Política de conferência");
    const requiredChecks = sanitizeRequiredChecks(body.requiredChecks);

    // O grupo pode não ter linha de configuração ainda: `ON CONFLICT` cria a
    // primeira sem exigir que alguém tenha aberto a tela de ajustes antes.
    await d1.prepare(`INSERT INTO fdp_workspace_settings (workspace_id, invoice_review_policy, invoice_required_checks_json)
      VALUES (?, ?, ?::jsonb)
      ON CONFLICT (workspace_id) DO UPDATE
        SET invoice_review_policy = EXCLUDED.invoice_review_policy,
            invoice_required_checks_json = EXCLUDED.invoice_required_checks_json,
            updated_at = now()`)
      .bind(workspace.id, reviewPolicy, JSON.stringify(requiredChecks))
      .run();

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "contractor_invoice.policy_updated", entityType: "workspace_settings", entityId: workspace.id,
      before: { reviewPolicy: before.reviewPolicy, requiredChecks: before.requiredChecks },
      after: { reviewPolicy, requiredChecks },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ policy: { reviewPolicy, requiredChecks } });
  } catch (error) {
    return apiError(error);
  }
}
