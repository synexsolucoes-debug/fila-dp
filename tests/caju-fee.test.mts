import assert from "node:assert/strict";
import test from "node:test";
import { cajuFeeCents, cajuNetCents } from "../lib/caju-fee.ts";
import { buildCajuNetSheet, formatDocument } from "../lib/caju-net-sheet.ts";

test("a taxa de 1,99% sai em centavos inteiros", () => {
  assert.equal(cajuFeeCents(100000), 1990);
  assert.equal(cajuNetCents(100000), 98010);
  assert.equal(cajuNetCents(0), 0);
});

test("a planilha traz nome, documento e líquido", async () => {
  assert.equal(formatDocument("52998224725"), "529.982.247-25");
  const { totals } = await buildCajuNetSheet([{ name: "Ana", taxId: "52998224725", amountCents: 100000, status: "approved" }], { applyFee: true });
  assert.deepEqual(totals, { amount: 100000, fee: 1990, net: 98010 });
});
