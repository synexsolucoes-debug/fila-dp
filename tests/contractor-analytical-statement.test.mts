import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const statement = await readFile(
  new URL(
    "../app/painel/features/payments/ContractorAnalyticalStatement.tsx",
    import.meta.url,
  ),
  "utf8",
);

const detail = await readFile(
  new URL(
    "../app/painel/features/payments/ContractorPaymentDetail.tsx",
    import.meta.url,
  ),
  "utf8",
);

const types = await readFile(
  new URL(
    "../app/painel/features/payments/payments.types.ts",
    import.meta.url,
  ),
  "utf8",
);

const api = await readFile(
  new URL(
    "../app/painel/features/payments/payments.api.ts",
    import.meta.url,
  ),
  "utf8",
);

test("extrato PJ apresenta valores essenciais da conferencia", () => {
  assert.match(statement, /Total de proventos/u);
  assert.match(statement, /Total de descontos/u);
  assert.match(statement, /Líquido devido/u);
  assert.match(statement, /Complemento Caju/u);
  assert.match(statement, /Valor em Nota Fiscal/u);
  assert.match(statement, /Valor da NF recebida/u);
  assert.match(statement, /Diferença da NF/u);
  assert.match(statement, /Número da NF/u);
  assert.match(statement, /Status da conferência/u);
});

test("extrato mostra somente complemento referente ao Caju", () => {
  assert.match(statement, /Complemento Caju/u);

  assert.doesNotMatch(statement, /Caju previsto/iu);
  assert.doesNotMatch(statement, /Caju realizado/iu);
  assert.doesNotMatch(statement, /Diferença Caju/iu);
});

test("proventos e descontos continuam analiticos", () => {
  assert.match(detail, /Proventos/u);
  assert.match(detail, /Descontos/u);
  assert.match(detail, /Valor contratual/u);
  assert.match(
    detail,
    /<ContractorAnalyticalStatement detail=\{detail\} \/>/u,
  );
});

test("CNPJ do PJ chega ao extrato", () => {
  assert.match(types, /taxId:\s*string/u);

  assert.match(
    api,
    /taxId:\s*text\(pick\(provider,\s*"taxId",\s*"tax_id"\)\)/u,
  );

  assert.match(statement, /formatCnpj\(detail\.provider\.taxId\)/u);
});

test("extrato pode ser exportado para CSV", () => {
  assert.match(statement, /Exportar extrato CSV/u);
  assert.match(statement, /text\/csv/u);
  assert.match(statement, /URL\.createObjectURL/u);
  assert.match(statement, /extrato-pj-/u);
});