import assert from "node:assert/strict";
import test from "node:test";

import { readContractorInput, readFixedItemInput } from "../lib/contractor-input.ts";
import { dateFromDatabase } from "../lib/registrations.ts";

const contractor = (money: { baseAmount: string | number; invoiceLimitOverride: string | number }) =>
  readContractorInput({
    legalName: "Prestadora Exemplo Ltda.",
    companyId: "company-1",
    contractType: "indeterminado",
    contractStart: "2026-08-01",
    baseAmount: money.baseAmount,
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

test("datas vindas do PostgreSQL viram valores canônicos para o input date", () => {
  assert.equal(dateFromDatabase("2026-08-01"), "2026-08-01");
  assert.equal(dateFromDatabase("2026-08-01T00:00:00.000Z"), "2026-08-01");
  assert.equal(dateFromDatabase(new Date("2026-08-01T03:00:00.000Z")), "2026-08-01");
  assert.equal(dateFromDatabase(null), null);
  assert.throws(() => dateFromDatabase("2026-02-31"), (error: { code?: string }) => error.code === "INVALID_DATE");
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
