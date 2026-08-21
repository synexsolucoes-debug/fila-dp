import type { getD1 } from "../db";
import { ApiError } from "./api-errors.ts";
import {
  CONTRACTOR_CALC_VERSION,
  componentDirectionFor,
  type ComplementMethod,
  type ContractorComponentDirection,
  type ContractorComponentType,
  type InvoiceLimitCandidate,
  type PaymentOrigin,
  calculateContractorBaseProration,
  calculateContractorClosing,
  calculatePsychologyClosing,
  invoiceComparison,
  reconcileContractorClosing,
  resolveInvoiceLimit,
} from "./payments.ts";
import { centsFromDatabase, fromCents } from "./payments.ts";
import {
  apurationBlock,
  assertWithinContract,
  contractBalance,
  fixedItemsForCompetence,
  type ContractType,
  type ContractorStatus,
  type FixedItem,
} from "./contractor-registry.ts";

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

/**
 * A competência aberta pelo próprio id, sem exigir a empresa por fora.
 *
 * O lançamento PJ precisa disto porque o prestador é do grupo: não há uma
 * "empresa do prestador" para procurar o ciclo. Quem diz a empresa é a
 * competência escolhida, e é contra ela que o acesso é conferido — o que é mais
 * exato do que conferir contra o cadastro, porque é a empresa da competência
 * que vai pagar.
 */
export async function requireOpenCycleById(d1: Database, workspaceId: string, cycleId: string) {
  const cycle = await d1.prepare("SELECT id, company_id, competence, status FROM fdp_payroll_cycles WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, cycleId).first<CycleRow>();
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
  provider_id: string;
  /** Empresa sugerida na apuração. O prestador é do grupo — quem paga naquela
   *  competência é a empresa do ciclo, não esta. Pode vir vazia. */
  company_id: string | null;
  contract_reference: string; base_amount: string | number;
  fixed_caju_difference?: string | number;
  invoice_limit_override: string | number | null; complement_method: string; status: string;
  contract_type: string; contract_start: string | null; contract_end: string | null;
  contract_total_amount: string | number | null;
  legal_name?: string; trade_name?: string;
};

export async function requireContractorProfile(d1: Database, workspaceId: string, providerId: string) {
  const profile = await d1.prepare(`SELECT p.provider_id, p.company_id, p.contract_reference, p.base_amount, p.fixed_caju_difference,
      p.invoice_limit_override, p.complement_method, p.status, p.contract_type, p.contract_start, p.contract_end, p.contract_total_amount,
      a.legal_name, a.trade_name
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
export async function invoiceLimitCandidates(
  d1: Database, workspaceId: string, profile: ContractorProfileRow, competence: string, companyId: string,
) {
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
    /* A empresa que decide o limite é a que está apurando, não a do cadastro:
       um limite de nota é uma regra de quem paga. */
    .bind(workspaceId, referenceDate, referenceDate, companyId, companyId, profile.contract_reference, profile.provider_id)
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
    FROM fdp_contractor_closings WHERE workspace_id = ? AND id = ? AND excluded_at IS NULL`)
    .bind(workspaceId, closingId).first<ContractorClosingRow>();
  if (!closing) throw ApiError.notFound("Fechamento PJ não encontrado.", "CONTRACTOR_CLOSING_NOT_FOUND");
  return closing;
}

/** O nome que a operação usa para o prestador, sem cair em string vazia. */
function contractorLabel(profile: ContractorProfileRow) {
  return profile.trade_name || profile.legal_name || profile.contract_reference || "Prestador";
}

/**
 * Quanto do contrato já foi consumido por competências comprometidas.
 *
 * Fechamento ainda em conferência não conta: ele pode mudar. Só entra o que já
 * virou obrigação — daí a lista de situações abaixo. `excludeCycleId` tira a
 * competência sendo recalculada, senão ela contaria duas vezes contra o saldo.
 */
export async function contractorConsumedCents(d1: Database, workspaceId: string, providerId: string, excludeCycleId?: string) {
  const row = await d1.prepare(`SELECT COALESCE(SUM(net_amount), 0) AS consumed FROM fdp_contractor_closings
    WHERE workspace_id = ? AND provider_id = ?
      AND excluded_at IS NULL
      AND status IN ('approved', 'invoice_pending', 'ready_to_pay', 'paid', 'closed')
      AND (? = '' OR payroll_cycle_id <> ?)`)
    .bind(workspaceId, providerId, excludeCycleId ?? "", excludeCycleId ?? "")
    .first<{ consumed: string | number }>();
  return centsFromDatabase(row?.consumed ?? 0, "Consumo do contrato");
}

/** Saldo do contrato do prestador, pronto para a tela e para a recusa de apuração. */
export async function contractorBalance(d1: Database, workspaceId: string, profile: ContractorProfileRow, excludeCycleId?: string) {
  return contractBalance({
    contractType: profile.contract_type as ContractType,
    contractTotalCents: profile.contract_total_amount === null || profile.contract_total_amount === undefined
      ? null
      : centsFromDatabase(profile.contract_total_amount, "Valor do contrato"),
    consumedCents: await contractorConsumedCents(d1, workspaceId, profile.provider_id, excludeCycleId),
  });
}

/**
 * Traz os valores fixos vigentes para dentro da competência, como componentes.
 *
 * A materialização existe para que o cálculo continue tendo uma fonte só:
 * `calculateContractorClosing` lê componentes, e o valor fixo vira componente.
 * Um segundo caminho de soma seria a maneira mais fácil de fazer a tela e o
 * arquivo discordarem.
 *
 * Reapurar não duplica (índice único por item e competência) e item que saiu de
 * vigência é cancelado com motivo, não apagado — o histórico da competência
 * precisa continuar explicável.
 */
export async function materializeFixedItems(d1: Database, input: {
  workspaceId: string; profile: ContractorProfileRow; cycle: CycleRow; userId: string;
}) {
  const rows = await d1.prepare(`SELECT id, direction, component_type, description, amount, effective_from, effective_to, status
    FROM fdp_contractor_fixed_items WHERE workspace_id = ? AND provider_id = ?`)
    .bind(input.workspaceId, input.profile.provider_id)
    .all<{
      id: string; direction: string; component_type: string; description: string;
      amount: string | number; effective_from: string; effective_to: string | null; status: string;
    }>();

  const items: FixedItem[] = rows.results.map((row) => ({
    id: String(row.id),
    direction: row.direction === "debit" ? "debit" : "credit",
    componentType: String(row.component_type),
    description: String(row.description),
    amountCents: centsFromDatabase(row.amount, "Valor fixo"),
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to === null ? null : String(row.effective_to),
    status: row.status === "ended" ? "ended" : "active",
  }));
  const effective = fixedItemsForCompetence(items, input.cycle.competence);
  const effectiveIds = new Set(effective.map((item) => item.id));

  const existing = await d1.prepare(`SELECT id, fixed_item_id, status FROM fdp_contractor_components
    WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ? AND fixed_item_id IS NOT NULL`)
    .bind(input.workspaceId, input.profile.provider_id, input.cycle.id)
    .all<{ id: string; fixed_item_id: string; status: string }>();
  const existingByItem = new Map(existing.results.map((row) => [String(row.fixed_item_id), row]));

  const statements = [];
  for (const item of effective) {
    const current = existingByItem.get(item.id);
    if (current) {
      statements.push(d1.prepare(`UPDATE fdp_contractor_components
          SET direction = ?, component_type = ?, description = ?, amount = ?, status = 'active', canceled_reason = '', updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(item.direction, item.componentType, item.description, fromCents(item.amountCents),
          input.workspaceId, current.id));
    } else {
      statements.push(d1.prepare(`INSERT INTO fdp_contractor_components
          (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence, direction, component_type,
           description, component_quantity, amount, origin, fixed_item_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'fixed_item', ?, ?)`)
        .bind(crypto.randomUUID(), input.workspaceId, input.cycle.company_id, input.profile.provider_id,
          input.cycle.id, input.cycle.competence, item.direction, item.componentType, item.description,
          fromCents(item.amountCents), item.id, input.userId));
    }
  }
  for (const row of existing.results) {
    if (effectiveIds.has(String(row.fixed_item_id)) || row.status === "canceled") continue;
    // Cancelar, não apagar: a competência precisa continuar explicando o que
    // entrou e o que saiu, e por quê.
    statements.push(d1.prepare(`UPDATE fdp_contractor_components
        SET status = 'canceled', canceled_reason = 'valor fixo fora da vigência desta competência', updated_at = now()
      WHERE workspace_id = ? AND id = ?`).bind(input.workspaceId, row.id));
  }

  if (statements.length > 0) await d1.batch(statements);
  return { applied: effective.length, removed: existing.results.length - effectiveIds.size };
}

/** Aplica a ordem obrigatória do cálculo PJ sobre os componentes vigentes da competência. */
export async function computeContractorClosing(d1: Database, workspaceId: string, profile: ContractorProfileRow, cycle: CycleRow) {
  const components = await d1.prepare(`SELECT direction, component_type, amount, status FROM fdp_contractor_components
    WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ?`)
    .bind(workspaceId, profile.provider_id, cycle.id)
    .all<{ direction: string; component_type: string; amount: string | number; status: string }>();
  const candidates = await invoiceLimitCandidates(d1, workspaceId, profile, cycle.competence, cycle.company_id);
  const limit = resolveInvoiceLimit(candidates);
  const proration = calculateContractorBaseProration({
    baseAmount: Number(profile.base_amount),
    competence: cycle.competence,
    contractEnd: profile.contract_end,
  });
  const calculation = {
    ...calculateContractorClosing({
      baseAmount: proration.baseAmount,
      components: components.results.map((row) => ({
        direction: row.direction as ContractorComponentDirection,
        amount: Number(row.amount),
        status: row.status === "canceled" ? "canceled" : "active",
      })),
      invoiceLimit: limit,
      complementMethod: profile.complement_method as ComplementMethod,
      fixedCajuAmount: Number(profile.fixed_caju_difference ?? 0),
    }),
    ...proration,
  };
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

  // Contrato suspenso, encerrado ou fora de vigência não vira apuração. Sem esta
  // recusa, um prestador desligado continuaria gerando pagamento todo mês —
  // silenciosamente, porque o cadastro sozinho não impede o cálculo.
  const blocked = apurationBlock(
    input.profile.status as ContractorStatus,
    input.cycle.competence,
    input.profile.contract_start,
    input.profile.contract_end,
  );
  if (blocked) {
    throw new ApiError(409, "CONTRACTOR_NOT_APURABLE",
      `${contractorLabel(input.profile)} não entra na apuração de ${input.cycle.competence}: ${blocked}.`);
  }

  // Os valores fixos vigentes entram como componentes antes do cálculo, para o
  // motor continuar com uma fonte só.
  await materializeFixedItems(d1, input);

  const { calculation, limitPolicyId, componentCount } = await computeContractorClosing(d1, input.workspaceId, input.profile, input.cycle);

  // O contrato por prazo determinado tem teto em valor, não só em data: ele pode
  // acabar antes do prazo. Recusar aqui evita criar obrigação que o contrato não
  // cobre — e a recusa acontece antes de qualquer escrita no fechamento.
  const balance = await contractorBalance(d1, input.workspaceId, input.profile, input.cycle.id);
  assertWithinContract(balance, centsFromDatabase(calculation.netAmount, "Líquido apurado"), contractorLabel(input.profile));
  const closingId = existing?.id ?? crypto.randomUUID();
  const cajuStatus = calculation.cajuAmount > 0 ? "pending" : "not_required";
  const invoiceStatus = calculation.invoiceExpectedAmount > 0 ? "pending" : "not_required";

  if (existing) {
    await d1.prepare(`UPDATE fdp_contractor_closings SET base_amount = ?, contract_base_amount = ?, proration_days = ?,
        proration_total_days = ?, proration_end_date = ?, credits_amount = ?, debits_amount = ?, net_amount = ?,
        invoice_limit_amount = ?, invoice_limit_source = ?, invoice_limit_policy_id = ?, invoice_expected_amount = ?,
        complement_amount = ?, complement_method = ?, fixed_caju_amount = ?, caju_amount = ?, calc_version = ?,
        invoice_status = CASE WHEN invoice_number = '' THEN ? ELSE invoice_status END,
        caju_status = CASE WHEN caju_status IN ('sent', 'processed') THEN caju_status ELSE ? END,
        updated_at = now()
      WHERE workspace_id = ? AND id = ?`)
      .bind(calculation.baseAmount, calculation.contractBaseAmount, calculation.prorationDays, calculation.prorationTotalDays,
        calculation.prorationEndDate, calculation.creditsAmount, calculation.debitsAmount, calculation.netAmount,
        calculation.invoiceLimitAmount, calculation.invoiceLimitSource, limitPolicyId, calculation.invoiceExpectedAmount,
        calculation.complementAmount, calculation.complementMethod, calculation.fixedCajuAmount, calculation.cajuAmount, calculation.calcVersion,
        invoiceStatus, cajuStatus, input.workspaceId, closingId).run();
  } else {
    await d1.prepare(`INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
        base_amount, contract_base_amount, proration_days, proration_total_days, proration_end_date,
        credits_amount, debits_amount, net_amount, invoice_limit_amount, invoice_limit_source, invoice_limit_policy_id,
        invoice_expected_amount, complement_amount, complement_method, fixed_caju_amount, caju_amount, status, invoice_status, caju_status, calc_version, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
      .bind(closingId, input.workspaceId, input.cycle.company_id, input.profile.provider_id, input.cycle.id, input.cycle.competence,
        calculation.baseAmount, calculation.contractBaseAmount, calculation.prorationDays, calculation.prorationTotalDays,
        calculation.prorationEndDate, calculation.creditsAmount, calculation.debitsAmount, calculation.netAmount,
        calculation.invoiceLimitAmount, calculation.invoiceLimitSource, limitPolicyId, calculation.invoiceExpectedAmount,
        calculation.complementAmount, calculation.complementMethod, calculation.fixedCajuAmount, calculation.cajuAmount, invoiceStatus, cajuStatus,
        calculation.calcVersion, input.userId).run();
  }
  await d1.prepare(`UPDATE fdp_contractor_components SET closing_id = ?
    WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ? AND closing_id IS DISTINCT FROM ?`)
    .bind(closingId, input.workspaceId, input.profile.provider_id, input.cycle.id, closingId).run();
  return { closingId, calculation, limitPolicyId, componentCount, created: !existing };
}

/**
 * Cria um crédito ou desconto na competência do prestador.
 *
 * Compartilhado entre a interface interna e a API pública: a regra de
 * competência fechada, fechamento concluído e direção do componente vale igual
 * para quem opera na tela e para quem integra por API.
 */
export async function createContractorComponent(d1: Database, input: {
  workspaceId: string;
  profile: ContractorProfileRow;
  cycle: CycleRow;
  componentType: ContractorComponentType;
  amount: number;
  description?: string;
  quantity?: number;
  origin?: PaymentOrigin;
  documentReference?: string;
  note?: string;
  externalId?: string;
  createdBy: string;
}) {
  if (input.cycle.status === "closed") throw ApiError.badRequest("A competência está fechada.", "COMPETENCE_CLOSED");
  const direction = componentDirectionFor(input.componentType);
  if (input.amount <= 0) throw ApiError.badRequest("Informe um valor maior que zero.", "COMPONENT_AMOUNT_REQUIRED");

  const closing = await d1.prepare("SELECT id, status FROM fdp_contractor_closings WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ?")
    .bind(input.workspaceId, input.profile.provider_id, input.cycle.id).first<{ id: string; status: string }>();
  if (closing && (closing.status === "closed" || closing.status === "paid")) {
    throw ApiError.badRequest("O fechamento desta competência está concluído. Reabra com justificativa para lançar componentes.", "PAYMENT_CLOSING_LOCKED");
  }

  // Reenvio do mesmo identificador externo devolve o lançamento já criado.
  const externalId = input.externalId ?? "";
  if (externalId) {
    const duplicate = await d1.prepare("SELECT id, direction, component_type, amount FROM fdp_contractor_components WHERE workspace_id = ? AND external_id = ?")
      .bind(input.workspaceId, externalId).first<{ id: string; direction: string; component_type: string; amount: string | number }>();
    if (duplicate) {
      return {
        id: String(duplicate.id), direction: String(duplicate.direction), componentType: String(duplicate.component_type),
        amount: Number(duplicate.amount), competence: input.cycle.competence, duplicated: true,
      };
    }
  }

  const id = crypto.randomUUID();
  await d1.prepare(`INSERT INTO fdp_contractor_components (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence,
      direction, component_type, description, component_quantity, amount, origin, document_reference, note, status, external_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .bind(id, input.workspaceId, input.cycle.company_id, input.profile.provider_id, input.cycle.id, closing?.id ?? null,
      input.cycle.competence, direction, input.componentType, input.description ?? "", Math.max(input.quantity ?? 1, 0),
      input.amount, input.origin ?? "manual", input.documentReference ?? "", input.note ?? "", externalId, input.createdBy)
    .run();

  return { id, direction, componentType: input.componentType, amount: input.amount, competence: input.cycle.competence, duplicated: false };
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
        baseAmount: Number(closing.base_amount), contractBaseAmount: Number(closing.contract_base_amount ?? closing.base_amount),
        prorationDays: closing.proration_days === null ? null : Number(closing.proration_days),
        prorationTotalDays: closing.proration_total_days === null ? null : Number(closing.proration_total_days),
        prorationEndDate: closing.proration_end_date === null ? null : String(closing.proration_end_date),
        creditsAmount: Number(closing.credits_amount), debitsAmount: Number(closing.debits_amount),
        netAmount: Number(closing.net_amount), invoiceLimitAmount: closing.invoice_limit_amount === null ? null : Number(closing.invoice_limit_amount),
        invoiceLimitSource: String(closing.invoice_limit_source), invoiceExpectedAmount: Number(closing.invoice_expected_amount),
        complementAmount: Number(closing.complement_amount), complementMethod: String(closing.complement_method),
        fixedCajuAmount: Number(closing.fixed_caju_amount ?? 0), cajuAmount: Number(closing.caju_amount),
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
