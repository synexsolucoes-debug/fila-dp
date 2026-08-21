import ExcelJS from "exceljs";

export type SankhyaSpreadsheetEmployee = {
  companyCode: string;
  employeeCode: string;
  registrationNumber: string;
  fullName: string;
  cpf: string;
  birthDate: string;
  admissionDate: string;
  terminationDate: string;
  email: string;
  phone: string;
  externalId: string;
};

const valueText = (value: ExcelJS.CellValue) => {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("result" in value) return String(value.result ?? "").trim();
  }
  return String(value).trim();
};

const digits = (value: string) => value.replace(/\D/gu, "");

const dateValue = (value: ExcelJS.CellValue) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = valueText(value);
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    return date.toISOString().slice(0, 10);
  }
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/u);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
};

export async function readSankhyaEmployeeWorkbook(buffer: ArrayBuffer) {
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error("A planilha deve ter no máximo 10 MB.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("A planilha não possui nenhuma aba.");

  let headerRow = 0;
  let columns = new Map<string, number>();
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRow) return;
    const candidate = new Map<string, number>();
    row.eachCell({ includeEmpty: false }, (cell, column) => candidate.set(valueText(cell.value).toUpperCase(), column));
    if (["CODEMP", "CODFUNC", "NOMEFUNC", "CPF", "DTADM"].every((key) => candidate.has(key))) {
      headerRow = rowNumber;
      columns = candidate;
    }
  });
  if (!headerRow) throw new Error("Modelo Sankhya inválido: cabeçalhos CODEMP, CODFUNC, NOMEFUNC, CPF e DTADM não encontrados.");

  const cell = (row: ExcelJS.Row, name: string) => row.getCell(columns.get(name) ?? 0).value;
  const records: SankhyaSpreadsheetEmployee[] = [];
  const seen = new Set<string>();
  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const companyCode = valueText(cell(row, "CODEMP")).replace(/\.0$/u, "");
    const employeeCode = valueText(cell(row, "CODFUNC")).replace(/\.0$/u, "");
    const fullName = valueText(cell(row, "NOMEFUNC")).replace(/\s+/gu, " ");
    const cpf = digits(valueText(cell(row, "CPF"))).padStart(11, "0").slice(-11);
    const admissionDate = dateValue(cell(row, "DTADM"));
    if (!companyCode && !employeeCode && !fullName) continue;
    if (!companyCode || !employeeCode || !fullName || !admissionDate) throw new Error(`Linha ${rowNumber}: empresa, código, nome e admissão são obrigatórios.`);
    const externalId = `${companyCode}:${employeeCode}`;
    if (seen.has(externalId)) throw new Error(`Linha ${rowNumber}: colaborador ${externalId} aparece mais de uma vez.`);
    seen.add(externalId);
    records.push({
      companyCode, employeeCode, registrationNumber: valueText(cell(row, "MATRICULA")).replace(/\.0$/u, "") || employeeCode,
      fullName, cpf: cpf === "00000000000" ? "" : cpf, birthDate: dateValue(cell(row, "DTNASC")),
      admissionDate, terminationDate: dateValue(cell(row, "DTDEM")),
      email: valueText(cell(row, "EMAILCORP")) || valueText(cell(row, "EMAIL")), phone: digits(valueText(cell(row, "CELULAR"))), externalId,
    });
  }
  if (!records.length) throw new Error("Nenhum colaborador foi encontrado na planilha.");
  if (records.length > 5000) throw new Error("A importação aceita no máximo 5.000 colaboradores por arquivo.");
  return records;
}
