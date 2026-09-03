import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  apurationBlock, assertContractCoherent, assertContractValueNotBelowConsumed, assertMovementEffect,
  assertMovementTransition, assertWithinContract, contractBalance, contractCoversCompetence,
  fixedItemsForCompetence, fixedItemsTotals, type FixedItem,
} from "../lib/contractor-registry.ts";

const item = (over: Partial<FixedItem> = {}): FixedItem => ({
  id: over.id ?? crypto.randomUUID(),
  direction: "credit",
  componentType: "ajuda_custo",
  description: "Ajuda de custo",
  amountCents: 50_000,
  effectiveFrom: "2026-01",
  effectiveTo: null,
  status: "active",
  ...over,
});

/* -------------------------------------------------------------------------- */
/* Contrato                                                                    */
/* -------------------------------------------------------------------------- */

test("prazo determinado exige término e valor global; indeterminado recusa valor global", () => {
  // Sem essas duas informações não existe saldo, e o acompanhamento que o
  // cadastro promete seria uma tela vazia.
  assert.throws(
    () => assertContractCoherent({ contractType: "determinado", contractStart: "2026-01-01", contractEnd: null, contractTotalCents: 120_000_00 }),
    (error: { code: string }) => error.code === "CONTRACT_END_REQUIRED",
  );
  assert.throws(
    () => assertContractCoherent({ contractType: "determinado", contractStart: "2026-01-01", contractEnd: "2026-12-31", contractTotalCents: null }),
    (error: { code: string }) => error.code === "CONTRACT_TOTAL_REQUIRED",
  );
  assert.throws(
    () => assertContractCoherent({ contractType: "determinado", contractStart: "2026-01-01", contractEnd: "2026-12-31", contractTotalCents: 0 }),
    (error: { code: string }) => error.code === "CONTRACT_TOTAL_REQUIRED",
  );
  // Valor global em contrato sem prazo não tem significado: nada o consome.
  assert.throws(
    () => assertContractCoherent({ contractType: "indeterminado", contractStart: "2026-01-01", contractEnd: null, contractTotalCents: 120_000_00 }),
    (error: { code: string }) => error.code === "CONTRACT_TOTAL_NOT_APPLICABLE",
  );
  assert.throws(
    () => assertContractCoherent({ contractType: "determinado", contractStart: "2026-06-01", contractEnd: "2026-01-31", contractTotalCents: 1000_00 }),
    (error: { code: string }) => error.code === "CONTRACT_WINDOW_INVALID",
  );

  assertContractCoherent({ contractType: "indeterminado", contractStart: "2026-01-01", contractEnd: null, contractTotalCents: null });
  assertContractCoherent({ contractType: "determinado", contractStart: "2026-01-01", contractEnd: "2026-12-31", contractTotalCents: 120_000_00 });
});

test("saldo do contrato é aritmética de centavos, e o indeterminado não finge ter teto", () => {
  const determinado = contractBalance({ contractType: "determinado", contractTotalCents: 120_000_00, consumedCents: 30_000_00 });
  assert.equal(determinado.remainingCents, 90_000_00);
  assert.equal(determinado.usagePercent, 25);
  assert.equal(determinado.exhausted, false);

  // Mostrar "R$ 0,00 restantes" para quem não tem teto seria mentira com cara
  // de número: o indeterminado devolve saldo aberto.
  const indeterminado = contractBalance({ contractType: "indeterminado", contractTotalCents: null, consumedCents: 30_000_00 });
  assert.equal(indeterminado.totalCents, null);
  assert.equal(indeterminado.remainingCents, null);
  assert.equal(indeterminado.usagePercent, null);
  assert.equal(indeterminado.exhausted, false);

  const esgotado = contractBalance({ contractType: "determinado", contractTotalCents: 10_000_00, consumedCents: 10_000_00 });
  assert.equal(esgotado.exhausted, true);
  assert.equal(esgotado.remainingCents, 0);
});

test("doze competências de contrato determinado fecham no centavo", () => {
  // 100.000,01 dividido em 12 não é redondo. Em reais com ponto flutuante o erro
  // só apareceria na última competência, quando não dá mais para corrigir.
  const totalCents = 100_000_01;
  const parcelaCents = Math.floor(totalCents / 12);
  const restoCents = totalCents - parcelaCents * 12;
  let consumedCents = 0;
  for (let mes = 0; mes < 12; mes += 1) {
    consumedCents += parcelaCents + (mes === 11 ? restoCents : 0);
  }
  const saldo = contractBalance({ contractType: "determinado", contractTotalCents: totalCents, consumedCents });
  assert.equal(saldo.remainingCents, 0, "a soma das doze competências precisa fechar exatamente no total");
  assert.equal(saldo.usagePercent, 100);
});

test("apuração que passa do contrato é recusada dizendo o quanto passa", () => {
  const saldo = contractBalance({ contractType: "determinado", contractTotalCents: 10_000_00, consumedCents: 9_000_00 });
  assert.throws(() => assertWithinContract(saldo, 1_500_00, "Ana Prestadora"), (error: {
    code: string; message: string; details?: { overflowCents?: number };
  }) => {
    assert.equal(error.code, "CONTRACT_BALANCE_EXCEEDED");
    assert.match(error.message, /Ana Prestadora/u);
    // Quem opera precisa saber o tamanho do estouro para decidir o que fazer.
    assert.match(error.message, /R\$\s?10\.000,00/u);
    return true;
  });
  // Exatamente no limite passa: o contrato comporta o último centavo.
  assertWithinContract(saldo, 1_000_00, "Ana Prestadora");
  // Sem teto, nada a verificar.
  assertWithinContract(contractBalance({ contractType: "indeterminado", contractTotalCents: null, consumedCents: 0 }), 999_999_00, "Bruno");
});

test("reduzir o valor do contrato abaixo do já consumido é recusado", () => {
  assert.throws(
    () => assertContractValueNotBelowConsumed(5_000_00, 9_000_00),
    (error: { code: string }) => error.code === "CONTRACT_TOTAL_BELOW_CONSUMED",
  );
  assertContractValueNotBelowConsumed(9_000_00, 9_000_00);
  assertContractValueNotBelowConsumed(null, 9_000_00);
});

test("vigência do contrato é comparada por mês, não por dia", () => {
  // Contrato que termina em 15/03 ainda gera a competência de março: a
  // competência fecha o mês inteiro, não o dia.
  assert.equal(contractCoversCompetence("2026-03", "2026-01-01", "2026-03-15"), true);
  assert.equal(contractCoversCompetence("2026-04", "2026-01-01", "2026-03-15"), false);
  // Contrato que começa em 20/01 já vale para janeiro, pelo mesmo motivo.
  assert.equal(contractCoversCompetence("2026-01", "2026-01-20", null), true);
  assert.equal(contractCoversCompetence("2025-12", "2026-01-20", null), false);
  assert.equal(contractCoversCompetence("2030-07", null, null), true);
});

test("o bloqueio de apuração explica em linguagem de quem opera", () => {
  assert.equal(apurationBlock("active", "2026-03", "2026-01-01", null), null);
  assert.equal(apurationBlock("suspended", "2026-03", "2026-01-01", null), "contrato suspenso");
  assert.equal(apurationBlock("inactive", "2026-03", "2026-01-01", null), "contrato encerrado");
  assert.equal(apurationBlock("active", "2026-04", "2026-01-01", "2026-03-15"), "competência fora da vigência do contrato");

  // Encerramento com data não apaga o passado: março e meses anteriores ainda
  // podem ser recalculados; abril em diante continua bloqueado.
  assert.equal(apurationBlock("inactive", "2026-02", "2026-01-01", "2026-03-15"), null);
  assert.equal(apurationBlock("inactive", "2026-03", "2026-01-01", "2026-03-15"), null);
  assert.equal(apurationBlock("inactive", "2026-04", "2026-01-01", "2026-03-15"), "contrato encerrado");
});

/* -------------------------------------------------------------------------- */
/* Valores fixos                                                               */
/* -------------------------------------------------------------------------- */

test("valor fixo entra e sai da competência pela vigência, sem relançamento manual", () => {
  const items = [
    item({ id: "a", effectiveFrom: "2026-01", effectiveTo: null }),
    item({ id: "b", effectiveFrom: "2026-03", effectiveTo: "2026-05" }),
    item({ id: "c", effectiveFrom: "2026-06", effectiveTo: null }),
    item({ id: "d", effectiveFrom: "2026-01", effectiveTo: null, status: "ended" }),
  ];
  const ids = (competence: string) => fixedItemsForCompetence(items, competence).map((row) => row.id).sort();

  assert.deepEqual(ids("2026-02"), ["a"]);
  assert.deepEqual(ids("2026-03"), ["a", "b"], "o item entra no mês em que começa a valer");
  assert.deepEqual(ids("2026-05"), ["a", "b"], "o item vale no último mês da vigência");
  // Aqui está o ponto do recurso: em junho o item "b" sai sozinho.
  assert.deepEqual(ids("2026-06"), ["a", "c"]);
  assert.equal(fixedItemsForCompetence(items, "2026-01").some((row) => row.id === "d"), false,
    "item encerrado não entra em competência nenhuma");
});

test("competência inválida é recusada em vez de devolver lista vazia", () => {
  // Devolver vazio para "2026-13" faria a competência inteira sair sem os fixos,
  // e o prestador receberia a menos sem ninguém ver erro.
  for (const invalid of ["2026-13", "2026-00", "202603", "2026-3", ""]) {
    assert.throws(() => fixedItemsForCompetence([], invalid), (error: { code: string }) => error.code === "INVALID_COMPETENCE");
  }
});

test("os totais dos fixos somam por direção, em centavos", () => {
  const totals = fixedItemsTotals([
    item({ direction: "credit", amountCents: 50_000 }),
    item({ direction: "credit", amountCents: 1 }),
    item({ direction: "debit", amountCents: 20_000 }),
  ]);
  assert.equal(totals.creditCents, 50_001);
  assert.equal(totals.debitCents, 20_000);
  assert.equal(totals.netCents, 30_001);
});

/* -------------------------------------------------------------------------- */
/* Movimentação                                                                */
/* -------------------------------------------------------------------------- */

test("movimentação aplicada é terminal e diz para lançar outra", () => {
  assertMovementTransition("draft", "pending_approval");
  assertMovementTransition("pending_approval", "approved");
  assertMovementTransition("approved", "applied");

  assert.throws(() => assertMovementTransition("applied", "draft"), (error: { code: string; message: string }) => {
    assert.equal(error.code, "MOVEMENT_APPLIED_LOCKED");
    assert.match(error.message, /nova movimentação/u);
    return true;
  });
  assert.throws(() => assertMovementTransition("draft", "applied"),
    (error: { code: string }) => error.code === "MOVEMENT_TRANSITION_INVALID");
  assert.throws(() => assertMovementTransition("canceled", "draft"),
    (error: { code: string }) => error.code === "MOVEMENT_TRANSITION_INVALID");
});

test("movimentação sem efeito não é aceita", () => {
  // Registro decorativo no histórico dá a entender que algo mudou sem nada ter
  // mudado — pior que não registrar.
  assert.throws(() => assertMovementEffect("base_change", {}),
    (error: { code: string }) => error.code === "MOVEMENT_EFFECT_REQUIRED");
  assert.throws(() => assertMovementEffect("contract_extension", {}),
    (error: { code: string }) => error.code === "MOVEMENT_EFFECT_REQUIRED");
  assert.throws(() => assertMovementEffect("suspension", { status: "active" }),
    (error: { code: string }) => error.code === "MOVEMENT_EFFECT_INVALID");
  assert.throws(() => assertMovementEffect("termination", { status: "suspended" }),
    (error: { code: string }) => error.code === "MOVEMENT_EFFECT_INVALID");
  assert.throws(() => assertMovementEffect("termination", { status: "inactive" }),
    (error: { code: string }) => error.code === "MOVEMENT_EFFECT_REQUIRED");
  assert.throws(() => assertMovementEffect("base_change", { baseAmountCents: -1 }),
    (error: { code: string }) => error.code === "NEGATIVE_MONEY");

  assertMovementEffect("base_change", { baseAmountCents: 800_000 });
  assertMovementEffect("suspension", { status: "suspended" });
  assertMovementEffect("termination", { status: "inactive", contractEnd: "2026-08-19" });
  assertMovementEffect("other", {});
});

/* -------------------------------------------------------------------------- */
/* Estrutura                                                                   */
/* -------------------------------------------------------------------------- */

test("as tabelas novas isolam por workspace e trancam movimentação aplicada", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0032_contractor_registry.sql", import.meta.url), "utf8");
  for (const table of ["fdp_contractor_fixed_items", "fdp_contractor_movements"]) {
    assert.ok(migration.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`), `${table} sem RLS`);
    assert.ok(migration.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`), `${table} sem FORCE RLS`);
  }
  // A regra do prazo determinado também vive no banco: a tela não é a última
  // linha de defesa de um dado que sustenta obrigação de pagamento.
  assert.match(migration, /fdp_contractor_profiles_determinado_check/u);
  assert.match(migration, /applied contractor movements are immutable/u);
  // Histórico não se apaga como atalho.
  assert.doesNotMatch(migration, /DROP TABLE/u);
});

test("migration da diferença fixa mantém o valor no perfil e no fechamento", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0049_contractors_fixed_caju_and_termination.sql", import.meta.url), "utf8");
  assert.match(migration, /fixed_caju_difference/u);
  assert.match(migration, /fixed_caju_amount/u);
  assert.doesNotMatch(migration, /DROP TABLE/u);
});

test("data vinda do banco é normalizada, venha como texto ou como Date", async () => {
  const { competenceOf } = await import("../lib/contractor-registry.ts");
  // O caminho HTTP do Neon devolve texto; o driver PostgreSQL direto devolve
  // `Date`. Assumir string quebrou a apuração no ensaio com
  // "date.slice is not a function" — a anotação de tipo não garante o que vem
  // de fora do processo.
  assert.equal(competenceOf("2026-03-15"), "2026-03");
  assert.equal(competenceOf(new Date("2026-03-15T00:00:00Z")), "2026-03");
  assert.equal(competenceOf(null), null);
  assert.equal(competenceOf(undefined), null);

  // E a vigência precisa funcionar com as duas formas.
  assert.equal(contractCoversCompetence("2026-03", new Date("2026-01-01T00:00:00Z"), new Date("2026-03-15T00:00:00Z")), true);
  assert.equal(contractCoversCompetence("2026-04", new Date("2026-01-01T00:00:00Z"), new Date("2026-03-15T00:00:00Z")), false);
  assert.equal(apurationBlock("active", "2026-04", null, new Date("2026-03-15T00:00:00Z")),
    "competência fora da vigência do contrato");
});

/* -------------------------------------------------------------------------- */
/* Rotas                                                                       */
/* -------------------------------------------------------------------------- */

test("cadastrar e editar PJ exige capacidade, acesso à empresa e não vaza documento", async () => {
  for (const file of ["../app/api/registrations/contractors/route.ts", "../app/api/registrations/contractors/[id]/route.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /requireCapability\(workspace, "contractors\.(read|manage)"\)/u, `${file} sem capacidade`);
    assert.match(source, /requireCompanyAccess\(/u, `${file} sem escopo de empresa`);
    // Identidade e contrato nascem e mudam juntos.
    if (file.endsWith("contractors/route.ts")) assert.match(source, /await d1\.batch\(\[/u);
  }
  const list = await readFile(new URL("../app/api/registrations/contractors/route.ts", import.meta.url), "utf8");
  // A lista identifica sem repetir o documento inteiro na tela.
  assert.match(list, /taxIdLast4/u);
  assert.doesNotMatch(list, /taxId: row\.tax_id/u);
  const detail = await readFile(new URL("../app/api/registrations/contractors/[id]/route.ts", import.meta.url), "utf8");
  assert.match(detail, /taxIdMasked/u);
  assert.match(detail, /dateFromDatabase/u, "datas do PostgreSQL precisam chegar canônicas ao formulário");
  assert.match(detail, /currentIdentity[\s\S]+taxId/u, "documento mascarado em branco não pode apagar o cadastro");
  assert.match(detail, /upsertContractorClosing/u, "salvar a data do contrato precisa reapurar fechamento aberto");
  assert.match(detail, /status NOT IN \('closed', 'paid'\)/u);
  const form = await readFile(new URL("../app/painel/features/registrations/ContractorsPanel.tsx", import.meta.url), "utf8");
  assert.match(form, /inputDate\(current\?\.contractStart\)/u);
  assert.match(form, /name="contractSignedAt"/u);
});

test("aplicar movimentação altera contrato e histórico na mesma transação", async () => {
  const source = await readFile(new URL("../app/api/registrations/contractors/[id]/movements/[movementId]/route.ts", import.meta.url), "utf8");
  assert.match(source, /assertMovementTransition\(/u);
  // Separar as duas escritas abriria espaço para contrato alterado sem
  // histórico — o problema que a movimentação existe para resolver.
  const update = source.indexOf("UPDATE fdp_contractor_profiles");
  const movement = source.indexOf("UPDATE fdp_contractor_movements");
  const batch = source.indexOf("await d1.batch(statements)");
  assert.ok(update > 0 && movement > update && batch > movement,
    "contrato e movimentação precisam ir no mesmo batch");
  // O contrato resultante continua tendo que ser coerente.
  assert.match(source, /assertContractCoherent\(/u);
  assert.match(source, /assertContractValueNotBelowConsumed\(/u);
});

test("a apuração recusa prestador fora de vigência e materializa os fixos antes de calcular", async () => {
  const source = await readFile(new URL("../lib/payment-service.ts", import.meta.url), "utf8");
  const upsert = source.slice(source.indexOf("export async function upsertContractorClosing"));
  const blocked = upsert.indexOf("apurationBlock(");
  const materialize = upsert.indexOf("materializeFixedItems(");
  const compute = upsert.indexOf("computeContractorClosing(");
  const guard = upsert.indexOf("assertWithinContract(");
  assert.ok(blocked > 0 && materialize > blocked, "o bloqueio de vigência vem antes de materializar");
  assert.ok(compute > materialize, "os fixos entram antes do cálculo");
  assert.ok(guard > compute, "o teto do contrato é conferido sobre o valor já calculado");

  // O valor fixo vira componente; não existe um segundo caminho de soma que
  // pudesse divergir do arquivo gerado.
  assert.match(source, /INSERT INTO fdp_contractor_components/u);
  assert.match(source, /'fixed_item'/u);
  // Item fora de vigência é cancelado com motivo, não apagado.
  assert.match(source, /status = 'canceled', canceled_reason = 'valor fixo fora da vigência desta competência'/u);
  assert.doesNotMatch(upsert, /DELETE FROM fdp_contractor_components/u);
});

test("o tipo do valor fixo é o mesmo do componente da competência", async () => {
  const input = await readFile(new URL("../lib/contractor-input.ts", import.meta.url), "utf8");
  // Texto livre aqui deixava o cadastro passar e a apuração quebrar contra a
  // constraint da outra tabela — aconteceu no ensaio.
  assert.match(input, /contractorCreditTypes, contractorDebitTypes/u);
  assert.match(input, /componentDirectionFor\(componentType/u);
  const migration = await readFile(new URL("../drizzle/postgres/0032_contractor_registry.sql", import.meta.url), "utf8");
  assert.match(migration, /fdp_contractor_fixed_items_type_check/u);
});
