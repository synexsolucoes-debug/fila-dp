import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasCapability } from "../lib/authorization.ts";
import {
  CONTRACTOR_CALC_VERSION,
  PSYCHOLOGY_CALC_VERSION,
  assertTransition,
  calculateContractorClosing,
  calculatePsychologyClosing,
  calculateSessionTotal,
  componentDirectionFor,
  contractorTransitions,
  invoiceComparison,
  psychologyTransitions,
  reconcileContractorClosing,
  resolveInvoiceLimit,
  sanitizePayoutAccount,
  withoutSealedPayout,
} from "../lib/payments.ts";

const limit = (amount: number | null) => (
  amount === null ? { amount: null, source: "none" as const, policyId: null } : { amount, source: "workspace" as const, policyId: "policy" }
);

test("exemplo 1 da especificação: crédito e descontos antes do limite da nota", () => {
  const result = calculateContractorClosing({
    baseAmount: 6500,
    components: [
      { direction: "credit", amount: 500 },
      { direction: "debit", amount: 400 },
      { direction: "debit", amount: 100 },
    ],
    invoiceLimit: limit(6000),
    complementMethod: "caju_saldo_livre",
  });
  assert.equal(result.netAmount, 6500);
  assert.equal(result.invoiceExpectedAmount, 6000);
  assert.equal(result.complementAmount, 500);
  assert.equal(result.cajuAmount, 500);
  assert.equal(result.calcVersion, CONTRACTOR_CALC_VERSION);
});

test("exemplo 2 da especificação: líquido abaixo do limite não gera complemento", () => {
  const result = calculateContractorClosing({
    baseAmount: 5000,
    components: [{ direction: "credit", amount: 500 }, { direction: "debit", amount: 300 }],
    invoiceLimit: limit(6000),
    complementMethod: "caju_saldo_livre",
  });
  assert.equal(result.netAmount, 5200);
  assert.equal(result.invoiceExpectedAmount, 5200);
  assert.equal(result.complementAmount, 0);
  assert.equal(result.cajuAmount, 0);
});

test("exemplo 3 da especificação: excedente vai integralmente para o meio complementar", () => {
  const result = calculateContractorClosing({
    baseAmount: 8000,
    components: [
      { direction: "credit", amount: 1000 },
      { direction: "debit", amount: 500 },
      { direction: "debit", amount: 300 },
    ],
    invoiceLimit: limit(6000),
    complementMethod: "caju_saldo_livre",
  });
  assert.equal(result.netAmount, 8200);
  assert.equal(result.invoiceExpectedAmount, 6000);
  assert.equal(result.complementAmount, 2200);
  assert.equal(result.cajuAmount, 2200);
});

test("a ordem do cálculo PJ nunca aplica o limite antes dos créditos e descontos", () => {
  // Base acima do limite, mas descontos derrubam o líquido: a nota acompanha o
  // líquido devido. Aplicar o limite primeiro produziria nota 6000 e complemento negativo.
  const result = calculateContractorClosing({
    baseAmount: 6500,
    components: [{ direction: "debit", amount: 1000 }],
    invoiceLimit: limit(6000),
    complementMethod: "caju_saldo_livre",
  });
  assert.equal(result.netAmount, 5500);
  assert.equal(result.invoiceExpectedAmount, 5500);
  assert.equal(result.complementAmount, 0);
  assert.equal(result.invoiceExpectedAmount + result.complementAmount, result.netAmount);
});

test("cálculo PJ trata limite ausente, componentes cancelados, centavos e complemento sem meio configurado", () => {
  const semLimite = calculateContractorClosing({
    baseAmount: 9000, components: [], invoiceLimit: limit(null), complementMethod: "none",
  });
  assert.equal(semLimite.invoiceLimitAmount, null);
  assert.equal(semLimite.invoiceExpectedAmount, 9000);
  assert.equal(semLimite.complementAmount, 0);
  assert.equal(semLimite.requiresComplementMethod, false);

  const cancelado = calculateContractorClosing({
    baseAmount: 1000,
    components: [{ direction: "credit", amount: 500, status: "canceled" }, { direction: "debit", amount: 100 }],
    invoiceLimit: limit(6000), complementMethod: "none",
  });
  assert.equal(cancelado.creditsAmount, 0);
  assert.equal(cancelado.netAmount, 900);

  const centavos = calculateContractorClosing({
    baseAmount: 1000.1,
    components: [{ direction: "credit", amount: 0.1 }, { direction: "credit", amount: 0.1 }],
    invoiceLimit: limit(1000), complementMethod: "caju_saldo_livre",
  });
  assert.equal(centavos.netAmount, 1000.3);
  assert.equal(centavos.invoiceExpectedAmount, 1000);
  assert.equal(centavos.cajuAmount, 0.3);

  const semMeio = calculateContractorClosing({
    baseAmount: 7000, components: [], invoiceLimit: limit(6000), complementMethod: "none",
  });
  assert.equal(semMeio.complementAmount, 1000);
  assert.equal(semMeio.cajuAmount, 0);
  assert.equal(semMeio.requiresComplementMethod, true);

  const outroCartao = calculateContractorClosing({
    baseAmount: 7000, components: [], invoiceLimit: limit(6000), complementMethod: "other_benefit_card",
  });
  assert.equal(outroCartao.complementAmount, 1000);
  assert.equal(outroCartao.cajuAmount, 0);

  const negativo = calculateContractorClosing({
    baseAmount: 500, components: [{ direction: "debit", amount: 800 }], invoiceLimit: limit(6000), complementMethod: "none",
  });
  assert.equal(negativo.netAmount, 0);
  assert.equal(negativo.negativeNet, true);
});

test("o limite da nota não é constante: prestador vence contrato, empresa e workspace", () => {
  const candidates = [
    { scope: "workspace" as const, amount: 6000, policyId: "w1", effectiveFrom: "2026-01-01" },
    { scope: "company" as const, amount: 7000, policyId: "c1", effectiveFrom: "2026-01-01" },
    { scope: "contract" as const, amount: 8000, policyId: "k1", effectiveFrom: "2026-01-01" },
    { scope: "provider" as const, amount: 9000, policyId: "p1", effectiveFrom: "2026-01-01" },
  ];
  assert.deepEqual(resolveInvoiceLimit(candidates), { amount: 9000, source: "provider", policyId: "p1" });
  assert.deepEqual(resolveInvoiceLimit(candidates.slice(0, 3)), { amount: 8000, source: "contract", policyId: "k1" });
  assert.deepEqual(resolveInvoiceLimit(candidates.slice(0, 2)), { amount: 7000, source: "company", policyId: "c1" });
  assert.deepEqual(resolveInvoiceLimit(candidates.slice(0, 1)), { amount: 6000, source: "workspace", policyId: "w1" });
  assert.deepEqual(resolveInvoiceLimit([]), { amount: null, source: "none", policyId: null });

  // Dentro do mesmo escopo vence a política mais recente; o limite do próprio
  // contrato do prestador entra com vigência máxima e prevalece.
  const versioned = resolveInvoiceLimit([
    { scope: "workspace", amount: 6000, policyId: "old", effectiveFrom: "2025-01-01" },
    { scope: "workspace", amount: 6500, policyId: "new", effectiveFrom: "2026-06-01" },
  ]);
  assert.deepEqual(versioned, { amount: 6500, source: "workspace", policyId: "new" });
  const override = resolveInvoiceLimit([
    { scope: "provider", amount: 12000, policyId: null, effectiveFrom: "9999-12-31" },
    { scope: "provider", amount: 9000, policyId: "p1", effectiveFrom: "2026-01-01" },
  ]);
  assert.deepEqual(override, { amount: 12000, source: "provider", policyId: null });
});

test("conciliação PJ exige nota mais complemento igual ao líquido devido", () => {
  assert.deepEqual(
    reconcileContractorClosing({ netAmount: 8200, invoiceReceivedAmount: 6000, complementPaidAmount: 2200 }),
    { difference: 0, status: "reconciled" },
  );
  assert.deepEqual(
    reconcileContractorClosing({ netAmount: 8200, invoiceReceivedAmount: 6000, complementPaidAmount: 2000 }),
    { difference: 200, status: "divergent" },
  );
  assert.equal(reconcileContractorClosing({ netAmount: 8200, invoiceReceivedAmount: 0, complementPaidAmount: 0 }).status, "pending");
  assert.equal(invoiceComparison(6000, 6000, true), "validated");
  assert.equal(invoiceComparison(6000, 5900, true), "divergent");
  assert.equal(invoiceComparison(6000, 0, false), "pending");
  assert.equal(invoiceComparison(0, 0, false), "not_required");
  assert.equal(componentDirectionFor("commission"), "credit");
  assert.equal(componentDirectionFor("health_plan"), "debit");
});

test("psicólogos: total por consulta, agregação da competência e efeito dos ajustes", () => {
  // "Funcionário João, psicóloga Maria, 3 consultas de R$ 100 = R$ 300 a pagar."
  assert.equal(calculateSessionTotal(3, 100), 300);
  assert.equal(calculateSessionTotal(2, 99.9), 199.8);

  const closing = calculatePsychologyClosing({
    sessions: [
      { employeeId: "joao", quantity: 3, unitAmount: 100 },
      { employeeId: "ana", quantity: 1, unitAmount: 120 },
      { employeeId: "ana", quantity: 2, unitAmount: 120 },
      { employeeId: "carlos", quantity: 5, unitAmount: 90, status: "canceled" },
    ],
  });
  assert.equal(closing.sessionsCount, 6);
  assert.equal(closing.entriesCount, 3);
  assert.equal(closing.employeesCount, 2);
  assert.equal(closing.grossAmount, 660);
  assert.equal(closing.netAmount, 660);
  assert.equal(closing.calcVersion, PSYCHOLOGY_CALC_VERSION);

  const ajustado = calculatePsychologyClosing({
    sessions: [{ employeeId: "joao", quantity: 3, unitAmount: 100 }],
    adjustments: [{ kind: "discount", amount: 50 }, { kind: "complement", amount: 20 }, { kind: "cancellation", amount: 100 }],
  });
  assert.equal(ajustado.grossAmount, 300);
  assert.equal(ajustado.adjustmentsAmount, -130);
  assert.equal(ajustado.netAmount, 170);
});

test("o valor unitário é histórico: mudar a tabela do psicólogo não altera lançamentos antigos", () => {
  const antes = calculatePsychologyClosing({ sessions: [{ employeeId: "joao", quantity: 2, unitAmount: 100 }] });
  const depoisDeReajustar = calculatePsychologyClosing({
    sessions: [{ employeeId: "joao", quantity: 2, unitAmount: 100 }, { employeeId: "joao", quantity: 1, unitAmount: 150 }],
  });
  assert.equal(antes.grossAmount, 200);
  assert.equal(depoisDeReajustar.grossAmount, 350);
});

test("os ciclos de vida dos fechamentos só permitem transições declaradas", () => {
  assert.equal(assertTransition(psychologyTransitions, "open", "review"), "review");
  assert.equal(assertTransition(psychologyTransitions, "scheduled", "paid"), "paid");
  assert.equal(assertTransition(psychologyTransitions, "paid", "closed"), "closed");
  assert.equal(assertTransition(psychologyTransitions, "closed", "reopened"), "reopened");
  assert.throws(() => assertTransition(psychologyTransitions, "open", "paid"), /não é permitida/);
  assert.throws(() => assertTransition(psychologyTransitions, "closed", "paid"), /não é permitida/);

  assert.equal(assertTransition(contractorTransitions, "approved", "invoice_pending"), "invoice_pending");
  assert.equal(assertTransition(contractorTransitions, "ready_to_pay", "paid"), "paid");
  assert.throws(() => assertTransition(contractorTransitions, "open", "closed"), /não é permitida/);
  assert.throws(() => assertTransition(contractorTransitions, "closed", "open"), /não é permitida/);
});

test("dados de pagamento são allowlisted e o material criptográfico nunca é projetado", () => {
  const account = sanitizePayoutAccount({ pixKey: "chave@banco", bankAccount: "12345-6", segredo: "descartar" });
  assert.deepEqual(Object.keys(account), ["pixKey", "bankAccount"]);
  assert.equal(Object.hasOwn(account, "segredo"), false);
  const projected = withoutSealedPayout({ id: "1", payout_encrypted: "cipher", payout_iv: "iv", payout_tag: "tag", payout_key_version: 1 });
  assert.equal(Object.hasOwn(projected, "payout_encrypted"), false);
  assert.equal(Object.hasOwn(projected, "payout_iv"), false);
  assert.equal(Object.hasOwn(projected, "payout_tag"), false);
  assert.equal(projected.id, "1");
});

test("capacidades separam operação, fechamento, limite e reabertura de pagamentos", () => {
  assert.equal(hasCapability("admin", "contractors.limits.manage"), true);
  assert.equal(hasCapability("admin", "payments.reopen"), true);
  assert.equal(hasCapability("member", "contractors.payments.manage"), true);
  assert.equal(hasCapability("member", "contractors.payments.close"), true);
  assert.equal(hasCapability("member", "contractors.limits.manage"), false);
  assert.equal(hasCapability("member", "payments.reopen"), false);
  assert.equal(hasCapability("member", "psychology.payments.manage"), true);
  assert.equal(hasCapability("observer", "contractors.payments.read"), true);
  assert.equal(hasCapability("observer", "contractors.payments.manage"), false);
  assert.equal(hasCapability("observer", "psychology.payments.read"), false);
  assert.equal(hasCapability("guest", "contractors.payments.read"), false);
});

test("as tabelas de pagamento são tenant-scoped, íntegras e com RLS forçada", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0018_payment_control_modules.sql", import.meta.url), "utf8"),
  ]);
  const tables = [
    "fdp_psychologist_profiles", "fdp_psychology_sessions", "fdp_psychology_closings", "fdp_psychology_adjustments",
    "fdp_psychology_payments", "fdp_contractor_profiles", "fdp_invoice_limit_policies", "fdp_contractor_closings",
    "fdp_contractor_components",
  ];
  for (const table of tables) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`));
    assert.match(migration, new RegExp(`"workspace_id" text DEFAULT NULLIF\\(current_setting\\('app.workspace_id', true\\), ''\\) NOT NULL`));
  }
  for (const declaration of ["psychologistProfiles", "psychologySessions", "psychologyClosings", "psychologyAdjustments",
    "psychologyPayments", "contractorProfiles", "invoiceLimitPolicies", "contractorClosings", "contractorComponents"]) {
    assert.match(schema, new RegExp(`export const ${declaration} = pgTable`));
  }
  // Chaves compostas impedem misturar empresa, competência e prestador de tenants distintos.
  assert.match(migration, /fdp_psychology_sessions_workspace_employee_fk/);
  assert.match(migration, /fdp_psychology_sessions_workspace_cycle_fk/);
  assert.match(migration, /fdp_contractor_closings_workspace_cycle_fk/);
  assert.match(migration, /fdp_contractor_components_workspace_closing_fk/);
  // Valores financeiros usam numeric, nunca ponto flutuante.
  assert.doesNotMatch(migration, /double precision/);
  assert.match(migration, /"net_amount" numeric\(18, 2\)/);
});

test("o banco garante a identidade do cálculo e a imutabilidade do fechamento", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0018_payment_control_modules.sql", import.meta.url), "utf8");
  // Nota esperada + complemento sempre reconstroem o líquido devido, e a nota nunca ultrapassa o limite.
  assert.match(migration, /fdp_contractor_closings_split_check/);
  assert.match(migration, /"invoice_expected_amount" \+ "fdp_contractor_closings"\."complement_amount" = "fdp_contractor_closings"\."net_amount"/);
  assert.match(migration, /fdp_contractor_closings_limit_cap_check/);
  assert.match(migration, /fdp_psychology_sessions_total_check/);
  assert.match(migration, /closed payment closing is immutable/);
  assert.match(migration, /reopening a closed payment closing requires a justification/);
  assert.match(migration, /payment entry of a closed closing is immutable/);
  assert.match(migration, /psychology adjustments are append-only/);
  assert.match(migration, /CREATE TRIGGER "fdp_psychology_closings_guard"/);
  assert.match(migration, /CREATE TRIGGER "fdp_contractor_closings_guard"/);
  assert.match(migration, /CREATE TRIGGER "fdp_contractor_components_guard"/);
});

test("as APIs de pagamento validam tenant, competência fechada, permissão e auditoria", async () => {
  const [sessions, contractorClosings, transition, invoice, caju, limits, adjustments, overview] = await Promise.all([
    readFile(new URL("../app/api/payments/psychology/sessions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/transition/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/invoice/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/caju/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/limits/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/psychology/closings/[id]/adjustments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/overview/route.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [sessions, contractorClosings, transition, invoice, caju, limits, adjustments, overview]) {
    assert.match(source, /getWorkspaceContext/);
    assert.doesNotMatch(source, /getWorkspaceSnapshot/);
  }
  for (const source of [sessions, contractorClosings, transition, invoice, caju, adjustments, overview]) {
    assert.match(source, /requireCompanyAccess/);
  }
  assert.match(sessions, /assertNoClinicalData/);
  assert.match(sessions, /requireOpenCycle/);
  assert.match(sessions, /PAYMENT_CLOSING_LOCKED/);
  assert.match(sessions, /prepareAuditEvent/);
  assert.match(adjustments, /ADJUSTMENT_REASON_REQUIRED/);
  assert.match(adjustments, /PAYMENT_CLOSING_LOCKED/);
  assert.match(transition, /COMPLEMENT_METHOD_REQUIRED/);
  assert.match(transition, /INVOICE_VALIDATION_REQUIRED/);
  assert.match(transition, /RECONCILIATION_DIVERGENT/);
  assert.match(transition, /REOPEN_REASON_REQUIRED/);
  assert.match(transition, /requireCapability\(workspace, "payments\.reopen"\)/);
  assert.match(transition, /AND status = \?/);
  assert.match(invoice, /refreshContractorReconciliation/);
  assert.match(limits, /requireCapability\(workspace, "contractors\.limits\.manage"\)/);
  assert.match(limits, /effective_to = \?/);
  // O complemento é controle assistido: nenhuma integração é declarada pronta.
  assert.match(caju, /connected: false/);
  assert.doesNotMatch(caju, /https?:\/\/[a-z]*\.?caju/i);
});

test("a interface de pagamento é modular, acessível e sem controle decorativo", async () => {
  const [workspace, view, dialogs] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/PaymentDialogs.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /<PaymentsView role=\{snapshot\.workspace\.role\} module="psychology" \/>/);
  assert.match(workspace, /<PaymentsView role=\{snapshot\.workspace\.role\} module="contractors" \/>/);
  assert.match(workspace, /Pagamento de Psicólogos/);
  assert.match(workspace, /Pagamentos PJ/);
  // O menu não recria admissão digital concorrendo com a Sólides.
  assert.doesNotMatch(workspace, /setView\("admissions"\)/);

  // A tabela PJ responde às perguntas obrigatórias do produto.
  for (const column of ["Líquido", "Limite NF", "NF esperada", "Complemento", "Conciliação"]) {
    assert.ok(view.includes(column), `coluna ausente: ${column}`);
  }
  assert.match(view, /Quanto o prestador tem a receber/);
  assert.match(view, /Quantas consultas válidas/);
  assert.match(view, /styles\.emptyState/);
  assert.match(view, /styles\.errorState/);
  assert.match(view, /styles\.loadingState/);
  assert.match(view, /role="alert"/);
  assert.doesNotMatch(view + dialogs, /localStorage|sessionStorage|window\.location\.reload/);
  // Diálogos com foco preso, escape e sem campo clínico.
  assert.match(dialogs, /event\.key !== "Tab"/);
  assert.match(dialogs, /previous\?\.focus/);
  assert.match(dialogs, /aria-modal="true"/);
  assert.doesNotMatch(dialogs, /name="diagnosis"|name="clinicalNote"|Prontuário/i);
  assert.match(dialogs, /Não registre diagnóstico/);
});
