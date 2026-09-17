import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  LEDGER_EXPORT_COLUMNS, LEDGER_SHEET_NAME, buildLedgerWorkbook, parseLedgerReturn,
  type LedgerExportRow,
} from "../lib/ledger-export.ts";

/**
 * A planilha da competência, ida e volta.
 *
 * O produto não tem integração com ERP de folha nenhum e não inventa layout de
 * importação de nenhum. O caminho é o que o DP já faz: exporta o que precisa ser
 * lançado, alguém lança, e o **mesmo arquivo** volta com o que foi descontado.
 *
 * Estes testes prendem as três recusas que fazem esse caminho ser seguro:
 *
 *  1. célula vazia não é desconto de zero;
 *  2. valor ilegível é problema apontado, nunca zero gravado em silêncio;
 *  3. o casamento é por identificador de parcela, não por nome — nome não
 *     identifica pessoa numa base com homônimos, e foi assim que a planilha
 *     antiga somou desconto de gente diferente.
 *
 * Nenhum dado real entra aqui: os nomes são fictícios.
 */

const linha = (over: Partial<LedgerExportRow> = {}): LedgerExportRow => ({
  id: "parcela-1",
  employeeName: "Pessoa Exemplo Um",
  registrationNumber: "0001",
  companyName: "Empresa Exemplo LTDA",
  unitLabel: "Unidade Norte",
  departmentLabel: "Técnica Interna",
  category: "Empréstimo",
  entryTitle: "Empréstimo para conserto",
  installment: "1/3",
  competence: "2026-09",
  plannedAmount: 333.34,
  alreadyDiscounted: 0,
  remainingAmount: 333.34,
  ...over,
});

async function exportar(rows: LedgerExportRow[]) {
  return buildLedgerWorkbook({ competence: "2026-09", companyName: "Empresa Exemplo LTDA", rows });
}

/** Devolve o arquivo com valores preenchidos, como quem lançou na folha faria. */
async function preencher(buffer: ArrayBuffer, valores: Record<string, number | string>, note = "") {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(LEDGER_SHEET_NAME)!;
  const colunaId = LEDGER_EXPORT_COLUMNS.findIndex((column) => column.key === "id") + 1;
  const colunaValor = LEDGER_EXPORT_COLUMNS.findIndex((column) => column.key === "discountedNow") + 1;
  const colunaNota = LEDGER_EXPORT_COLUMNS.findIndex((column) => column.key === "note") + 1;
  sheet.eachRow((row) => {
    const id = String(row.getCell(colunaId).value ?? "");
    if (!(id in valores)) return;
    row.getCell(colunaValor).value = valores[id] as never;
    if (note) row.getCell(colunaNota).value = note;
  });
  return await workbook.xlsx.writeBuffer() as ArrayBuffer;
}

test("a planilha exportada abre, tem cabeçalho e uma linha por parcela", async () => {
  const buffer = await exportar([linha(), linha({ id: "parcela-2", installment: "2/3", plannedAmount: 333.33 })]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(LEDGER_SHEET_NAME);
  assert.ok(sheet, "a aba da competência não foi criada");

  const textos: string[] = [];
  sheet.eachRow((row) => { row.eachCell((cell) => textos.push(String(cell.value ?? ""))); });
  assert.ok(textos.some((texto) => texto.includes("competência 2026-09")));
  // A advertência que evita a leitura mais cara possível do arquivo.
  assert.ok(textos.some((texto) => texto.includes("Exportar não confirma desconto")));
  assert.ok(textos.includes("ID da parcela"));
  assert.ok(textos.includes("Desconto realizado"));
  assert.ok(textos.includes("parcela-1") && textos.includes("parcela-2"));
});

test("a coluna de desconto realizado sai vazia: nada parece já confirmado", async () => {
  const buffer = await exportar([linha()]);
  const parsed = await parseLedgerReturn(buffer);
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.blank, 1);
  assert.deepEqual(parsed.problems, []);
});

test("o retorno preenchido é lido pelo identificador da parcela, não pelo nome", async () => {
  const buffer = await exportar([
    linha(),
    linha({ id: "parcela-2", employeeName: "Pessoa Exemplo Um", installment: "2/3" }),
  ]);
  // Duas linhas com o MESMO nome e identificadores diferentes: casar por nome
  // somaria as duas na mesma pessoa errada.
  const devolvido = await preencher(buffer, { "parcela-2": 150 });
  const parsed = await parseLedgerReturn(devolvido);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].installmentId, "parcela-2");
  assert.equal(parsed.rows[0].amountCents, 15000);
  assert.equal(parsed.blank, 1);
});

test("valor em texto brasileiro é aceito, com e sem símbolo", async () => {
  const buffer = await exportar([
    linha({ id: "a" }), linha({ id: "b" }), linha({ id: "c" }), linha({ id: "d" }),
  ]);
  const devolvido = await preencher(buffer, {
    a: "1.234,56", b: "R$ 200,00", c: 333.34, d: "89,9",
  });
  const parsed = await parseLedgerReturn(devolvido);
  const porId = new Map(parsed.rows.map((row) => [row.installmentId, row.amountCents]));
  assert.equal(porId.get("a"), 123456);
  assert.equal(porId.get("b"), 20000);
  assert.equal(porId.get("c"), 33334);
  assert.equal(porId.get("d"), 8990);
});

test("zero digitado é tratado como linha em branco, não como desconto de zero", async () => {
  const buffer = await exportar([linha({ id: "a" }), linha({ id: "b" })]);
  const devolvido = await preencher(buffer, { a: 0, b: "0,00" });
  const parsed = await parseLedgerReturn(devolvido);
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.blank, 2);
  // Zero não vira problema: ninguém errou, só ninguém descontou.
  assert.deepEqual(parsed.problems, []);
});

test("valor ilegível vira problema apontado, nunca zero gravado em silêncio", async () => {
  const buffer = await exportar([linha({ id: "a" })]);
  const devolvido = await preencher(buffer, { a: "não descontou" });
  const parsed = await parseLedgerReturn(devolvido);
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0].reason, /ilegível/);
});

test("valor negativo não vira estorno pelo arquivo", async () => {
  const buffer = await exportar([linha({ id: "a" })]);
  const devolvido = await preencher(buffer, { a: -100 });
  const parsed = await parseLedgerReturn(devolvido);
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.problems.length, 1);
  // Estornar exige motivo escrito, e isso é feito na tela por quem tem a permissão.
  assert.match(parsed.problems[0].reason, /estorno é registrado pela tela/);
});

test("a mesma parcela duas vezes no arquivo é apontada, e só a primeira vale", async () => {
  const buffer = await exportar([linha({ id: "a" })]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await preencher(buffer, { a: 50 }));
  const sheet = workbook.getWorksheet(LEDGER_SHEET_NAME)!;
  const ultima = sheet.lastRow!;
  sheet.addRow(ultima.values as never);
  const duplicado = await workbook.xlsx.writeBuffer() as ArrayBuffer;

  const parsed = await parseLedgerReturn(duplicado);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].amountCents, 5000);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0].reason, /duas vezes/);
});

test("a observação do retorno acompanha a confirmação", async () => {
  const buffer = await exportar([linha({ id: "a" })]);
  const devolvido = await preencher(buffer, { a: 100 }, "Descontado parcialmente por acordo");
  const parsed = await parseLedgerReturn(devolvido);
  assert.equal(parsed.rows[0].note, "Descontado parcialmente por acordo");
});

test("uma linha acrescentada antes do cabeçalho não invalida o arquivo", async () => {
  // Quem abre no Excel às vezes acrescenta uma linha antes de devolver. Recusar
  // por isso seria rigor sem propósito: o cabeçalho é localizado pelo conteúdo.
  const buffer = await exportar([linha({ id: "a" })]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await preencher(buffer, { a: 77 }));
  const sheet = workbook.getWorksheet(LEDGER_SHEET_NAME)!;
  sheet.spliceRows(1, 0, ["Anotação de quem lançou"]);
  const deslocado = await workbook.xlsx.writeBuffer() as ArrayBuffer;

  const parsed = await parseLedgerReturn(deslocado);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].amountCents, 7700);
});

test("um arquivo que não é o exportado é recusado com a razão", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Qualquer coisa");
  sheet.addRow(["Nome", "Valor"]);
  sheet.addRow(["Pessoa Exemplo", 100]);
  const estranho = await workbook.xlsx.writeBuffer() as ArrayBuffer;

  await assert.rejects(
    () => parseLedgerReturn(estranho),
    (error: Error) => {
      assert.match(error.message, /Use o arquivo exportado pelo próprio Vinculato/);
      return true;
    },
  );
});
