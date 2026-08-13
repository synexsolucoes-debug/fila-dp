import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import { SankhyaConnectorError } from "./errors.ts";
import type { SankhyaRawData } from "./types.ts";

function csvRows(source: string) {
  const header = source.split(/\r?\n/u, 1)[0] ?? "";
  const delimiter = (header.match(/;/gu)?.length ?? 0) >= (header.match(/,/gu)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' && quoted && source[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === delimiter) { row.push(field); field = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function tabularRecords(rows: unknown[][]) {
  const headers = (rows[0] ?? []).map((value, index) => String(value ?? "").trim() || `column_${index + 1}`);
  return rows.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim())).map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ""]),
  )) as SankhyaRawData[];
}

export async function parseSankhyaExport(filePath: string, suggestedName: string, limitBytes: number) {
  const buffer = await readFile(filePath);
  if (!buffer.length || buffer.length > limitBytes) {
    throw new SankhyaConnectorError("SANKHYA_EXPORT_SIZE_INVALID", "O arquivo exportado está vazio ou excede o limite configurado.");
  }
  const extension = extname(suggestedName).toLowerCase();
  if (extension === ".csv") {
    const text = buffer.toString("utf8").replace(/^\uFEFF/u, "");
    return tabularRecords(csvRows(text));
  }
  if (extension !== ".xlsx") {
    throw new SankhyaConnectorError("SANKHYA_EXPORT_TYPE_INVALID", "O DP Explorer exportou um tipo de arquivo não permitido.");
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new SankhyaConnectorError("SANKHYA_EXPORT_CONTENT_INVALID", "O conteúdo do arquivo XLSX é inválido.");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new SankhyaConnectorError("SANKHYA_EXPORT_EMPTY", "O arquivo exportado não contém planilhas.");
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (sourceRow) => {
    const values: string[] = [];
    sourceRow.eachCell({ includeEmpty: true }, (cell, column) => { values[column - 1] = cell.text; });
    rows.push(values);
  });
  return tabularRecords(rows);
}
