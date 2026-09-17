import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilities, capabilitiesForRole, hasCapability } from "../lib/authorization.ts";
import { capabilityCatalog } from "../lib/capability-catalog.ts";
import { moduleWriteCapabilities } from "../lib/modules.ts";
import {
  addCompetenceMonths, advanceAmount, advancePaymentKey, competenceDistance, competenceSeries,
  confirmableCents, confirmationKey, contractorComponentType, contractorProjectionKey,
  formatCompetence, fromCents, isCompetence, ledgerBalance, ledgerCategories, ledgerCategoryFields,
  ledgerCategoryLabels, planInstallments, ruleInEffect, splitInstallments, terminationPendingKey,
  terminationSignals, toCents,
  type InstallmentBalanceInput,
} from "../lib/payroll-ledger.ts";

/**
 * Adiantamentos e Descontos — a aritmética e as fronteiras.
 *
 * A planilha que este módulo substitui errava em quatro pontos, e são eles que
 * estes testes prendem:
 *
 *  1. **a soma das parcelas não fechava com o total.** "5/10 R$ 200,00" só
 *     funciona quando o total divide certinho; R$ 1.000,00 em 3× escrito à mão
 *     perde ou cobra um centavo;
 *  2. **a virada de ano.** Seis parcelas a partir de 11/2025 terminam em
 *     04/2026, e a conta ingênua de somar ao mês erra quando passa de dezembro;
 *  3. **"lançado" virava "descontado".** Aqui a competência passar, o lote ser
 *     exportado ou o mês fechar não mexem em saldo nenhum;
 *  4. **o vale fixo virava dívida infinita.** Recorrente sem prazo não tem
 *     total, e o produto não inventa um.
 *
 * As invariantes que dependem do banco — append-only, serialização de duas
 * confirmações simultâneas, imutabilidade do lote fechado — estão em
 * `scripts/ledger-db-rehearsal.sql`, porque são triggers e índices, não
 * aritmética. Aqui verificamos que a migration os declara.
 */

const migration = await readFile(new URL("../drizzle/postgres/0085_payroll_ledger.sql", import.meta.url), "utf8");

const installment = (over: Partial<InstallmentBalanceInput> = {}): InstallmentBalanceInput => ({
  plannedAmount: 200, discountedAmount: 0, status: "scheduled", ...over,
});

// ---------------------------------------------------------------------------
// Parcelamento
// ---------------------------------------------------------------------------

test("a soma das parcelas é exatamente o total, com ou sem resto", () => {
  for (const [total, count] of [[100000, 10], [100000, 3], [200000, 10], [1, 1], [333, 7], [99999, 13]] as const) {
    const parts = splitInstallments(total, count);
    assert.equal(parts.length, count, `${total} em ${count}x devolveu ${parts.length} parcelas`);
    assert.equal(parts.reduce((sum, part) => sum + part, 0), total, `${total} em ${count}x não fecha`);
  }
});

test("o resto em centavos vai para as primeiras parcelas", () => {
  // R$ 1.000,00 em 3x: 333,34 + 333,33 + 333,33. Nunca 333,33 três vezes (perde
  // um centavo) nem 333,34 três vezes (cobra dois a mais).
  assert.deepEqual(splitInstallments(100000, 3).map(fromCents), [333.34, 333.33, 333.33]);
  assert.deepEqual(splitInstallments(200000, 10).map(fromCents), Array(10).fill(200));
});

test("o parcelamento recusa mais parcelas do que centavos", () => {
  assert.throws(() => splitInstallments(500, 600), /mais parcelas/);
});

test("a programação atravessa a virada de ano", () => {
  const plan = planInstallments({ totalCents: 200000, count: 6, firstCompetence: "2025-11" });
  assert.deepEqual(plan.map((part) => part.competence), ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04"]);
  assert.equal(plan.at(-1)?.number, 6);
  assert.equal(plan.every((part) => part.totalCount === 6), true);
});

test("somar meses funciona além de doze", () => {
  assert.equal(addCompetenceMonths("2026-11", 4), "2027-03");
  assert.equal(addCompetenceMonths("2026-01", 24), "2028-01");
  assert.equal(addCompetenceMonths("2026-03", -4), "2025-11");
  assert.equal(competenceDistance("2025-11", "2026-04"), 5);
  assert.equal(competenceDistance("2026-04", "2025-11"), -5);
});

test("competência aceita só o formato que o banco aceita", () => {
  assert.equal(isCompetence("2026-09"), true);
  for (const bad of ["2026-13", "2026-00", "26-09", "2026/09", "", null, 202609]) {
    assert.equal(isCompetence(bad), false, `${String(bad)} deveria ser recusada`);
  }
  assert.equal(formatCompetence("2026-09"), "09/2026");
});

test("valores em reais entram e saem sem erro de ponto flutuante", () => {
  assert.equal(toCents(0.1) + toCents(0.2), toCents(0.3));
  assert.equal(toCents("1.234,56"), 123456);
  assert.equal(toCents("R$ 200,00".replace(/[^\d.,-]/g, "")), 20000);
  assert.equal(fromCents(33334), 333.34);
});

// ---------------------------------------------------------------------------
// Saldos
// ---------------------------------------------------------------------------

test("dois empréstimos simultâneos da mesma pessoa têm saldos independentes", () => {
  const primeiro = ledgerBalance([
    installment({ plannedAmount: 200, discountedAmount: 200, status: "discounted" }),
    installment({ plannedAmount: 200 }),
  ]);
  const segundo = ledgerBalance([
    installment({ plannedAmount: 333.34 }),
    installment({ plannedAmount: 333.33 }),
    installment({ plannedAmount: 333.33 }),
  ]);
  assert.equal(primeiro.remainingCents, 20000);
  assert.equal(segundo.remainingCents, 100000);
  assert.equal(primeiro.openInstallments, 1);
  assert.equal(segundo.openInstallments, 3);
});

test("desconto parcial deixa o saldo visível e não o recobra sozinho", () => {
  const balance = ledgerBalance([
    installment({ plannedAmount: 200, discountedAmount: 150, status: "partially_discounted" }),
    installment({ plannedAmount: 200 }),
  ]);
  // O que faltou dos R$ 200 continua no saldo da própria parcela; a parcela
  // seguinte permanece nos R$ 200 dela. O produto não empurra a diferença para
  // a frente sem alguém mandar.
  assert.equal(balance.plannedCents, 40000);
  assert.equal(balance.discountedCents, 15000);
  assert.equal(balance.remainingCents, 25000);
  assert.equal(confirmableCents(installment({ plannedAmount: 200, discountedAmount: 150 })), 5000);
});

test("parcela pulada, cancelada ou reprogramada sai do previsto sem apagar o que já foi descontado", () => {
  const balance = ledgerBalance([
    installment({ plannedAmount: 200, discountedAmount: 200, status: "discounted" }),
    installment({ plannedAmount: 200, status: "skipped" }),
    installment({ plannedAmount: 200, status: "rescheduled" }),
    installment({ plannedAmount: 200, discountedAmount: 50, status: "canceled" }),
  ]);
  assert.equal(balance.discountedCents, 25000);
  assert.equal(balance.plannedCents, 25000);
  assert.equal(balance.remainingCents, 0);
});

test("o saldo nunca fica negativo", () => {
  const balance = ledgerBalance([installment({ plannedAmount: 100, discountedAmount: 150, status: "discounted" })]);
  assert.equal(balance.remainingCents, 0);
});

test("a competência passar não desconta nada", () => {
  // Não há função de tempo no cálculo: o saldo só muda quando uma confirmação
  // entra. Este teste existe para que alguém que adicione "se a competência
  // passou, marque como descontada" quebre aqui.
  const antes = ledgerBalance([installment({ plannedAmount: 200 })]);
  const depois = ledgerBalance([installment({ plannedAmount: 200 })]);
  assert.deepEqual(antes, depois);
  assert.equal(antes.discountedCents, 0);
});

// ---------------------------------------------------------------------------
// Adiantamentos
// ---------------------------------------------------------------------------

test("adiantamento fixo calcula; percentual sem base vira pendência, não zero", () => {
  assert.deepEqual(advanceAmount({ mode: "fixed_monthly", fixedAmount: 500 }), { ok: true, cents: 50000 });
  assert.deepEqual(advanceAmount({ mode: "single_competence", fixedAmount: 1040 }), { ok: true, cents: 104000 });

  const semBase = advanceAmount({ mode: "percentage", percentage: 40 });
  assert.equal(semBase.ok, false);
  assert.match(semBase.ok === false ? semBase.pendingReason : "", /base salarial/i);

  const comBase = advanceAmount({ mode: "percentage", percentage: 40, salaryBaseAmount: 3175 });
  assert.deepEqual(comBase, { ok: true, cents: 127000 });
});

test("percentual sobre base zero é pendência, não R$ 0,00", () => {
  const resultado = advanceAmount({ mode: "percentage", percentage: 40, salaryBaseAmount: 0 });
  assert.equal(resultado.ok, false);
});

test("alteração de valor com vigência futura não reescreve as competências anteriores", () => {
  const regras = [
    { effectiveFromCompetence: "2026-01", endCompetence: null, status: "superseded", fixedAmount: 300 },
    { effectiveFromCompetence: "2026-10", endCompetence: null, status: "active", fixedAmount: 350 },
  ];
  assert.equal(ruleInEffect(regras, "2026-08")?.fixedAmount, 300);
  assert.equal(ruleInEffect(regras, "2026-09")?.fixedAmount, 300);
  assert.equal(ruleInEffect(regras, "2026-10")?.fixedAmount, 350);
  assert.equal(ruleInEffect(regras, "2027-01")?.fixedAmount, 350);
  // Antes da primeira vigência não existe regra — e não é a regra futura que vale.
  assert.equal(ruleInEffect(regras, "2025-12"), null);
});

test("regra cancelada e regra encerrada saem de vigência", () => {
  const regras = [
    { effectiveFromCompetence: "2026-01", endCompetence: "2026-06", status: "active", fixedAmount: 300 },
    { effectiveFromCompetence: "2026-07", endCompetence: null, status: "canceled", fixedAmount: 900 },
  ];
  assert.equal(ruleInEffect(regras, "2026-05")?.fixedAmount, 300);
  assert.equal(ruleInEffect(regras, "2026-08"), null);
});

// ---------------------------------------------------------------------------
// Idempotência e fronteiras
// ---------------------------------------------------------------------------

test("a chave de confirmação é determinística: duplo clique produz a mesma", () => {
  const argumentos = { installmentId: "i1", competence: "2026-09", amountCents: 20000, kind: "confirmation", batchId: "b1" };
  assert.equal(confirmationKey(argumentos), confirmationKey({ ...argumentos }));
  assert.notEqual(confirmationKey(argumentos), confirmationKey({ ...argumentos, amountCents: 20001 }));
  assert.notEqual(confirmationKey(argumentos), confirmationKey({ ...argumentos, kind: "reversal" }));
});

test("a ocorrência mensal do adiantamento tem uma chave por competência", () => {
  assert.equal(advancePaymentKey("en1", "2026-09"), advancePaymentKey("en1", "2026-09"));
  assert.notEqual(advancePaymentKey("en1", "2026-09"), advancePaymentKey("en1", "2026-10"));
});

test("a projeção PJ reusa o external_id que o banco já torna único", () => {
  assert.equal(contractorProjectionKey("i1"), "ledger:i1");
  // O índice `fdp_contractor_components_workspace_external_uq` já existia: é ele
  // que impede o recálculo do fechamento PJ de lançar o desconto duas vezes.
  assert.equal(contractorComponentType("loan"), "loan");
  assert.equal(contractorComponentType("salary_advance"), "advance");
  assert.equal(contractorComponentType("equipment_damage"), "equipment");
  assert.equal(contractorComponentType("traffic_fine"), "other_debit");
});

test("o desligamento sinaliza o saldo e não desconta nada", () => {
  const sinais = terminationSignals([
    { id: "en1", title: "Empréstimo", balance: ledgerBalance([installment({ plannedAmount: 200 })]) },
    { id: "en2", title: "Multa quitada", balance: ledgerBalance([installment({ plannedAmount: 100, discountedAmount: 100, status: "discounted" })]) },
  ]);
  assert.equal(sinais.length, 1);
  assert.equal(sinais[0].entryId, "en1");
  assert.equal(sinais[0].remainingCents, 20000);
  assert.equal(terminationPendingKey("en1"), "ledger:en1:termination");
});

// ---------------------------------------------------------------------------
// Vocabulário e catálogo
// ---------------------------------------------------------------------------

test("toda categoria tem rótulo em português e lista de campos próprios", () => {
  for (const category of ledgerCategories) {
    assert.equal(typeof ledgerCategoryLabels[category], "string");
    assert.notEqual(ledgerCategoryLabels[category], "");
    assert.equal(Array.isArray(ledgerCategoryFields[category]), true);
  }
  // A multa pede placa e auto de infração; o desconto genérico não pede nada.
  // É isso que mantém a janela curta para o caso comum.
  assert.equal(ledgerCategoryFields.traffic_fine.some((field) => field.key === "plate"), true);
  assert.equal(ledgerCategoryFields.traffic_fine.some((field) => field.key === "ticketNumber"), true);
  assert.equal(ledgerCategoryFields.other.length, 0);
});

test("as permissões do módulo estão no catálogo e descritas para quem administra", () => {
  const doModulo = capabilities.filter((capability) => capability.startsWith("ledger."));
  assert.equal(doModulo.length, 13);
  for (const capability of doModulo) {
    const entry = capabilityCatalog[capability];
    assert.ok(entry, `${capability} não está no catálogo`);
    assert.equal(entry.area, "operations");
    assert.notEqual(entry.label, "");
    // O rótulo é lido por quem concede a permissão: não pode ser o nome técnico.
    assert.equal(entry.label.includes("ledger."), false);
  }
});

test("solicitar, aprovar, pagar e confirmar são permissões distintas", () => {
  // São quatro decisões, frequentemente de quatro pessoas. Uma permissão só
  // para as quatro apagaria a segregação que o módulo existe para ter.
  for (const capability of ["ledger.request", "ledger.approve", "ledger.pay", "ledger.confirm"] as const) {
    assert.equal(capabilities.includes(capability), true);
  }
});

test("estornar, autorizar acima do saldo e reabrir não vêm de graça com o papel", () => {
  // Observador não escreve nada; membro não autoriza cobrar a mais nem reabre
  // competência encerrada.
  assert.equal(hasCapability("observer", "ledger.read"), true);
  assert.equal(hasCapability("observer", "ledger.manage"), false);
  assert.equal(hasCapability("observer", "ledger.confirm"), false);
  assert.equal(hasCapability("member", "ledger.confirm"), true);
  assert.equal(hasCapability("member", "ledger.override"), false);
  assert.equal(hasCapability("member", "ledger.reopen"), false);
  assert.equal(hasCapability("admin", "ledger.override"), true);
  assert.equal(hasCapability("admin", "ledger.reopen"), true);
  assert.equal(hasCapability("guest", "ledger.read"), false);
});

test("negar o módulo fecha todas as portas de escrita sobre o salário", () => {
  const governadas = new Set(moduleWriteCapabilities.payroll_ledger);
  const escrita = capabilities.filter((capability) => capability.startsWith("ledger.") && capability !== "ledger.read");
  for (const capability of escrita) {
    assert.equal(governadas.has(capability), true, `${capability} ficaria aberta com o módulo negado`);
  }
  // A leitura fica fora: quem governa a visão é a capability do catálogo de
  // módulos, e listá-la aqui de novo não acrescenta porta nenhuma.
  assert.equal(governadas.has("ledger.read" as never), false);
});

test("o papel de membro recebe o módulo inteiro menos as três ações de risco", () => {
  const doMembro = capabilitiesForRole("member").filter((capability) => capability.startsWith("ledger."));
  assert.deepEqual(doMembro, [
    "ledger.read", "ledger.request", "ledger.manage", "ledger.approve", "ledger.pay",
    "ledger.confirm", "ledger.reverse", "ledger.reschedule", "ledger.import",
    "ledger.export", "ledger.close",
  ]);
});

// ---------------------------------------------------------------------------
// O que a migration precisa declarar
// ---------------------------------------------------------------------------

test("as dez tabelas do módulo nascem com isolamento por tenant", () => {
  const tabelas = [
    "fdp_ledger_batches", "fdp_ledger_entries", "fdp_ledger_installments",
    "fdp_ledger_confirmations", "fdp_ledger_advance_rules", "fdp_ledger_advance_payments",
    "fdp_ledger_documents", "fdp_ledger_events", "fdp_ledger_imports", "fdp_ledger_import_rows",
  ];
  for (const tabela of tabelas) {
    assert.match(migration, new RegExp(`CREATE TABLE "${tabela}"`), `${tabela} não é criada`);
    assert.match(migration, new RegExp(`ALTER TABLE "${tabela}" ENABLE ROW LEVEL SECURITY`), `${tabela} sem RLS`);
    assert.match(migration, new RegExp(`ALTER TABLE "${tabela}" FORCE ROW LEVEL SECURITY`), `${tabela} sem FORCE RLS`);
    assert.match(migration, new RegExp(`CREATE POLICY "${tabela}_workspace_isolation"`), `${tabela} sem política`);
  }
});

test("a confirmação e o histórico são append-only no banco, não só no serviço", () => {
  assert.match(migration, /fdp_ledger_confirmations is append-only/);
  assert.match(migration, /fdp_ledger_events is append-only/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "fdp_ledger_confirmations"/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "fdp_ledger_events"/);
});

test("o saldo da parcela é mantido por trigger, com lock que serializa duas confirmações", () => {
  assert.match(migration, /fdp_ledger_apply_confirmation/);
  // O `FOR UPDATE` é o que faz a segunda confirmação enxergar a primeira. Sem
  // ele, duas sessões leem saldo zero e as duas gravam.
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /exceeds the installment balance/);
  assert.match(migration, /reversal exceeds the confirmed amount/);
});

test("parcela confirmada é preservada e lote fechado é imutável", () => {
  assert.match(migration, /confirmed installment is immutable/);
  assert.match(migration, /confirmed installment cannot be canceled, skipped or rescheduled/);
  assert.match(migration, /closed ledger batch is immutable/);
  assert.match(migration, /reopening a closed ledger batch requires a justification/);
});

test("uma solicitação aprovada origina um único lançamento", () => {
  assert.match(migration, /CREATE UNIQUE INDEX "fdp_ledger_entries_origin_uq"[^;]*WHERE "origin_id" <> ''/);
});

test("recorrente sem prazo não carrega saldo devedor total", () => {
  assert.match(migration, /"modality" = 'recurring' AND "total_amount" IS NULL/);
});

test("o módulo entra no catálogo e em todos os planos", () => {
  assert.match(migration, /INSERT INTO "fdp_modules"[\s\S]*'payroll_ledger'/);
  assert.match(migration, /INSERT INTO "fdp_plan_modules"[\s\S]*'payroll_ledger'/);
  assert.match(migration, /'ledger\.read'/);
});

test("a aprovação reusa a máquina existente em vez de criar a segunda", () => {
  // `payroll_discount` e `salary_advance` entram no CHECK de
  // `fdp_employee_movements`: aprovar um lançamento passa a ser uma
  // movimentação, entra na fila que já existe e barra o fechamento enquanto não
  // for decidida.
  assert.match(migration, /'payroll_discount', 'salary_advance'/);
  assert.match(migration, /'card', 'ledger_entry'/);
  assert.match(migration, /'integration', 'payroll_ledger'/);
});

test("a migration é aditiva: nenhuma tabela ou coluna some", () => {
  assert.equal(/DROP\s+TABLE/i.test(migration), false);
  assert.equal(/DROP\s+COLUMN/i.test(migration), false);
  assert.equal(/DELETE\s+FROM/i.test(migration), false);
  assert.equal(/TRUNCATE/i.test(migration), false);
});
