/**
 * Leitura dos cadastros auxiliares exportados do Sankhya (cargo, departamento,
 * sindicato) — o mesmo "Resultado da Query" que `lib/sankhya-xlsx.ts` já lê
 * para funcionários, só que para as tabelas de apoio.
 *
 * ## Por que existe
 *
 * A planilha de admissão que o Sankhya espera não usa nome de cargo ou
 * departamento — usa o código dele (CODCARGO, CODDEP, CODSIND). Sem estes
 * catálogos, cada admissão exigiria perguntar o código pessoa por pessoa; com
 * eles, quem confere escolhe de uma lista, do mesmo jeito que já escolhe
 * cargo e departamento hoje pelo cadastro auxiliar do Vinculato.
 *
 * ## Por que só .xlsx
 *
 * `exceljs` — já usado por `sankhya-xlsx.ts` — não lê o formato binário
 * legado (.xls) que o Sankhya às vezes exporta. Adicionar uma biblioteca só
 * para isso (SheetJS, por exemplo) traria dependência nova sem necessidade:
 * o Excel ou o LibreOffice resolvem com um "Salvar como" antes do upload.
 */
import ExcelJS from "exceljs";

export type SankhyaCatalogKind = "positions" | "departments" | "unions";

export type SankhyaCatalogRecord = {
  code: string;
  name: string;
  cboCode: string;
  status: "active" | "inactive";
};

const columnsByKind: Readonly<Record<SankhyaCatalogKind, { code: string; name: string; cbo?: string; active?: string }>> = {
  positions: { code: "CODCARGO", name: "DESCRCARGO", cbo: "CODCBO", active: "ATIVO" },
  departments: { code: "CODDEP", name: "DESCRDEP", active: "ATIVO" },
  unions: { code: "CODSIND", name: "NOMESIND" },
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

const codeText = (value: ExcelJS.CellValue) => valueText(value).replace(/\.0$/u, "");

export async function readSankhyaCatalogWorkbook(buffer: ArrayBuffer, kind: SankhyaCatalogKind) {
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error("A planilha deve ter no máximo 10 MB.");
  const columns = columnsByKind[kind];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("A planilha não possui nenhuma aba.");

  let headerRow = 0;
  let headerColumns = new Map<string, number>();
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRow) return;
    const candidate = new Map<string, number>();
    row.eachCell({ includeEmpty: false }, (cell, column) => candidate.set(valueText(cell.value).toUpperCase(), column));
    if (candidate.has(columns.code) && candidate.has(columns.name)) {
      headerRow = rowNumber;
      headerColumns = candidate;
    }
  });
  if (!headerRow) {
    throw new Error(`Modelo Sankhya inválido: cabeçalhos ${columns.code} e ${columns.name} não encontrados.`);
  }

  const cell = (row: ExcelJS.Row, name: string) => row.getCell(headerColumns.get(name) ?? 0).value;
  const records: SankhyaCatalogRecord[] = [];
  const seen = new Set<string>();
  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const code = codeText(cell(row, columns.code));
    const name = valueText(cell(row, columns.name)).replace(/\s+/gu, " ");
    if (!code && !name) continue;
    if (!code || !name) throw new Error(`Linha ${rowNumber}: código e nome são obrigatórios.`);
    if (seen.has(code)) throw new Error(`Linha ${rowNumber}: código ${code} aparece mais de uma vez.`);
    seen.add(code);
    const active = columns.active ? valueText(cell(row, columns.active)).toUpperCase() : "S";
    records.push({
      code, name,
      cboCode: columns.cbo ? codeText(cell(row, columns.cbo)) : "",
      status: active === "N" ? "inactive" : "active",
    });
  }
  if (!records.length) throw new Error("Nenhum registro foi encontrado na planilha.");
  if (records.length > 5000) throw new Error("A importação aceita no máximo 5.000 registros por arquivo.");
  return records;
}
