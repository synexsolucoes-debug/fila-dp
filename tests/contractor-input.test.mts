import assert from "node:assert/strict";
import test from "node:test";

import { readContractorInput, readFixedItemInput, readMovementInput } from "../lib/contractor-input.ts";
import { dateFromDatabase } from "../lib/registrations.ts";

const contractor = (money: {
  baseAmount: string | number;
  invoiceLimitOverride: string | number;
  fixedCajuDifference?: string | number;
}) => readContractorInput({
    legalName: "Prestadora Exemplo Ltda.",
    companyId: "company-1",
    contractType: "indeterminado",
    contractStart: "2026-08-01",
    baseAmount: money.baseAmount,
    fixedCajuDifference: money.fixedCajuDifference,
    invoiceLimitOverride: money.invoiceLimitOverride,
    complementMethod: "none",
    status: "active",
  }, { requireCompany: true });

test("cadastro PJ interpreta moeda brasileira sem acrescentar zeros", () => {
  const input = contractor({ baseAmount: "9.000,00", invoiceLimitOverride: "6.000,00" });
  assert.equal(input.baseAmountCents, 900_000);
  assert.equal(input.invoiceLimitCents, 600_000);
});

test("edição PJ aceita o ponto decimal devolvido pelo próprio formulário", () => {
  const input = contractor({ baseAmount: "9000.00", invoiceLimitOverride: "6000.00" });
  assert.equal(input.baseAmountCents, 900_000);
  assert.equal(input.invoiceLimitCents, 600_000);
});

test("moeda com agrupamento internacional também mantém o valor", () => {
  const input = contractor({ baseAmount: "9,000.00", invoiceLimitOverride: "6,000.00" });
  assert.equal(input.baseAmountCents, 900_000);
  assert.equal(input.invoiceLimitCents, 600_000);
});

test("cadastro PJ aceita diferença fixa paga no Caju e recusa valor negativo", () => {
  const input = contractor({ baseAmount: "9000.00", invoiceLimitOverride: "6000.00", fixedCajuDifference: "750,50" });
  assert.equal(input.fixedCajuDifferenceCents, 75_050);
  assert.throws(
    () => contractor({ baseAmount: "9000.00", invoiceLimitOverride: "6000.00", fixedCajuDifference: "-0,01" }),
    (error: { code?: string }) => error.code === "NEGATIVE_MONEY",
  );
});

test("datas vindas do PostgreSQL viram valores canônicos para o input date", () => {
  assert.equal(dateFromDatabase("2026-08-01"), "2026-08-01");
  assert.equal(dateFromDatabase("2026-08-01T00:00:00.000Z"), "2026-08-01");
  assert.equal(dateFromDatabase(new Date("2026-08-01T03:00:00.000Z")), "2026-08-01");
  assert.equal(dateFromDatabase(null), null);
  assert.throws(() => dateFromDatabase("2026-02-31"), (error: { code?: string }) => error.code === "INVALID_DATE");
});

test("encerramento PJ usa a data da movimentação como término e exige motivo", () => {
  const movement = readMovementInput({
    movementType: "termination",
    effectiveDate: "2026-08-19",
    title: "Encerramento do contrato PJ",
    reason: "Fim da prestação de serviços",
    effect: {},
  });
  assert.equal(movement.effect.status, "inactive");
  assert.equal(movement.effect.contractEnd, "2026-08-19");
  assert.throws(
    () => readMovementInput({ movementType: "termination", effectiveDate: "2026-08-19", title: "Encerramento", reason: "", effect: {} }),
    (error: { code?: string }) => error.code === "TERMINATION_REASON_REQUIRED",
  );
});

test("lançamento fixo aceita vigência sem término ou com término determinado", () => {
  const common = {
    componentType: "health_plan",
    description: "Plano de saúde mensal",
    amount: "350.00",
    effectiveFrom: "2026-01",
  };
  const indefinite = readFixedItemInput({ ...common, effectiveTo: null });
  assert.equal(indefinite.direction, "debit");
  assert.equal(indefinite.amountCents, 35_000);
  assert.equal(indefinite.effectiveTo, null);

  const determined = readFixedItemInput({ ...common, effectiveTo: "2026-12" });
  assert.equal(determined.effectiveTo, "2026-12");
  assert.throws(
    () => readFixedItemInput({ ...common, effectiveTo: "2025-12" }),
    (error: { code?: string }) => error.code === "FIXED_ITEM_WINDOW_INVALID",
  );
});
