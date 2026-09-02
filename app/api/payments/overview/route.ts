import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";
import { invoicePaymentBlock, summarizeInvoiceCompetence } from "@/lib/contractor-invoices";
import { loadInvoicePolicy } from "@/lib/contractor-invoice-service";

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

    const [closings, contractors, fixedItems, monthlyEntries, policies] = await Promise.all([
      cycleId
        ? d1.prepare(`SELECT c.id, c.provider_id, c.competence, c.base_amount, c.contract_base_amount,
            c.proration_days, c.proration_total_days, c.proration_end_date, c.credits_amount, c.debits_amount, c.net_amount,
            c.invoice_limit_amount, c.invoice_limit_source, c.invoice_expected_amount, c.complement_amount, c.complement_method,
            c.caju_amount, c.status, c.invoice_number, c.invoice_received_amount, c.invoice_status,
            c.invoice_review_status, c.invoice_current_id, c.caju_status, c.caju_batch_reference,
            c.complement_paid_amount, c.reconciliation_status, c.reconciliation_difference, c.calc_version, c.closed_at,
            a.legal_name AS contractor_name, a.code AS contractor_code, p.contract_reference, p.role_title
          FROM fdp_contractor_closings c
          JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
          LEFT JOIN fdp_contractor_profiles p ON p.workspace_id = c.workspace_id AND p.provider_id = c.provider_id
          WHERE c.workspace_id = ? AND c.company_id = ? AND c.payroll_cycle_id = ? AND c.excluded_at IS NULL
          ORDER BY a.legal_name`).bind(workspace.id, companyId, cycleId).all()
        : Promise.resolve({ results: [] }),
      d1.prepare(`SELECT a.id, a.code, a.legal_name, p.base_amount, p.invoice_limit_override, p.complement_method, p.contract_reference, p.status
        FROM fdp_contractor_profiles p JOIN fdp_auxiliary_providers a ON a.workspace_id = p.workspace_id AND a.id = p.provider_id
        WHERE p.workspace_id = ? AND p.company_id = ? AND p.status = 'active' ORDER BY a.legal_name`).bind(workspace.id, companyId).all(),
      d1.prepare(`SELECT f.id, f.provider_id, f.direction, f.component_type, f.description, f.amount,
          f.effective_from, f.effective_to, f.status, f.note, a.legal_name AS contractor_name
        FROM fdp_contractor_fixed_items f
        JOIN fdp_auxiliary_providers a ON a.workspace_id = f.workspace_id AND a.id = f.provider_id
        JOIN fdp_contractor_profiles p ON p.workspace_id = f.workspace_id AND p.provider_id = f.provider_id
        WHERE f.workspace_id = ? AND f.company_id = ? AND p.status = 'active'
        ORDER BY f.status, a.legal_name, f.effective_from DESC, f.created_at DESC`)
        .bind(workspace.id, companyId).all(),
      /* Os lançamentos da competência — a natureza "mensal".
         A tela de Ajustes mostrava só os recorrentes, e quem lançava um
         desconto avulso não tinha onde conferir o que já lançou: o valor
         entrava na apuração e sumia de vista. Vêm daqui, junto dos fixos, para
         a tela poder mostrar as duas naturezas lado a lado.
         O lançamento vindo de item fixo é marcado pela origem, e não repetido:
         ele já aparece na lista dos recorrentes, e mostrá-lo duas vezes faria
         parecer que foi lançado em dobro. */
      cycleId
        ? d1.prepare(`SELECT k.id, k.provider_id, k.direction, k.component_type, k.description, k.amount,
            k.component_quantity, k.origin, k.document_reference, k.status, k.created_at,
            a.legal_name AS contractor_name
          FROM fdp_contractor_components k
          JOIN fdp_auxiliary_providers a ON a.workspace_id = k.workspace_id AND a.id = k.provider_id
          WHERE k.workspace_id = ? AND k.company_id = ? AND k.payroll_cycle_id = ? AND k.origin <> 'fixed_item'
          ORDER BY k.direction, a.legal_name, k.created_at DESC`).bind(workspace.id, companyId, cycleId).all()
        : Promise.resolve({ results: [] }),
      d1.prepare(`SELECT id, scope, company_id, provider_id, contract_reference, amount, effective_from
        FROM fdp_invoice_limit_policies WHERE workspace_id = ? AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY scope, effective_from DESC`).bind(workspace.id, `${competence}-01`).all(),
    ]);

    const rows = closings.results as Record<string, unknown>[];
    /* A situação da nota aparece na tela de pagamentos, não só na aba de Notas
       Fiscais (§10). Quem está decidindo o que pagar precisa ver ali mesmo que
       um prestador está travado — e o motivo, por extenso, para não precisar
       trocar de tela para descobrir. */
    const invoicePolicy = await loadInvoicePolicy(d1, workspace.id);
    for (const row of rows) {
      row.invoice_payment_block = invoicePaymentBlock({
        expectedAmount: Number(row.invoice_expected_amount ?? 0),
        reviewStatus: String(row.invoice_review_status ?? ""),
        policy: invoicePolicy.reviewPolicy,
      });
    }

    return Response.json({
      module: moduleType, competence, cycle, cycles: cycles.results,
      closings: rows, contractors: contractors.results, fixedItems: fixedItems.results,
      monthlyEntries: monthlyEntries.results,
      invoiceLimitPolicies: policies.results,
      invoicePolicy,
      invoiceSummary: summarizeInvoiceCompetence(rows.map((row) => ({
        expectedAmount: Number(row.invoice_expected_amount ?? 0),
        reviewStatus: String(row.invoice_review_status ?? ""),
        informedAmount: Number(row.invoice_received_amount ?? 0),
        hasInvoice: Boolean(row.invoice_current_id),
      })), invoicePolicy.reviewPolicy),
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
