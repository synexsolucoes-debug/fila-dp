import type { getD1 } from "../db";
import { ApiError } from "./api-errors.ts";
import {
  CONTRACTOR_CALC_VERSION,
  type ComplementMethod,
  type ContractorComponentDirection,
  type InvoiceLimitCandidate,
  calculateContractorClosing,
  calculatePsychologyClosing,
  invoiceComparison,
  reconcileContractorClosing,
  resolveInvoiceLimit,
} from "./payments.ts";

type Database = ReturnType<typeof getD1>;

export type CycleRow = { id: string; company_id: string; competence: string; status: string };

/** Competências fechadas não recebem novos lançamentos nem recálculo. */
export async function requireOpenCycle(d1: Database, workspaceId: string, companyId: string, cycleId: string) {
  const cycle = await d1.prepare("SELECT id, company_id, competence, status FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND id = ?")
    .bind(workspaceId, companyId, cycleId).first<CycleRow>();
  if (!cycle) throw ApiError.badRequest("Competência inválida.", "INVALID_COMPETENCE");
  if (cycle.status === "closed") throw ApiError.badRequest("A competência está fechada.", "COMPETENCE_CLOSED");
  return cycle;
}

export async function requireCycle(d1: Database, workspaceId: string, companyId: string, cycleId: string) {
  const cycle = await d1.prepare("SELECT id, company_id, competence, status FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND id = ?")
    .bind(workspaceId, companyId, cycleId).first<CycleRow>();
  if (!cycle) throw ApiError.badRequest("Competência inválida.", "INVALID_COMPETENCE");
  return cycle;
}

export async function requireProvider(d1: Database, workspaceId: string, providerId: string, providerType: "psychologist" | "contractor") {
  const provider = await d1.prepare("SELECT id, provider_type, status, legal_name, trade_name FROM fdp_auxiliary_providers WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, providerId).first<{ id: string; provider_type: string; status: string; legal_name: string; trade_name: string }>();
  if (!provider || provider.provider_type !== providerType) throw ApiError.badRequest("Prestador inválido para este módulo.", "INVALID_PAYMENT_PROVIDER");
  return provider;
}

/* -------------------------------------------------------------------------- */
/* Psicólogos                                                                  */
/* -------------------------------------------------------------------------- */

export type PsychologyClosingRow = {
  id: string; company_id: string; provider_id: string; payroll_cycle_id: string; competence: string;
  status: string; net_amount: number; gross_amount: number; adjustments_amount: number;
};

export async function findPsychologyClosing(d1: Database, workspaceId: string, closingId: string) {
  const closing = await d1.prepare(`SELECT id, company_id, provider_id, payroll_cycle_id, competence, status,
      net_amount, gross_amount, adjustments_amount FROM fdp_psychology_closings WHERE workspace_id = ? AND id = ?`)
    .bind(workspaceId, closingId).first<PsychologyClosingRow>();
  if (!closing) throw ApiError.notFound("Fechamento não encontrado.", "PSYCHOLOGY_CLOSING_NOT_FOUND");
  return closing;
}

/**
 * Reapura o fechamento do psicólogo a partir dos lançamentos vigentes e dos
 * ajustes registrados. Cada consulta contribui com o valor unitário histórico
 * gravado no próprio lançamento — mudar a tabela do psicólogo não reescreve o passado.
 */
export async function computePsychologyClosing(d1: Database, workspaceId: string, providerId: string, cycle: CycleRow, closingId: string | null) {
  const [sessions, adjustments] = await Promise.all([
    d1.prepare(`SELECT employee_id, session_quantity, unit_amount, status FROM fdp_psychology_sessions
      WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ?`)
      .bind(workspaceId, providerId, cycle.id).all<{ employee_id: string; session_quantity: number; unit_amount: string | number; status: string }>(),
    closingId
      ? d1.prepare("SELECT kind, amount FROM fdp_psychology_adjustments WHERE workspace_id = ? AND closing_id = ?")
        .bind(workspaceId, closingId).all<{ kind: string; amount: string | number }>()
      : Promise.resolve({ results: [] as { kind: string; amount: string | number }[] }),
  ]);
  return calculatePsychologyClosing({
    sessions: sessions.results.map((row) => ({
      employeeId: String(row.employee_id),
      quantity: Number(row.session_quantity),
      unitAmount: Number(row.unit_amount),
      status: row.status === "canceled" ? "canceled" : "registered",
    })),
    adjustments: adjustments.results.map((row) => ({
      kind: row.kind as "inclusion" | "cancellation" | "correction" | "discount" | "complement",
      amount: Number(row.amount),
    })),
  });
}

/** Cria ou atualiza o fechamento do psicólogo da competência e devolve os valores apurados. */
export async function upsertPsychologyClosing(d1: Database, input: {
  workspaceId: string; companyId: string; providerId: string; cycle: CycleRow; userId: string;
}) {
  const existing = await d1.prepare(`SELECT id, status FROM fdp_psychology_closings
    WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ?`)
    .bind(input.workspaceId, input.providerId, input.cycle.id).first<{ id: string; status: string }>();
  if (existing && (existing.status === "closed" || existing.status === "paid")) {
    throw ApiError.badRequest("O fechamento está concluído e não pode ser recalculado. Reabra com justificativa.", "PAYMENT_CLOSING_LOCKED");
  }
  const closingId = existing?.id ?? crypto.randomUUID();
  const totals = await computePsychologyClosing(d1, input.workspaceId, input.providerId, input.cycle, existing?.id ?? null);
  if (existing) {
    await d1.prepare(`UPDATE fdp_psychology_closings SET entries_count = ?, sessions_count = ?, employees_count = ?,
      gross_amount = ?, adjustments_amount = ?, net_amount = ?, calc_version = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ?`)
      .bind(totals.entriesCount, totals.sessionsCount, totals.employeesCount, totals.grossAmount, totals.adjustmentsAmount,
        totals.netAmount, totals.calcVersion, input.workspaceId, closingId).run();
  } else {
    await d1.prepare(`INSERT INTO fdp_psychology_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
        entries_count, sessions_count, employees_count, gross_amount, adjustments_amount, net_amount, status, calc_version, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .bind(closingId, input.workspaceId, input.companyId, input.providerId, input.cycle.id, input.cycle.competence,
        totals.entriesCount, totals.sessionsCount, totals.employeesCount, totals.grossAmount, totals.adjustmentsAmount,
        totals.netAmount, totals.calcVersion, input.userId).run();
  }
  await d1.prepare(`UPDATE fdp_psychology_sessions SET closing_id = ?
    WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ? AND closing_id IS DISTINCT FROM ?`)
    .bind(closingId, input.workspaceId, input.providerId, input.cycle.id, closingId).run();
  return { closingId, totals, created: !existing };
}

/* -------------------------------------------------------------------------- */
/* Prestadores PJ                                                              */
/* -------------------------------------------------------------------------- */

export type ContractorProfileRow = {
  provider_id: string; company_id: string; contract_reference: string; base_amount: string | number;
  invoice_limit_override: string | number | null; complement_method: string; status: string;
  legal_name?: string; trade_name?: string;
};

export async function requireContractorProfile(d1: Database, workspaceId: string, providerId: string) {
  const profile = await d1.prepare(`SELECT p.provider_id, p.company_id, p.contract_reference, p.base_amount, p.invoice_limit_override,
      p.complement_method, p.status, a.legal_name, a.trade_name
    FROM fdp_contractor_profiles p JOIN fdp_auxiliary_providers a ON a.workspace_id = p.workspace_id AND a.id = p.provider_id
    WHERE p.workspace_id = ? AND p.provider_id = ?`)
    .bind(workspaceId, providerId).first<ContractorProfileRow>();
  if (!profile) throw ApiError.notFound("Prestador PJ não encontrado.", "CONTRACTOR_PROFILE_NOT_FOUND");
  return profile;
}

/**
 * Monta os candidatos a limite de nota do prestador.
 *
 * O limite gravado diretamente no contrato do prestador é o mais específico e,
 * por isso, entra com vigência máxima dentro do escopo `provider`; as políticas
 * versionadas de prestador, contrato, empresa e workspace entram em seguida e a
 * precedência final é aplicada por `resolveInvoiceLimit`.
 */
export async function invoiceLimitCandidates(d1: Database, workspaceId: string, profile: ContractorProfileRow, competence: string) {
  const referenceDate = `${competence}-01`;
  const policies = await d1.prepare(`SELECT id, scope, amount, effective_from FROM fdp_invoice_limit_policies
    WHERE workspace_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
      AND (
        scope = 'workspace'
        OR (scope = 'company' AND company_id = ?)
        OR (scope = 'contract' AND company_id = ? AND contract_reference <> '' AND contract_reference = ?)
        OR (scope = 'provider' AND provider_id = ?)
      )
    ORDER BY effective_from DESC`)
    .bind(workspaceId, referenceDate, referenceDate, profile.company_id, profile.company_id, profile.contract_reference, profile.provider_id)
    .all<{ id: string; scope: string; amount: string | number; effective_from: string }>();

  const candidates: InvoiceLimitCandidate[] = policies.results.map((row) => ({
    scope: row.scope as InvoiceLimitCandidate["scope"],
    amount: Number(row.amount),
    policyId: String(row.id),
    effectiveFrom: String(row.effective_from),
  }));
  if (profile.invoice_limit_override !== null && profile.invoice_limit_override !== undefined) {
    candidates.unshift({ scope: "provider", amount: Number(profile.invoice_limit_override), policyId: null, effectiveFrom: "9999-12-31" });
  }
  return candidates;
}

export type ContractorClosingRow = {
  id: string; company_id: string; provider_id: string; payroll_cycle_id: string; competence: string; status: string;
  net_amount: string | number; invoice_expected_amount: string | number; complement_amount: string | number;
  invoice_received_amount: string | number; complement_paid_amount: string | number; caju_amount: string | number;
  complement_method: string; invoice_status: string; caju_status: string;
};

export async function findContractorClosing(d1: Database, workspaceId: string, closingId: string) {
  const closing = await d1.prepare(`SELECT id, company_id, provider_id, payroll_cycle_id, competence, status, net_amount,
      invoice_expected_amount, complement_amount, invoice_received_amount, complement_paid_amount, caju_amount,
      complement_method, invoice_status, caju_status
    FROM fdp_contractor_closings WHERE workspace_id = ? AND id = ?`)
    .bind(workspaceId, closingId).first<ContractorClosingRow>();
  if (!closing) throw ApiError.notFound("Fechamento PJ não encontrado.", "CONTRACTOR_CLOSING_NOT_FOUND");
  return closing;
}

/** Aplica a ordem obrigatória do cálculo PJ sobre os componentes vigentes da competência. */
export async function computeContractorClosing(d1: Database, workspaceId: string, profile: ContractorProfileRow, cycle: CycleRow) {
  const components = await d1.prepare(`SELECT direction, component_type, amount, status FROM fdp_contractor_components
    WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ?`)
    .bind(workspaceId, profile.provider_id, cycle.id)
    .all<{ direction: string; component_type: string; amount: string | number; status: string }>();
  const candidates = await invoiceLimitCandidates(d1, workspaceId, profile, cycle.competence);
  const limit = resolveInvoiceLimit(candidates);
  const calculation = calculateContractorClosing({
    baseAmount: Number(profile.base_amount),
    components: components.results.map((row) => ({
      direction: row.direction as ContractorComponentDirection,
      amount: Number(row.amount),
      status: row.status === "canceled" ? "canceled" : "active",
    })),
    invoiceLimit: limit,
    complementMethod: profile.complement_method as ComplementMethod,
  });
  return {
    calculation,
    limitPolicyId: limit.policyId,
    componentCount: components.results.filter((row) => row.status !== "canceled").length,
  };
}

/** Cria ou atualiza o fechamento PJ da competência com os valores recalculados. */
export async function upsertContractorClosing(d1: Database, input: {
  workspaceId: string; profile: ContractorProfileRow; cycle: CycleRow; userId: string;
}) {
  const existing = await d1.prepare("SELECT id, status FROM fdp_contractor_closings WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ?")
    .bind(input.workspaceId, input.profile.provider_id, input.cycle.id).first<{ id: string; status: string }>();
  if (existing && (existing.status === "closed" || existing.status === "paid")) {
    throw ApiError.badRequest("O fechamento está concluído e não pode ser recalculado. Reabra com justificativa.", "PAYMENT_CLOSING_LOCKED");
  }
  const { calculation, limitPolicyId, componentCount } = await computeContractorClosing(d1, input.workspaceId, input.profile, input.cycle);
  const closingId = existing?.id ?? crypto.randomUUID();
  const cajuStatus = calculation.cajuAmount > 0 ? "pending" : "not_required";
  const invoiceStatus = calculation.invoiceExpectedAmount > 0 ? "pending" : "not_required";

  if (existing) {
    await d1.prepare(`UPDATE fdp_contractor_closings SET base_amount = ?, credits_amount = ?, debits_amount = ?, net_amount = ?,
        invoice_limit_amount = ?, invoice_limit_source = ?, invoice_limit_policy_id = ?, invoice_expected_amount = ?,
        complement_amount = ?, complement_method = ?, caju_amount = ?, calc_version = ?,
        invoice_status = CASE WHEN invoice_number = '' THEN ? ELSE invoice_status END,
        caju_status = CASE WHEN caju_status IN ('sent', 'processed') THEN caju_status ELSE ? END,
        updated_at = now()
      WHERE workspace_id = ? AND id = ?`)
      .bind(calculation.baseAmount, calculation.creditsAmount, calculation.debitsAmount, calculation.netAmount,
        calculation.invoiceLimitAmount, calculation.invoiceLimitSource, limitPolicyId, calculation.invoiceExpectedAmount,
        calculation.complementAmount, calculation.complementMethod, calculation.cajuAmount, calculation.calcVersion,
        invoiceStatus, cajuStatus, input.workspaceId, closingId).run();
  } else {
    await d1.prepare(`INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
        base_amount, credits_amount, debits_amount, net_amount, invoice_limit_amount, invoice_limit_source, invoice_limit_policy_id,
        invoice_expected_amount, complement_amount, complement_method, caju_amount, status, invoice_status, caju_status, calc_version, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
      .bind(closingId, input.workspaceId, input.profile.company_id, input.profile.provider_id, input.cycle.id, input.cycle.competence,
        calculation.baseAmount, calculation.creditsAmount, calculation.debitsAmount, calculation.netAmount,
        calculation.invoiceLimitAmount, calculation.invoiceLimitSource, limitPolicyId, calculation.invoiceExpectedAmount,
        calculation.complementAmount, calculation.complementMethod, calculation.cajuAmount, invoiceStatus, cajuStatus,
        calculation.calcVersion, input.userId).run();
  }
  await d1.prepare(`UPDATE fdp_contractor_components SET closing_id = ?
    WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ? AND closing_id IS DISTINCT FROM ?`)
    .bind(closingId, input.workspaceId, input.profile.provider_id, input.cycle.id, closingId).run();
  return { closingId, calculation, limitPolicyId, componentCount, created: !existing };
}

/** Conciliação PJ: nota recebida + complemento pago devem fechar o líquido devido. */
export async function refreshContractorReconciliation(d1: Database, workspaceId: string, closingId: string) {
  const closing = await findContractorClosing(d1, workspaceId, closingId);
  const reconciliation = reconcileContractorClosing({
    netAmount: Number(closing.net_amount),
    invoiceReceivedAmount: Number(closing.invoice_received_amount),
    complementPaidAmount: Number(closing.complement_paid_amount),
  });
  const invoiceStatus = invoiceComparison(
    Number(closing.invoice_expected_amount),
    Number(closing.invoice_received_amount),
    Number(closing.invoice_received_amount) > 0,
  );
  await d1.prepare(`UPDATE fdp_contractor_closings SET reconciliation_status = ?, reconciliation_difference = ?, invoice_status = ?, updated_at = now()
    WHERE workspace_id = ? AND id = ?`)
    .bind(reconciliation.status, reconciliation.difference, invoiceStatus, workspaceId, closingId).run();
  return { reconciliation, invoiceStatus };
}

/** Snapshot imutável guardado no fechamento: entradas, parâmetros e versão do cálculo. */
export async function contractorClosingSnapshot(d1: Database, workspaceId: string, closingId: string) {
  const [closing, components] = await Promise.all([
    d1.prepare("SELECT * FROM fdp_contractor_closings WHERE workspace_id = ? AND id = ?").bind(workspaceId, closingId).first<Record<string, unknown>>(),
    d1.prepare(`SELECT id, direction, component_type, amount, status, description FROM fdp_contractor_components
      WHERE workspace_id = ? AND closing_id = ? ORDER BY direction, component_type`).bind(workspaceId, closingId).all<Record<string, unknown>>(),
  ]);
  return {
    calcVersion: CONTRACTOR_CALC_VERSION,
    capturedAt: new Date().toISOString(),
    totals: closing
      ? {
        baseAmount: Number(closing.base_amount), creditsAmount: Number(closing.credits_amount), debitsAmount: Number(closing.debits_amount),
        netAmount: Number(closing.net_amount), invoiceLimitAmount: closing.invoice_limit_amount === null ? null : Number(closing.invoice_limit_amount),
        invoiceLimitSource: String(closing.invoice_limit_source), invoiceExpectedAmount: Number(closing.invoice_expected_amount),
        complementAmount: Number(closing.complement_amount), complementMethod: String(closing.complement_method), cajuAmount: Number(closing.caju_amount),
      }
      : {},
    components: components.results,
  };
}

/** Snapshot imutável do fechamento de psicólogos. */
export async function psychologyClosingSnapshot(d1: Database, workspaceId: string, closingId: string) {
  const [closing, sessions, adjustments] = await Promise.all([
    d1.prepare("SELECT * FROM fdp_psychology_closings WHERE workspace_id = ? AND id = ?").bind(workspaceId, closingId).first<Record<string, unknown>>(),
    d1.prepare(`SELECT id, employee_id, session_date, session_quantity, unit_amount, total_amount, status
      FROM fdp_psychology_sessions WHERE workspace_id = ? AND closing_id = ? ORDER BY session_date`).bind(workspaceId, closingId).all<Record<string, unknown>>(),
    d1.prepare("SELECT id, kind, amount, reason, created_at FROM fdp_psychology_adjustments WHERE workspace_id = ? AND closing_id = ? ORDER BY created_at")
      .bind(workspaceId, closingId).all<Record<string, unknown>>(),
  ]);
  return {
    calcVersion: closing ? String(closing.calc_version) : "",
    capturedAt: new Date().toISOString(),
    totals: closing
      ? {
        entriesCount: Number(closing.entries_count), sessionsCount: Number(closing.sessions_count), employeesCount: Number(closing.employees_count),
        grossAmount: Number(closing.gross_amount), adjustmentsAmount: Number(closing.adjustments_amount), netAmount: Number(closing.net_amount),
      }
      : {},
    sessions: sessions.results,
    adjustments: adjustments.results,
  };
}
