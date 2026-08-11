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
    components: [{ componentType: "health_plan", direction: "debit", amount: 1500 }],
    complementMethod: "caju_saldo_livre",
    invoiceLimit: { amount: 6000, source: "workspace", policyId: null },
  });
  assert.equal(comDesconto.netAmount, 6500);
  assert.equal(comDesconto.invoiceExpectedAmount, 6000);
  assert.equal(comDesconto.cajuAmount, 500);

  // Líquido negativo não vira Caju negativa.
  const negativo = calculateContractorClosing({
    baseAmount: 1000,
    components: [{ componentType: "health_plan", direction: "debit", amount: 3000 }],
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
  const name = cajuFileName("Synex Soluções Ltda", "2026-08", "csv", new Date("2026-08-10T12:00:00Z"));
  // O modelo oficial é planilha de texto separada por ";", não XLSX.
  assert.equal(name, "caju_saldo_livre_synex-solucoes-ltda_2026-08_2026-08-10.csv");
  // Nada de caminho, barra ou caractere que escape do diretório.
  assert.doesNotMatch(cajuFileName("../../etc/passwd", "2026-08"), /\.\.|\//u);
  // Extensão também não aceita texto livre.
  assert.doesNotMatch(cajuFileName("empresa", "2026-08", "../sh"), /\.\.|\//u);
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

/* -------------------------------------------------------------------------- */
/* Modelo oficial da Caju — arquivo real fornecido pelo cliente                */
/* -------------------------------------------------------------------------- */

const templateFixture = () => readFile(new URL("./fixtures/caju-pedidos-exemplo.csv", import.meta.url), "utf8");

test("o modelo oficial é lido do arquivo, sem nome de coluna chumbado no código", async () => {
  const { parseCajuTemplate } = await import("../lib/caju-template.ts");
  const shape = parseCajuTemplate(await templateFixture());

  // Cabeçalhos exatamente como vieram, na ordem original.
  assert.deepEqual(shape.headers, ["CPF", "Matricula (opcional)", "Valor Fixo em Auxilio Alimentacao"]);
  assert.equal(shape.delimiter, ";");
  assert.equal(shape.taxIdIndex, 0);
  assert.equal(shape.amountIndex, 2);
  // A matrícula é opcional e sai vazia, como no exemplo oficial.
  assert.deepEqual(shape.emptyIndexes, [1]);

  const source = await readFile(new URL("../lib/caju-template.ts", import.meta.url), "utf8");
  // Nenhum rótulo da Caju escrito na lógica: eles mudam sem aviso. Comentário
  // citando o modelo real é o oposto do problema — é o que documenta por que a
  // detecção precisa ser flexível —, então a checagem olha só o código.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /"Valor Fixo em|"Matricula \(opcional\)"|"Saldo"/u);
});

test("o modelo declara sua categoria — exportar Saldo Livre com modelo de alimentação credita errado", async () => {
  const { parseCajuTemplate, templateCategory } = await import("../lib/caju-template.ts");
  const shape = parseCajuTemplate(await templateFixture());
  // O arquivo de exemplo recebido é de Auxílio Alimentação, não de Saldo Livre.
  assert.equal(templateCategory(shape).key, "alimentacao");

  const saldoLivre = parseCajuTemplate("CPF;Matricula (opcional);Valor Fixo em Saldo Livre\n12345678901;;0");
  assert.equal(templateCategory(saldoLivre).key, "saldo_livre");
  assert.equal(saldoLivre.amountIndex, 2);
});

test("o arquivo gerado repete cabeçalho, ordem e delimitador do modelo", async () => {
  const { buildCajuFile, parseCajuTemplate } = await import("../lib/caju-template.ts");
  const shape = parseCajuTemplate(await templateFixture());
  const file = buildCajuFile(shape, [
    { taxId: "529.982.247-25", amountCents: 123456 },
    { taxId: "01234567890", amountCents: 50 },
  ]);
  const lines = file.split("\n");

  assert.equal(lines[0], "CPF;Matricula (opcional);Valor Fixo em Auxilio Alimentacao");
  // CPF só com dígitos; valor decimal com duas casas, sem R$ e sem milhar.
  assert.equal(lines[1], "529982247251;;1234.56".replace("529982247251", "52998224725"));
  // Zero à esquerda preservado: perder o primeiro dígito troca a pessoa.
  assert.equal(lines[2], "01234567890;;0.50");
  assert.equal(lines.length, 3, "sem linha em branco no fim");
  // Nenhuma coluna extra de auditoria dentro do arquivo de importação.
  for (const line of lines) assert.equal(line.split(";").length, 3);
});

test("valor é formatado a partir de centavos inteiros, sem ponto flutuante", async () => {
  const { formatAmount } = await import("../lib/caju-template.ts");
  assert.equal(formatAmount(0), "0.00");
  assert.equal(formatAmount(5), "0.05");
  assert.equal(formatAmount(199), "1.99");
  assert.equal(formatAmount(100000), "1000.00");
  // 0.1 + 0.2 em ponto flutuante daria 0.30000000000000004; em centavos, não.
  assert.equal(formatAmount(10 + 20), "0.30");
  assert.throws(() => formatAmount(12.5), (error: { code: string }) => error.code === "CAJU_AMOUNT_INVALID");
});

test("modelo editado ou de outra planilha é recusado com motivo", async () => {
  const { parseCajuTemplate } = await import("../lib/caju-template.ts");
  const cases: Array<[string, string]> = [
    ["", "CAJU_TEMPLATE_EMPTY"],
    ["planilha sem colunas", "CAJU_TEMPLATE_INVALID"],
    ["CPF;;Valor", "CAJU_TEMPLATE_INVALID"],
    ["Nome;Matricula;Valor Fixo em Saldo Livre", "CAJU_TEMPLATE_NO_TAX_ID"],
    ["CPF;Matricula;Observacao", "CAJU_TEMPLATE_NO_AMOUNT"],
  ];
  for (const [content, code] of cases) {
    assert.throws(() => parseCajuTemplate(content), (error: { code: string }) => {
      assert.equal(error.code, code, `"${content.slice(0, 30)}" deveria recusar com ${code}`);
      return true;
    });
  }
});

test("a linha de exemplo do modelo nunca vira pedido real", async () => {
  const { buildCajuFile, parseCajuTemplate } = await import("../lib/caju-template.ts");
  const shape = parseCajuTemplate(await templateFixture());
  // O modelo traz 12345678901 como exemplo; o arquivo gerado só contém quem foi
  // passado explicitamente.
  const file = buildCajuFile(shape, [{ taxId: "52998224725", amountCents: 100 }]);
  assert.doesNotMatch(file, /12345678901/u);
  assert.equal(file.split("\n").length, 2);
});

/* -------------------------------------------------------------------------- */
/* Modelo de Premiação (Saldo Livre) — segundo arquivo real do cliente         */
/* -------------------------------------------------------------------------- */

const premiacaoFixture = () => readFile(new URL("./fixtures/caju-pedidos-premiacao.csv", import.meta.url), "utf8");

test("o modelo de Saldo Livre não diz 'valor' em lugar nenhum, e ainda assim é lido", async () => {
  const { parseCajuTemplate, templateCategory } = await import("../lib/caju-template.ts");
  // Este arquivo derrubou a primeira versão do parser: eu tinha generalizado de
  // uma amostra só e assumido que a coluna de crédito sempre diz "Valor". O
  // modelo oficial de Premiação chama a coluna apenas de "Saldo".
  const shape = parseCajuTemplate(await premiacaoFixture());

  assert.deepEqual(shape.headers, ["CPF", "Saldo"]);
  assert.equal(shape.taxIdIndex, 0);
  assert.equal(shape.amountIndex, 1);
  assert.deepEqual(shape.emptyIndexes, []);
  assert.equal(templateCategory(shape).key, "saldo_livre");
});

test("o arquivo de Saldo Livre sai com as duas colunas do modelo, sem sobra", async () => {
  const { buildCajuFile, parseCajuTemplate } = await import("../lib/caju-template.ts");
  const shape = parseCajuTemplate(await premiacaoFixture());
  const file = buildCajuFile(shape, [
    { taxId: "529.982.247-25", amountCents: 123456 },
    { taxId: "01234567890", amountCents: 5 },
  ]);
  const lines = file.split("\n");

  assert.equal(lines[0], "CPF;Saldo");
  assert.equal(lines[1], "52998224725;1234.56");
  // Zero à esquerda preservado também aqui: perder o dígito troca a pessoa.
  assert.equal(lines[2], "01234567890;0.05");
  assert.equal(lines.length, 3, "sem linha em branco no fim");
  for (const line of lines) assert.equal(line.split(";").length, 2);
  // A linha de exemplo do modelo não vaza para o pedido real.
  assert.doesNotMatch(file, /12345678910/u);
});

test("a linha de exemplo do modelo confirma a coluna de crédito quando o rótulo não basta", async () => {
  const { parseCajuTemplate } = await import("../lib/caju-template.ts");
  // Sem vocabulário reconhecível no cabeçalho, o exemplo oficial resolve: a
  // coluna que traz número e não é CPF é a de crédito.
  const shape = parseCajuTemplate("CPF;Referencia;Montante\n12345678901;abc;10");
  assert.equal(shape.amountIndex, 2);
});

test("cabeçalho e exemplo em desacordo recusam em vez de escolher um dos dois", async () => {
  const { parseCajuTemplate } = await import("../lib/caju-template.ts");
  // O rótulo aponta a coluna 1, o exemplo preenche a 2. Escolher qualquer uma
  // credita dinheiro no campo errado — recusar é a única saída honesta.
  assert.throws(
    () => parseCajuTemplate("CPF;Valor;Outra\n12345678901;;10"),
    (error: { code: string }) => error.code === "CAJU_TEMPLATE_AMBIGUOUS",
  );
  // Duas colunas de crédito no mesmo modelo: idem.
  assert.throws(
    () => parseCajuTemplate("CPF;Valor Fixo em Saldo Livre;Saldo"),
    (error: { code: string }) => error.code === "CAJU_TEMPLATE_AMBIGUOUS",
  );
});

test("a recusa por coluna não identificada diz quais colunas encontrou", async () => {
  const { parseCajuTemplate } = await import("../lib/caju-template.ts");
  assert.throws(() => parseCajuTemplate("CPF;Observacao;Setor"), (error: { code: string; message: string }) => {
    assert.equal(error.code, "CAJU_TEMPLATE_NO_AMOUNT");
    // Sem isso o administrador não descobre que baixou a planilha errada.
    assert.match(error.message, /Observacao/u);
    assert.match(error.message, /CPF \(CPF\)/u);
    return true;
  });
});

/* -------------------------------------------------------------------------- */
/* Rotas: cadastro do modelo e geração do arquivo                             */
/* -------------------------------------------------------------------------- */

test("cadastrar modelo exige capacidade própria e interpreta antes de gravar", async () => {
  const source = await readFile(new URL("../app/api/payments/caju/templates/route.ts", import.meta.url), "utf8");
  assert.match(source, /requireCapability\(workspace\.role, "contractors\.export_caju"\)/u);
  // Interpretar antes de persistir: modelo ilegível não entra no catálogo nem
  // como rascunho.
  const parseAt = source.indexOf("parseCajuTemplate(content)");
  const writeAt = source.indexOf("INSERT INTO fdp_caju_templates");
  assert.ok(parseAt > 0 && writeAt > parseAt, "o modelo precisa ser interpretado antes de gravar");
  // Trocar o ativo é uma operação só: o índice parcial recusaria dois ativos.
  assert.match(source, /d1\.batch\(\[/u);
  assert.match(source, /status = 'retired'[\s\S]*?INSERT INTO fdp_caju_templates/u);
  // Versão anterior é aposentada, nunca apagada.
  assert.doesNotMatch(source, /DELETE FROM fdp_caju_templates/u);
});

test("gerar o arquivo exige competência acessível e recusa antes de escrever linha", async () => {
  const source = await readFile(new URL("../app/api/payments/caju/export/route.ts", import.meta.url), "utf8");
  assert.match(source, /requireCapability\(workspace\.role, "contractors\.export_caju"\)/u);
  assert.match(source, /requireCompanyAccess\(/u);
  // A recusa vem antes da escrita: com bloqueio pendente não existe arquivo parcial.
  const assertAt = source.indexOf("assertExportable(preview");
  const buildAt = source.indexOf("buildCajuFile(shape");
  assert.ok(assertAt > 0 && buildAt > assertAt, "a conferência precisa vir antes da geração");
});

test("a trilha registra a exportação sem guardar CPF nem o conteúdo do arquivo", async () => {
  const source = await readFile(new URL("../app/api/payments/caju/export/route.ts", import.meta.url), "utf8");
  const audit = source.slice(source.indexOf("await prepareAuditEvent({"), source.indexOf("return new Response"));
  // O que fica é o que permite conferir depois: linhas, total e versão do modelo.
  assert.match(audit, /rows: preview\.eligible\.length/u);
  assert.match(audit, /totalCents: preview\.totalCents/u);
  assert.match(audit, /templateVersion: template\.version/u);
  // O que não pode ficar: o conteúdo gerado e os CPFs dentro dele.
  assert.doesNotMatch(audit, /\bcontent\b/u);
  assert.doesNotMatch(audit, /taxId/u);
});

test("decimal do banco e valor digitado usam conversores diferentes", async () => {
  const { centsFromDatabase, toCents } = await import("../lib/payments.ts");
  // O `numeric` do PostgreSQL volta como "3000.00". `toCents` interpreta entrada
  // em pt-BR e trata o ponto como separador de milhar — usá-la aqui multiplicava
  // todo valor por 100. O ensaio no navegador mostrou R$ 300.000,00 no lugar de
  // R$ 3.000,00 antes desta separação.
  assert.equal(centsFromDatabase("3000.00"), 300000);
  assert.equal(centsFromDatabase("0.05"), 5);
  assert.equal(centsFromDatabase("1234.56"), 123456);
  assert.equal(toCents("1.234,56"), 123456, "entrada digitada continua em pt-BR");
  assert.notEqual(centsFromDatabase("3000.00"), toCents("3000.00"));

  const route = await readFile(new URL("../app/api/payments/caju/export/route.ts", import.meta.url), "utf8");
  assert.match(route, /centsFromDatabase\(row\.caju_amount/u);
  assert.doesNotMatch(route, /toCents\(/u);
});

test("o modelo é guardado no banco, sem depender de armazenamento externo", async () => {
  const route = await readFile(new URL("../app/api/payments/caju/templates/route.ts", import.meta.url), "utf8");
  // Exigir Blob num caminho que mexe com dinheiro fazia o cadastro falhar com
  // erro genérico onde o armazenamento não estivesse configurado.
  assert.doesNotMatch(route, /getAttachmentsBucket|bucket\.put/u);
  assert.match(route, /source_text/u);
  const migration = await readFile(new URL("../drizzle/postgres/0031_caju_template_source.sql", import.meta.url), "utf8");
  // O original fica guardado: conferir depois com qual planilha o pedido saiu.
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "source_text"/u);
  assert.match(migration, /CHECK \("source_text" <> '' OR "storage_key" <> ''\)/u);
});
