/**
 * Planilhas do módulo Movimentos para o Sankhya: a leitura do catálogo de
 * eventos (query da TFPEVE) e a geração do arquivo do Importador de Movimentos.
 *
 * As regras ficam em `lib/payroll-movements.ts`; aqui só há transporte entre
 * linhas e `exceljs`. Como em `sankhya-catalog-xlsx.ts`, só `.xlsx` é lido: o
 * formato binário legado (.xls) que o Sankhya às vezes exporta resolve-se com
 * um "Salvar como" no Excel ou no LibreOffice.
 */
import ExcelJS from "exceljs";
import { MOVEMENT_EXPORT_HEADER, parseEventCatalogRows, type MovementExportRow } from "./payroll-movements.ts";

export const MAX_CATALOG_FILE_BYTES = 10 * 1024 * 1024;

const cellValue = (value: ExcelJS.CellValue): unknown => {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text ?? "");
    if ("result" in value) return value.result ?? "";
  }
  return value;
};

export async function readEventCatalogWorkbook(buffer: ArrayBuffer) {
  if (buffer.byteLength > MAX_CATALOG_FILE_BYTES) throw new Error("A planilha deve ter no máximo 10 MB.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("A planilha não possui nenhuma aba.");
  const rows: unknown[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => { values[column - 1] = cellValue(cell.value); });
    rows.push(values);
  });
  return parseEventCatalogRows(rows);
}

/** Data da coluna REFERENCIA em UTC, para o Excel gravar exatamente o dia 1º. */
function referenceDate(reference: string) {
  const [year, month, day] = reference.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * O arquivo que o Importador de Movimentos do Sankhya recebe: uma aba
 * "Planilha1", cabeçalho na linha 1, uma linha por movimento, na ordem do
 * modelo. Nada além disso — título ou total quebrariam a importação.
 */
export async function buildMovementWorkbook(rows: MovementExportRow[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Vinculato";
  const sheet = workbook.addWorksheet("Planilha1");
  sheet.addRow([...MOVEMENT_EXPORT_HEADER]);
  for (const row of rows) {
    sheet.addRow([
      row.companyCode, row.employeeCode, referenceDate(row.reference), row.tipmov, row.eventCode,
      row.sequence, row.indexValue, row.amount, row.eventType, row.unit,
    ]);
  }
  sheet.getColumn(3).numFmt = "dd/mm/yyyy";
  sheet.columns.forEach((column) => { column.width = 13; });
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as ArrayBuffer;
}
