import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertExportable, buildCajuPreview, cajuFileName, isValidTaxId, type CajuCandidate,
} from "../lib/caju-export.ts";
import { calculateContractorClosing } from "../lib/payments.ts";

function candidate(partial: Partial<CajuCandidate> & { contractorId: string }): CajuCandidate {
  return {
    contractorId: partial.contractorId,
    contractorName: partial.contractorName ?? `Prestador ${partial.contractorId}`,
    taxId: partial.taxId ?? "52998224725",
    companyId: partial.companyId ?? "empresa-1",
    competenceId: partial.competenceId ?? "2026-08",
    closingStatus: partial.closingStatus ?? "approved",
    cajuAmountCents: partial.cajuAmountCents ?? 50000,
    complementMethod: partial.complementMethod ?? "caju_saldo_livre",
  };
}

test("o cálculo PJ mantém a ordem líquido → nota → Caju, em centavos", () => {
  // Abaixo do teto: nota igual ao líquido, Caju zero.
  const abaixo = calculateContractorClosing({
    baseAmount: 4500, components: [], complementMethod: "caju_saldo_livre",
    invoiceLimit: { amount: 6000, source: "workspace", policyId: null },
  });
  assert.equal(abaixo.invoiceExpectedAmount, 4500);
  assert.equal(abaixo.cajuAmount, 0);

  // Acima do teto: nota limitada, só a diferença vai para a Caju.
  const acima = calculateContractorClosing({
    baseAmount: 8000, components: [], complementMethod: "caju_saldo_livre",
    invoiceLimit: { amount: 6000, source: "workspace", policyId: null },
  });
  assert.equal(acima.invoiceExpectedAmount, 6000);
  assert.equal(acima.cajuAmount, 2000);

  // Descontos entram ANTES do teto: inverter a ordem produziria nota errada.
  const comDesconto = calculateContractorClosing({
    baseAmount: 8000,
    components: [{ type: "health_plan", direction: "debit", amount: 1500 }],
    complementMethod: "caju_saldo_livre",
    invoiceLimit: { amount: 6000, source: "workspace", policyId: null },
  });
  assert.equal(comDesconto.netAmount, 6500);
  assert.equal(comDesconto.invoiceExpectedAmount, 6000);
  assert.equal(comDesconto.cajuAmount, 500);

  // Líquido negativo não vira Caju negativa.
  const negativo = calculateContractorClosing({
    baseAmount: 1000,
    components: [{ type: "health_plan", direction: "debit", amount: 3000 }],
    complementMethod: "caju_saldo_livre",
    invoiceLimit: { amount: 6000, source: "workspace", policyId: null },
  });
  assert.equal(negativo.netAmount, 0);
  assert.equal(negativo.cajuAmount, 0);
  assert.equal(negativo.negativeNet, true);
});

test("o teto da nota não é fixo em código: vem da política configurada", async () => {
  const source = await readFile(new URL("../lib/payments.ts", import.meta.url), "utf8");
  // 6000 é exemplo da especificação, não constante do produto.
  assert.doesNotMatch(source, /=\s*6000\b/u, "o limite da nota não pode estar chumbado");
  assert.match(source, /resolveInvoiceLimit|limitPrecedence/u);
  const semLimite = calculateContractorClosing({
    baseAmount: 9000, components: [], complementMethod: "caju_saldo_livre",
    invoiceLimit: { amount: null, source: "none", policyId: null },
  });
  // Sem política, tudo vai para a nota e nada para a Caju.
  assert.equal(semLimite.invoiceExpectedAmount, 9000);
  assert.equal(semLimite.cajuAmount, 0);
});

test("sem modelo oficial da Caju a exportação é bloqueada com orientação", () => {
  const preview = buildCajuPreview([candidate({ contractorId: "a" })], null);
  assert.equal(preview.canExport, false);
  assert.throws(() => assertExportable(preview, null), (error: { code: string; message: string }) => {
    assert.equal(error.code, "CAJU_TEMPLATE_MISSING");
    // A mensagem precisa dizer onde configurar, não só que faltou.
    assert.match(error.message, /portal da Caju/u);
    assert.match(error.message, /Modelos de importação/u);
    return true;
  });
});

test("prestador com Caju zero é excluído, não bloqueia o arquivo", () => {
  const preview = buildCajuPreview([
    candidate({ contractorId: "a", cajuAmountCents: 0 }),
    candidate({ contractorId: "b", cajuAmountCents: 25000, taxId: "11144477735" }),
  ], 3);
  assert.equal(preview.skippedZero, 1);
  assert.equal(preview.eligible.length, 1);
  assert.equal(preview.totalCents, 25000);
  assert.equal(preview.canExport, true);
});

test("CPF inválido, cálculo não aprovado e duplicidade nunca passam em silêncio", () => {
  const preview = buildCajuPreview([
    candidate({ contractorId: "sem-cpf", taxId: "" }),
    candidate({ contractorId: "cpf-falso", taxId: "11111111111" }),
    candidate({ contractorId: "aberto", closingStatus: "open", taxId: "11144477735" }),
    candidate({ contractorId: "dup-1", taxId: "52998224725" }),
    candidate({ contractorId: "dup-2", taxId: "529.982.247-25" }),
  ], 3);
  const reasons = preview.blocked.map((item) => item.reason).sort();
  assert.deepEqual(reasons, ["duplicated_tax_id", "invalid_tax_id", "invalid_tax_id", "not_approved"]);
  assert.equal(preview.canExport, false, "erro pendente precisa bloquear a exportação");
  assert.throws(() => assertExportable(preview, 3), (error: { code: string }) => {
    assert.equal(error.code, "CAJU_EXPORT_INVALID");
    return true;
  });
});

test("o mesmo CPF em empresas diferentes não é duplicidade", () => {
  const preview = buildCajuPreview([
    candidate({ contractorId: "a", companyId: "empresa-1" }),
    candidate({ contractorId: "b", companyId: "empresa-2" }),
  ], 1);
  assert.equal(preview.eligible.length, 2);
  assert.equal(preview.blocked.length, 0);
});

test("o total da prévia é a soma exata do que vai no arquivo", () => {
  const preview = buildCajuPreview([
    candidate({ contractorId: "a", cajuAmountCents: 133, taxId: "52998224725" }),
    candidate({ contractorId: "b", cajuAmountCents: 267, taxId: "11144477735" }),
  ], 1);
  // Centavos somados como inteiro: nada de erro de ponto flutuante.
  assert.equal(preview.totalCents, 400);
  assert.equal(preview.eligible.reduce((total, item) => total + item.cajuAmountCents, 0), preview.totalCents);
});

test("nenhum elegível não gera arquivo vazio", () => {
  const preview = buildCajuPreview([candidate({ contractorId: "a", cajuAmountCents: 0 })], 1);
  assert.throws(() => assertExportable(preview, 1), (error: { code: string }) => {
    assert.equal(error.code, "CAJU_EXPORT_EMPTY");
    return true;
  });
});

test("validação de CPF recusa sequência e dígito verificador errado", () => {
  assert.equal(isValidTaxId("529.982.247-25"), true);
  assert.equal(isValidTaxId("52998224726"), false);
  assert.equal(isValidTaxId("00000000000"), false);
  assert.equal(isValidTaxId("123"), false);
  assert.equal(isValidTaxId(""), false);
});

test("o nome do arquivo é previsível e não depende de texto livre do usuário", () => {
  const name = cajuFileName("Synex Soluções Ltda", "2026-08", new Date("2026-08-10T12:00:00Z"));
  assert.equal(name, "caju_saldo_livre_synex-solucoes-ltda_2026-08_2026-08-10.xlsx");
  // Nada de caminho, barra ou caractere que escape do diretório.
  assert.doesNotMatch(cajuFileName("../../etc/passwd", "2026-08"), /\.\.|\//u);
});

test("o catálogo de modelos guarda o arquivo oficial, versionado e isolado", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0026_caju_templates.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "fdp_caju_templates"/u);
  // Um ativo por workspace: a exportação não pode escolher entre dois modelos.
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "fdp_caju_templates_active_uq"[\s\S]*WHERE "status" = 'active'/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /column_map_json/u, "o mapeamento entre campos internos e colunas oficiais é guardado");
  // O produto não embute modelo: ele guarda o que o administrador subir.
  assert.match(migration, /checksum/u);
});

test("exportar para a Caju exige capacidade própria, negada por padrão", async () => {
  const { capabilitiesForRole } = await import("../lib/authorization.ts");
  assert.ok(capabilitiesForRole("admin").includes("contractors.export_caju"));
  for (const role of ["member", "observer", "guest"] as const) {
    assert.ok(!capabilitiesForRole(role).includes("contractors.export_caju"),
      `${role} não pode exportar dinheiro para meio de pagamento externo`);
  }
});
