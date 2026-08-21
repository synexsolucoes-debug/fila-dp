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

test("diferença fixa do PJ vai para Caju sem aumentar a nota fiscal", () => {
  const transferencia = calculateContractorClosing({
    baseAmount: 6500,
    components: [],
    invoiceLimit: limit(6000),
    complementMethod: "manual_transfer",
    fixedCajuAmount: 750,
  });
  assert.equal(transferencia.invoiceExpectedAmount, 6000);
  assert.equal(transferencia.fixedCajuAmount, 750);
  assert.equal(transferencia.complementAmount, 1250);
  assert.equal(transferencia.cajuAmount, 750);
  assert.equal(transferencia.netAmount, 7250);
  assert.equal(transferencia.invoiceExpectedAmount + transferencia.complementAmount, transferencia.netAmount);

  const caju = calculateContractorClosing({
    baseAmount: 6500,
    components: [],
    invoiceLimit: limit(6000),
    complementMethod: "caju_saldo_livre",
    fixedCajuAmount: 750,
  });
  assert.equal(caju.invoiceExpectedAmount, 6000);
  assert.equal(caju.complementAmount, 1250);
  assert.equal(caju.cajuAmount, 1250, "diferença fixa e excedente regular seguem juntos para o Caju");
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
  const [sessions, contractorClosings, transition, invoice, caju, limits, adjustments, overview, fixedItems] = await Promise.all([
    readFile(new URL("../app/api/payments/psychology/sessions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/transition/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/invoice/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/caju/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/limits/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/psychology/closings/[id]/adjustments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/fixed-items/route.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [sessions, contractorClosings, transition, invoice, caju, limits, adjustments, overview, fixedItems]) {
    assert.match(source, /getWorkspaceContext/);
    assert.doesNotMatch(source, /getWorkspaceSnapshot/);
  }
  for (const source of [sessions, contractorClosings, transition, invoice, caju, adjustments, overview, fixedItems]) {
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
  assert.match(fixedItems, /requireCapability\(workspace, "contractors\.payments\.manage"\)/);
  assert.match(fixedItems, /readFixedItemInput\(body\)/);
  assert.match(fixedItems, /prepareAuditEvent/);
  assert.match(overview, /fdp_contractor_fixed_items/);
  // O complemento é controle assistido: nenhuma integração é declarada pronta.
  assert.match(caju, /connected: false/);
  assert.doesNotMatch(caju, /https?:\/\/[a-z]*\.?caju/i);
});

test("a interface de pagamento é modular, acessível e sem controle decorativo", async () => {
  const [workspace, shell, sections, dialogs, contractorDetail] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/ContractorSections.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/PaymentDialogs.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/ContractorPaymentDetail.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /<PaymentsView role=\{snapshot\.workspace\.role\} module="psychology" \/>/);
  // O PJ deixou de ser uma tela e virou oito (§74); a casca escolhe qual pelo
  // destino ativo, em vez de repetir o componente oito vezes.
  assert.match(workspace, /\{isContractorSection\(view\) && <PaymentsView role=\{snapshot\.workspace\.role\} module="contractors" section=\{view\} \/>\}/);
  assert.match(workspace, /Pagamento de Psicólogos/);
  assert.match(workspace, /PAGAMENTO PJ/);
  // O menu não recria admissão digital concorrendo com a Sólides.
  assert.doesNotMatch(workspace, /setView\("admissions"\)/);

  /* A tabela PJ responde às perguntas obrigatórias do produto.
     "Conciliação" saiu desta lista junto com "Status complemento" e
     "Fechamento": as três foram retiradas da tabela a pedido de quem confere,
     porque disputavam largura com os números que se olha todo dia. Elas
     continuam no banco e no extrato analítico — o que mudou foi o que ocupa a
     tela, não o que o sistema guarda. A conferência de que não voltaram está
     em `tests/contractor-entry.test.mts`. */
  for (const column of ["Líquido", "Limite NF", "NF esperada", "Complemento"]) {
    assert.ok(sections.includes(column), `coluna ausente: ${column}`);
  }
  assert.match(shell, /Quanto o prestador tem a receber/);
  assert.match(shell, /Quantas consultas válidas/);
  // Os três estados continuam existindo; mudaram de nome e de dono. A tira de
  // aviso em linha deste módulo nunca foi o estado vazio do painel — o nome
  // igual ao do componente compartilhado confundia os dois —, e o aviso de erro
  // passou a ser o mesmo dos outros oito módulos, que traz `role="alert"`
  // consigo em vez de depender de cada chamada lembrar dele.
  assert.match(shell, /styles\.noteLine/);
  assert.match(shell, /styles\.loadingLine/);
  assert.match(shell, /<ErrorBanner message=\{error\} \/>/);
  const banner = await readFile(new URL("../app/painel/features/shared/panel-ui.tsx", import.meta.url), "utf8");
  assert.match(banner, /className=\{styles\.errorBanner\} role="alert"/);
  assert.doesNotMatch(shell + sections + dialogs, /localStorage|sessionStorage|window\.location\.reload/);
  // Diálogos com foco preso, escape e sem campo clínico.
  assert.match(dialogs, /event\.key !== "Tab"/);
  assert.match(dialogs, /previous\?\.focus/);
  assert.match(dialogs, /aria-modal="true"/);
  assert.doesNotMatch(dialogs, /name="diagnosis"|name="clinicalNote"|Prontuário/i);
  assert.match(dialogs, /Não registre diagnóstico/);
  assert.match(dialogs, /Lançamento fixo do prestador/);
  assert.match(dialogs, /Sem término/);
  assert.match(dialogs, /Com término determinado/);
  for (const section of ["Proventos", "Descontos"]) {
    assert.ok(contractorDetail.includes(section), `detalhamento PJ sem a seção ${section}`);
  }

  assert.match(
    contractorDetail,
    /ContractorAnalyticalStatement/,
    "detalhamento PJ deve integrar o extrato analítico",
  );

  const analyticalStatement = await readFile(
    new URL(
      "../app/painel/features/payments/ContractorAnalyticalStatement.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  for (const section of [
    "Resumo da conferência",
    "Total de proventos",
    "Total de descontos",
    "Líquido devido",
    "Complemento Caju",
    "Valor em Nota Fiscal",
    "Valor da NF recebida",
    "Diferença da NF",
  ]) {
    assert.ok(
      analyticalStatement.includes(section),
      `extrato analítico PJ sem a seção ${section}`,
    );
  }

  assert.doesNotMatch(
    analyticalStatement,
    /Caju previsto|Caju realizado|Diferença Caju/i,
    "extrato deve apresentar somente o Complemento Caju",
  );
  assert.match(contractorDetail, /aria-modal="true"/);
  // O nome do prestador é o botão que abre o detalhamento — o gesto mora na
  // tabela, que agora é compartilhada pelos destinos que a mostram.
  assert.match(shell, /openContractorDetail\(closingId\)/);
  assert.match(sections, /onOpenDetail\(row\.id\)/);
});

test("o Pagamento PJ tem oito destinos, e cada um mostra dado que o servidor entrega (§74, §75)", async () => {
  /* Era uma tela só, rolando: totais, lançamentos fixos, exportação Caju e uma
     tabela de treze colunas, um embaixo do outro. Dois assuntos com dados
     próprios no servidor não tinham lugar nenhum — as políticas de limite
     existiam só dentro de um diálogo, e o histórico de competências só como
     opção de um `<select>`.

     O que este teste prende não é o número oito: é que nenhum destino seja
     casca. Cada um lê um campo que a resposta do servidor de fato traz, e
     "Contratos" continua fora justamente porque a entidade não existe. */
  const [catalogo, secoes, navegacao, casca] = await Promise.all([
    readFile(new URL("../app/painel/features/payments/contractor-sections.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/ContractorSections.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/process-navigation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);

  const destinos = [...catalogo.matchAll(/^\s{4}id: "(contractor\w+)",$/gmu)].map((match) => match[1]);
  assert.equal(destinos.length, 8, "o Pagamento PJ deixou de ter oito destinos");
  assert.deepEqual(new Set(destinos).size, 8, "há destino repetido no catálogo");

  // Sem "Contratos": não existe a entidade, e página vazia esperando conteúdo
  // é exatamente o que a §75 proíbe.
  assert.doesNotMatch(catalogo, /label: "Contratos"/u);

  // Cada destino é alcançável pelo menu e existe como tela na casca.
  for (const destino of destinos) {
    assert.ok(navegacao.includes(`"${destino}"`), `${destino} não tem porta no menu`);
    assert.match(casca, new RegExp(`\\n  ${destino}: \\{`, "u"), `${destino} fora do catálogo de telas`);
  }

  // E cada um lê um campo real da resposta do servidor — nenhum é decoração.
  for (const [destino, campo] of [
    ["contractorProviders", "overview.contractors"],
    ["contractorCycles", "overview.cycles"],
    ["contractorClosings", "overview.closings"],
    ["contractorAdjustments", "overview.fixedItems"],
    ["contractorLimits", "overview.invoiceLimitPolicies"],
    ["contractorCaju", "overview.totals.cajuAmount"],
  ] as const) {
    const campoNoDesestruturar = campo.replace("overview.", "");
    assert.ok(
      secoes.includes(campo) || new RegExp(`\\{[^}]*\\b${campoNoDesestruturar.split(".")[0]}\\b[^}]*\\} = overview`, "u").test(secoes),
      `${destino} não lê ${campo} — é tela sem dado`,
    );
  }

  // O cabeçalho e as ações falam do destino, não do módulo inteiro: numa tela
  // de limites, "Crédito/desconto" é uma ação sem o que fazer ali.
  const casca2 = await readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8");
  assert.match(casca2, /const actions = module === "contractors"\s*\n\s*\? contractorActionsFor\(section\)/u);
  assert.match(casca2, /\{canManage && actions\.recalculate && \(/u);
  assert.match(casca2, /\{actions\.limit && \(|permissions\?\.manageLimits && actions\.limit && \(/u);
});

test("o extrato analítico é analítico: rubrica por linha, e alcançável de onde se confere", async () => {
  /* O módulo já tinha dois relatórios PJ, os dois sintéticos: uma linha por
     prestador, com os totais somados. Servem para saber quanto sai, não para
     conferir de onde o número veio — e conferir é exatamente perguntar "por
     que este desconto de 340,00 existe".

     Havia um analítico, mas de um prestador por vez, montado no navegador a
     partir do detalhamento aberto na tela: conferir trinta prestadores custava
     trinta diálogos e trinta arquivos.

     O que este teste prende é a forma. Que a soma fecha com a apuração é outra
     conta, feita contra um PostgreSQL de verdade em
     `scripts/rehearse-contractor-statement.mjs` — aqui não haveria como. */
  const [catalogo, secoes] = await Promise.all([
    readFile(new URL("../lib/payment-reports.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/ContractorSections.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(catalogo, /"contractor-analytical": \{/u);
  // Rubrica e valor por linha é o que separa analítico de sintético.
  for (const coluna of ["rubrica", "valor", "tipo", "quantidade", "situacao", "documento"]) {
    assert.match(catalogo, new RegExp(`"${coluna}"`, "u"), `o extrato não traz a coluna ${coluna}`);
  }
  // O valor contratual é linha, não coluna repetida: quem confere soma a coluna
  // e o total precisa bater com o líquido.
  assert.match(catalogo, /'Valor contratual' AS rubrica/u);
  assert.match(catalogo, /UNION ALL/u);
  // Lançamento cancelado aparece. Sumir com ele deixaria quem confere sem
  // explicação para a diferença entre o lançado e o apurado.
  assert.doesNotMatch(catalogo, /k\.status = 'active'/u);
  // Uma coluna, um vocabulário: "ativo" ao lado de "active" faria o filtro da
  // planilha descartar metade das linhas sem avisar.
  assert.doesNotMatch(catalogo, /'ativo' AS situacao/u);
  // O fechamento excluído continua fora, nos dois lados da união.
  assert.equal((catalogo.match(/c\.excluded_at IS NULL/gu) ?? []).length >= 2, true,
    "o lado dos lançamentos precisa excluir o fechamento excluído também");

  // A rota e o ensaio leem o mesmo catálogo — um ensaio que reescreve a
  // consulta prova a cópia e deixa o produto sem prova.
  const rota = await readFile(new URL("../app/api/payments/reports/route.ts", import.meta.url), "utf8");
  assert.match(rota, /import \{ reports, type PaymentReportKey \} from "@\/lib\/payment-reports"/u);
  assert.doesNotMatch(rota, /const reports = \{/u);
  const ensaio = await readFile(new URL("../scripts/rehearse-contractor-statement.mjs", import.meta.url), "utf8");
  assert.match(ensaio, /import \{ reports \} from "\.\.\/lib\/payment-reports\.ts"/u);

  // E é alcançável de onde a conferência acontece, não só do arquivo de
  // encerramento.
  assert.match(secoes, /reportUrl\("contractor-analytical"\)/u);
  // E em PDF, que é o que se entrega: o formato da folha analítica que o
  // escritório já sabe conferir. O CSV fica para quem cruza em planilha.
  assert.match(secoes, /reportUrl\("contractor-analytical", "pdf"\)/u);
  assert.match(secoes, /Emitir extrato analítico \(PDF\)/u);
});

test("todo estado de competência tem tradução na tela", async () => {
  /* O selo do cabeçalho imprimia o valor cru quando o mapa não conhecia o
     estado: "Competência processing", em inglês, no meio de uma tela em
     português. O mapa cobria os estados do fechamento de um prestador e
     nenhum dos três intermediários da competência.

     A lista de estados vem da restrição do banco, não de uma cópia à mão:
     acrescentar um estado lá e esquecer aqui é justamente como o defeito
     apareceu. */
  const [migration, view] = await Promise.all([
    readFile(new URL("../drizzle/postgres/0014_operation_dp_foundation.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8"),
  ]);
  const restricao = migration.match(/fdp_payroll_cycles_status_check[^\n]*IN \(([^)]*)\)/u)?.[1] ?? "";
  const estados = [...restricao.matchAll(/'(\w+)'/gu)].map((match) => match[1]);
  assert.ok(estados.length >= 5, "os estados da competência não foram lidos da migration");
  for (const estado of estados) {
    assert.match(view, new RegExp(`\\b${estado}: "`, "u"), `estado de competência sem tradução: ${estado}`);
  }
});

test("exclusão lógica do pagamento PJ preserva auditoria e some da operação", async () => {
  const [migration, detailRoute, closingRoute, componentRoute, overview, cajuExport, reports, publicApi, detail] = await Promise.all([
    readFile(new URL("../drizzle/postgres/0050_contractor_payment_exclusions.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/components/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/caju/export/route.ts", import.meta.url), "utf8"),
    // As consultas dos relatórios mudaram de casa: saíram da rota para
    // `lib/payment-reports.ts`, de onde o ensaio contra PostgreSQL também as
    // importa. A conferência segue o SQL, não o arquivo onde ele morava.
    readFile(new URL("../lib/payment-reports.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/contractor-closings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/ContractorPaymentDetail.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /excluded_at/);
  assert.match(migration, /exclusion_reason/);
  assert.doesNotMatch(migration, /DROP TABLE/i);
  assert.match(detailRoute, /export async function DELETE/);
  assert.match(detailRoute, /contractor_closing\.excluded/);
  assert.match(detailRoute, /payments\.reopen/);
  assert.doesNotMatch(detailRoute, /DELETE FROM fdp_contractor_closings/i);
  assert.match(closingRoute, /excluded_by_recalculation/);
  assert.match(closingRoute, /apurationBlock/);
  assert.match(closingRoute, /competence >= endCompetence/);
  assert.match(closingRoute, /removedCount/);
  assert.match(componentRoute, /upsertContractorClosing/);
  assert.match(componentRoute, /FIXED_COMPONENT_EDIT_REQUIRES_SOURCE/);
  assert.match(overview, /c\.excluded_at IS NULL/);
  assert.match(overview, /p\.status = 'active'/);
  assert.match(cajuExport, /c\.excluded_at IS NULL/);
  assert.match(reports, /c\.excluded_at IS NULL/);
  assert.match(publicApi, /k\.excluded_at IS NULL/);
  assert.match(detail, /Excluir pagamento/);
  assert.match(detail, /Editar/);
  assert.match(detail, /Cancelar lançamento/);
});
