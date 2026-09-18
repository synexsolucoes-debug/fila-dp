import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  detectBlocks, interpretCell, previewLedgerImport, readSheet,
} from "../lib/ledger-import.ts";

/**
 * Leitura assistida da planilha de vales e descontos.
 *
 * Os textos abaixo são os **padrões reais** encontrados no arquivo do cliente —
 * a forma como o DP escreve, não exemplos inventados. Nenhum nome, CPF ou dado
 * bancário real entra aqui: as pessoas são fictícias e os textos foram mantidos
 * porque é exatamente a irregularidade deles que o importador precisa aguentar.
 *
 * O que estes testes prendem são as cinco conclusões que o produto se recusa a
 * tirar sozinho:
 *
 *  1. `5/10` **não** significa cinco parcelas descontadas;
 *  2. `lançado na Domínio` **não** comprova desconto;
 *  3. `VALE FIXO` **não** tem saldo devedor total;
 *  4. duas categorias na mesma célula **não** viram um lançamento só;
 *  5. um nome **não** identifica uma pessoa.
 */

const hashOf = (parts: string) => createHash("sha256").update(parts).digest("hex").slice(0, 32);

// ---------------------------------------------------------------------------
// Interpretação do texto livre
// ---------------------------------------------------------------------------

test("\"5/10 R$ 200,00\" vira parcela corrente, nunca cinco parcelas descontadas", () => {
  const [proposta] = interpretCell("5/10 R$ 200,00 Emprestimo Loja");
  assert.equal(proposta.category, "loan");
  assert.equal(proposta.modality, "installments");
  assert.equal(proposta.currentInstallment, 5);
  assert.equal(proposta.installmentCount, 10);
  assert.equal(proposta.installmentAmount, 200);
  assert.equal(proposta.totalAmount, 2000);
  // A recusa é explícita e aparece na prévia.
  const aviso = proposta.ambiguities.find((item) => item.code === "installment_in_progress");
  assert.ok(aviso, "a parcela corrente precisa virar ambiguidade");
  assert.match(aviso.message, /assume que 4 parcela\(s\) já foram descontadas/i);
});

test("\"lançado na Domínio\" é anotação, não comprovação de desconto", () => {
  const [proposta] = interpretCell("TXC LANÇADO NA DOMÍNIA 3X 49,90 COMP 07/08/09.".replace("DOMÍNIA", "DOMÍNIO"));
  const aviso = proposta.ambiguities.find((item) => item.code === "mentions_launched");
  assert.ok(aviso, "o texto menciona lançamento em outro sistema");
  assert.match(aviso.message, /não é comprovação de desconto|anotação, não comprovação/i);
});

test("\"VALE FIXO\" nasce recorrente e sem saldo devedor total", () => {
  const [proposta] = interpretCell("VALE FIXO");
  assert.equal(proposta.category, "salary_advance");
  assert.equal(proposta.modality, "recurring");
  assert.equal(proposta.totalAmount, null);
  assert.equal(proposta.installmentCount, null);
});

test("\"VALE SOMENTE COMPETÊNCIA 09/2026\" é único, não recorrente", () => {
  const [proposta] = interpretCell("VALE SOMENTE COMPETÊNCIA 09/2026");
  assert.equal(proposta.category, "salary_advance");
  assert.equal(proposta.modality, "single");
  assert.equal(proposta.firstCompetence, "2026-09");
});

test("empréstimo com total, parcelas e competência de início é lido inteiro", () => {
  const [proposta] = interpretCell("EMPRÉSTIMO R$ 2.000 EM 6X DE 333,33 COMEÇAR DESC COMP 06/2026");
  assert.equal(proposta.category, "loan");
  assert.equal(proposta.modality, "installments");
  // "2.000" é dois mil: o ponto é separador de milhar no português da planilha.
  assert.equal(proposta.totalAmount, 2000);
  assert.equal(proposta.installmentCount, 6);
  assert.equal(proposta.installmentAmount, 333.33);
  assert.equal(proposta.firstCompetence, "2026-06");
  /* 6 × 333,33 = 1.999,98. Os dois centavos que faltam são exatamente o resto
     que o parcelamento distribui (333,34 + 333,33 × 5 = 2.000,00), então isto
     **não** é divergência: apontá-la seria ruído em cima do caso normal. A
     tolerância é de um centavo por parcela. */
  assert.equal(proposta.ambiguities.some((item) => item.code === "amount_mismatch"), false);
});

test("multa e franquia são reconhecidas pela própria categoria", () => {
  const [multa] = interpretCell("MULTA 6X DE R$ 149,23 DESC COMP 06/2026");
  assert.equal(multa.category, "traffic_fine");
  assert.equal(multa.installmentCount, 6);
  assert.equal(multa.installmentAmount, 149.23);
  assert.equal(multa.firstCompetence, "2026-06");

  const [franquia] = interpretCell("FRANQUIA DO VEICULO 10 X DE R$ 280,00 COMEÇAR DESC EM 06/2026");
  assert.equal(franquia.category, "vehicle_deductible");
  assert.equal(franquia.installmentCount, 10);
  assert.equal(franquia.installmentAmount, 280);

  const [sesmt] = interpretCell("DESC SESMT R$ 3,45 COMP 05/2026");
  assert.equal(sesmt.category, "sesmt_discount");
  assert.equal(sesmt.totalAmount, 3.45);
  assert.equal(sesmt.firstCompetence, "2026-05");
});

test("dano a equipamento é distinguido de empréstimo", () => {
  const [proposta] = interpretCell("6/6 R$ 33,33 PURIFICADOR DE AGUA");
  assert.equal(proposta.category, "equipment_damage");
  assert.equal(proposta.currentInstallment, 6);
  assert.equal(proposta.installmentCount, 6);
});

test("duas categorias na mesma célula viram duas propostas, não uma", () => {
  // A planilha real tem 59 células assim. Juntá-las perderia uma cobrança.
  const propostas = interpretCell(
    "Não tem direito vale mas, enquanto tiver descontando celular 9/10 R$ 450,00",
  );
  assert.equal(propostas.length, 2);
  const categorias = propostas.map((proposta) => proposta.category).sort();
  assert.deepEqual(categorias, ["equipment_damage", "salary_advance"]);
  assert.ok(propostas.every((proposta) => proposta.ambiguities.some((item) => item.code === "multiple_in_cell")));
});

test("texto que o produto não entende vira pendência, nunca um palpite", () => {
  const [proposta] = interpretCell("FAZER DESCONTO APENAS EM FOLHA");
  assert.equal(proposta.category, "other");
  assert.equal(proposta.totalAmount, null);
  assert.ok(proposta.ambiguities.some((item) => item.code === "unknown_category"));
  // O texto original sobrevive inteiro para quem for conferir.
  assert.equal(proposta.sourceText, "FAZER DESCONTO APENAS EM FOLHA");
});

test("valor ausente e competência ausente são apontados separadamente", () => {
  const [proposta] = interpretCell("EMPRÉSTIMO PARCELADO");
  assert.ok(proposta.ambiguities.some((item) => item.code === "missing_amount"));
  assert.ok(proposta.ambiguities.some((item) => item.code === "missing_competence"));
});

test("célula vazia não produz proposta nenhuma", () => {
  assert.deepEqual(interpretCell(""), []);
  assert.deepEqual(interpretCell("   "), []);
});

// ---------------------------------------------------------------------------
// Estrutura da aba: blocos, cabeçalhos divergentes e colunas deslocadas
// ---------------------------------------------------------------------------

/** Reproduz a forma da planilha real: dois blocos, cabeçalhos diferentes. */
async function planilhaDeEnsaio() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("20.09.26");
  sheet.addRow(["VALES E DESCONTOS EXTRAS / NORTE - CNPJ: 11.111.111/0001-11"]);
  sheet.addRow([]);
  sheet.addRow(["FUNCIONARIO", "Agencia", "Conta", "CPF", "ADTO", "UNIDADE", "DEPARTAMENTO", "EMPRESA", "CONTROLE DE EMPRÉSTIMOS"]);
  sheet.addRow(["Pessoa Exemplo Um", "0000-0", "11111-1", "111.111.111-11", 1040, "NORTE", "DP", "MARCA A", "VALE FIXO"]);
  sheet.addRow(["Pessoa Exemplo Dois", "", "", "222.222.222-22", "", "NORTE", "VENDAS", "MARCA A", "EMPRÉSTIMO R$ 2.000 EM 6X DE 333,33 COMEÇAR DESC COMP 06/2026"]);
  sheet.addRow([]);
  sheet.addRow(["SUL - CNPJ: 22.222.222/0001-22"]);
  // Cabeçalho divergente, como acontece entre blocos da mesma aba.
  sheet.addRow(["FUNCIONARIO", "Agencia", "Conta", "CPF", "VALE (financeiro)", "CIDADE", "DEPARTAMENTO", "EMPRESA", "OUTROS DESCONTOS (financeiro e RH)"]);
  sheet.addRow(["Pessoa Exemplo Tres", "", "", "333.333.333-33", 500, "SUL", "TÉCNICA INTERNA", "MARCA B", "MULTA 6X DE R$ 149,23 DESC COMP 06/2026"]);
  // Coluna deslocada: o CPF caiu na coluna do adiantamento.
  sheet.addRow(["Pessoa Exemplo Quatro", "", "", "", "444.444.444-44", "SUL", "TÉCNICA INTERNA", "MARCA B", ""]);
  return { workbook, sheet };
}

test("os blocos e seus CNPJs são detectados, com cabeçalhos divergentes", async () => {
  const { sheet } = await planilhaDeEnsaio();
  const blocos = detectBlocks(sheet);
  assert.equal(blocos.length, 2);
  assert.equal(blocos[0].taxId, "11.111.111/0001-11");
  assert.equal(blocos[1].taxId, "22.222.222/0001-22");
  // "ADTO" e "VALE (financeiro)" apontam para o mesmo campo; "UNIDADE" e
  // "CIDADE" também. É o mapeamento por bloco que permite isso.
  assert.equal(blocos[0].columns.advanceAmount, 5);
  assert.equal(blocos[1].columns.advanceAmount, 5);
  assert.equal(blocos[0].columns.unit, 6);
  assert.equal(blocos[1].columns.unit, 6);
  assert.ok(blocos[0].freeTextColumns.includes(9));
});

test("empresa do bloco, unidade e operação são três campos distintos", async () => {
  const { sheet } = await planilhaDeEnsaio();
  const linhas = readSheet(sheet, hashOf);
  const primeira = linhas[0];
  // O CNPJ do bloco é a empresa; "NORTE" é a unidade; "MARCA A" é a operação.
  // Confundir os três é o que a planilha fazia.
  assert.equal(primeira.blockTaxId, "11.111.111/0001-11");
  assert.equal(primeira.unit, "NORTE");
  assert.equal(primeira.operation, "MARCA A");
  assert.equal(primeira.department, "DP");
});

test("CPF na coluna do adiantamento vira aviso de coluna deslocada, não dinheiro", async () => {
  const { sheet } = await planilhaDeEnsaio();
  const linhas = readSheet(sheet, hashOf);
  const deslocada = linhas.find((linha) => linha.employeeName === "Pessoa Exemplo Quatro")!;
  assert.equal(deslocada.advanceAmount, null);
  assert.ok(deslocada.ambiguities.some((item) => item.code === "shifted_column"));
});

test("linha sem CPF exige confirmação humana da pessoa", async () => {
  const { sheet } = await planilhaDeEnsaio();
  const linhas = readSheet(sheet, hashOf);
  const semCpf = linhas.find((linha) => linha.employeeName === "Pessoa Exemplo Quatro")!;
  assert.ok(semCpf.ambiguities.some((item) => item.code === "no_tax_id"));
});

test("o adiantamento numérico da coluna vira proposta própria, com competência pendente", async () => {
  const { sheet } = await planilhaDeEnsaio();
  const linhas = readSheet(sheet, hashOf);
  const comMulta = linhas.find((linha) => linha.employeeName === "Pessoa Exemplo Tres")!;
  const adiantamento = comMulta.candidates.find((candidate) => candidate.category === "salary_advance")!;
  assert.equal(adiantamento.totalAmount, 500);
  assert.ok(adiantamento.ambiguities.some((item) => item.code === "missing_competence"));
  // A multa continua sendo uma proposta separada.
  assert.ok(comMulta.candidates.some((candidate) => candidate.category === "traffic_fine"));
});

test("o texto original de cada linha é preservado inteiro", async () => {
  const { sheet } = await planilhaDeEnsaio();
  const linhas = readSheet(sheet, hashOf);
  const emprestimo = linhas.find((linha) => linha.employeeName === "Pessoa Exemplo Dois")!;
  assert.equal(emprestimo.raw.c9, "EMPRÉSTIMO R$ 2.000 EM 6X DE 333,33 COMEÇAR DESC COMP 06/2026");
  assert.equal(emprestimo.sheetName, "20.09.26");
  assert.equal(emprestimo.rowNumber, 5);
});

test("o hash da linha é do conteúdo, e é o que impede a reimportação duplicar", async () => {
  const { sheet } = await planilhaDeEnsaio();
  const primeira = readSheet(sheet, hashOf);
  const segunda = readSheet(sheet, hashOf);
  assert.deepEqual(primeira.map((linha) => linha.rowHash), segunda.map((linha) => linha.rowHash));
  // Linhas diferentes têm hashes diferentes.
  assert.equal(new Set(primeira.map((linha) => linha.rowHash)).size, primeira.length);
});

// ---------------------------------------------------------------------------
// A prévia
// ---------------------------------------------------------------------------

test("por padrão nenhuma aba é lida: importar sete anos recriaria o passado", async () => {
  const { workbook } = await planilhaDeEnsaio();
  const buffer = await workbook.xlsx.writeBuffer() as ArrayBuffer;
  const preview = await previewLedgerImport(buffer, { hashOf });
  assert.deepEqual(preview.sheets, ["20.09.26"]);
  assert.equal(preview.rows.length, 0);
  assert.equal(preview.totals.sheets, 0);
});

test("a prévia conta linhas, propostas e ambiguidades da aba escolhida", async () => {
  const { workbook } = await planilhaDeEnsaio();
  const buffer = await workbook.xlsx.writeBuffer() as ArrayBuffer;
  const preview = await previewLedgerImport(buffer, { sheetNames: ["20.09.26"], hashOf });
  assert.equal(preview.totals.sheets, 1);
  assert.equal(preview.totals.rows, 4);
  assert.ok(preview.totals.candidates >= 4);
  /* Três das quatro linhas têm alguma dúvida. A quarta — o empréstimo com
     categoria, total, parcelas, competência e CPF no texto — passa limpa, e é
     isso que faz a lista de ambiguidades valer alguma coisa: um importador que
     marcasse tudo como duvidoso seria o mesmo que não marcar nada. */
  assert.equal(preview.totals.ambiguous, 3);
  assert.equal(preview.totals.distinctNames, 4);

  const semDuvida = preview.rows.filter((linha) =>
    linha.ambiguities.length === 0 && linha.candidates.every((candidate) => candidate.ambiguities.length === 0));
  assert.equal(semDuvida.length, 1);
  assert.equal(semDuvida[0].employeeName, "Pessoa Exemplo Dois");
});
