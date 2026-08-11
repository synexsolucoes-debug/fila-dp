import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";

const modules = ["psychology", "contractors"] as const;
type PaymentModule = typeof modules[number];

function parseModule(value: unknown): PaymentModule {
  const candidate = cleanText(value, 20);
  if (!modules.includes(candidate as PaymentModule)) throw ApiError.badRequest("Módulo de pagamento inválido.", "INVALID_PAYMENT_MODULE");
  return candidate as PaymentModule;
}

/**
 * Painel operacional dos dois módulos de pagamento.
 *
 * Para PJ, devolve a tabela de fechamento pedida pelo produto: base, comissão e
 * demais créditos, descontos, líquido, limite, nota esperada, complemento/Caju
 * e os status de nota, complemento e fechamento.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const moduleType = parseModule(url.searchParams.get("module"));
    requireCapability(workspace, moduleType === "psychology" ? "psychology.payments.read" : "contractors.payments.read");

    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const requested = url.searchParams.get("competence") ? validCompetence(url.searchParams.get("competence")) : "";
    const cycles = await d1.prepare(`SELECT id, competence, status, payment_date, closed_at FROM fdp_payroll_cycles
      WHERE workspace_id = ? AND company_id = ? ORDER BY competence DESC LIMIT 36`).bind(workspace.id, companyId).all<Record<string, unknown>>();
    const competence = requested || String(cycles.results[0]?.competence ?? new Date().toISOString().slice(0, 7));
    const cycle = cycles.results.find((item) => item.competence === competence) ?? null;
    const cycleId = cycle ? String(cycle.id) : "";

    if (moduleType === "psychology") {
      const [closings, psychologists, pendingSessions] = await Promise.all([
        cycleId
          ? d1.prepare(`SELECT c.id, c.provider_id, c.competence, c.entries_count, c.sessions_count, c.employees_count, c.gross_amount,
              c.adjustments_amount, c.net_amount, c.status, c.calc_version, c.closed_at,
              a.legal_name AS psychologist_name, a.code AS psychologist_code,
              p.amount AS payment_amount, p.status AS payment_status, p.invoice_status, p.scheduled_date, p.paid_date
            FROM fdp_psychology_closings c
            JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
            LEFT JOIN fdp_psychology_payments p ON p.workspace_id = c.workspace_id AND p.closing_id = c.id
            WHERE c.workspace_id = ? AND c.company_id = ? AND c.payroll_cycle_id = ?
            ORDER BY a.legal_name`).bind(workspace.id, companyId, cycleId).all()
          : Promise.resolve({ results: [] }),
        d1.prepare(`SELECT a.id, a.code, a.legal_name, a.status, p.default_session_amount
          FROM fdp_auxiliary_providers a
          LEFT JOIN fdp_psychologist_profiles p ON p.workspace_id = a.workspace_id AND p.provider_id = a.id
          WHERE a.workspace_id = ? AND a.provider_type = 'psychologist' ORDER BY a.status, a.legal_name`).bind(workspace.id).all(),
        cycleId
          ? d1.prepare(`SELECT s.provider_id, count(*)::int AS entries, sum(s.total_amount) AS total
            FROM fdp_psychology_sessions s
            WHERE s.workspace_id = ? AND s.company_id = ? AND s.payroll_cycle_id = ? AND s.status = 'registered' AND s.closing_id IS NULL
            GROUP BY s.provider_id`).bind(workspace.id, companyId, cycleId).all()
          : Promise.resolve({ results: [] }),
      ]);
      return Response.json({
        module: moduleType, competence, cycle, cycles: cycles.results,
        closings: closings.results, psychologists: psychologists.results, unassignedSessions: pendingSessions.results,
        permissions: {
          manage: hasCapability(workspace, "psychology.payments.manage"),
          close: hasCapability(workspace, "psychology.payments.close"),
          reopen: hasCapability(workspace, "payments.reopen"),
        },
        privacyBoundary: "Controle administrativo e financeiro do pagamento das consultas; nenhum dado clínico é armazenado.",
      });
    }

    const [closings, contractors, policies] = await Promise.all([
      cycleId
        ? d1.prepare(`SELECT c.id, c.provider_id, c.competence, c.base_amount, c.credits_amount, c.debits_amount, c.net_amount,
            c.invoice_limit_amount, c.invoice_limit_source, c.invoice_expected_amount, c.complement_amount, c.complement_method,
            c.caju_amount, c.status, c.invoice_number, c.invoice_received_amount, c.invoice_status, c.caju_status, c.caju_batch_reference,
            c.complement_paid_amount, c.reconciliation_status, c.reconciliation_difference, c.calc_version, c.closed_at,
            a.legal_name AS contractor_name, a.code AS contractor_code, p.contract_reference, p.role_title
          FROM fdp_contractor_closings c
          JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
          LEFT JOIN fdp_contractor_profiles p ON p.workspace_id = c.workspace_id AND p.provider_id = c.provider_id
          WHERE c.workspace_id = ? AND c.company_id = ? AND c.payroll_cycle_id = ?
          ORDER BY a.legal_name`).bind(workspace.id, companyId, cycleId).all()
        : Promise.resolve({ results: [] }),
      d1.prepare(`SELECT a.id, a.code, a.legal_name, p.base_amount, p.invoice_limit_override, p.complement_method, p.contract_reference, p.status
        FROM fdp_contractor_profiles p JOIN fdp_auxiliary_providers a ON a.workspace_id = p.workspace_id AND a.id = p.provider_id
        WHERE p.workspace_id = ? AND p.company_id = ? ORDER BY p.status, a.legal_name`).bind(workspace.id, companyId).all(),
      d1.prepare(`SELECT id, scope, company_id, provider_id, contract_reference, amount, effective_from
        FROM fdp_invoice_limit_policies WHERE workspace_id = ? AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY scope, effective_from DESC`).bind(workspace.id, `${competence}-01`).all(),
    ]);

    const rows = closings.results as Record<string, unknown>[];
    return Response.json({
      module: moduleType, competence, cycle, cycles: cycles.results,
      closings: rows, contractors: contractors.results, invoiceLimitPolicies: policies.results,
      totals: {
        netAmount: rows.reduce((total, row) => total + Number(row.net_amount ?? 0), 0),
        invoiceExpectedAmount: rows.reduce((total, row) => total + Number(row.invoice_expected_amount ?? 0), 0),
        complementAmount: rows.reduce((total, row) => total + Number(row.complement_amount ?? 0), 0),
        cajuAmount: rows.reduce((total, row) => total + Number(row.caju_amount ?? 0), 0),
        divergentCount: rows.filter((row) => row.reconciliation_status === "divergent" || row.invoice_status === "divergent").length,
      },
      permissions: {
        manage: hasCapability(workspace, "contractors.payments.manage"),
        close: hasCapability(workspace, "contractors.payments.close"),
        reopen: hasCapability(workspace, "payments.reopen"),
        manageLimits: hasCapability(workspace, "contractors.limits.manage"),
        exportCaju: hasCapability(workspace, "contractors.export_caju"),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
