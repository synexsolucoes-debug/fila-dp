import { strFromU8, unzipSync } from "fflate";

export const EMPLOYEE_WORKBOOK_SOURCE = "opyt_employee_workbook";
export const EMPLOYEE_WORKBOOK_SHEET = "GRUPO OPYT";
export const EMPLOYEE_WORKBOOK_FILENAME = "Funcionários GRUPO OPYT .xlsx";

export type EmployeeWorkbookRecord = {
  sourceRow: number;
  sourceIdentity: string;
  fullName: string;
  email: string;
  regime: "clt" | "pj";
  companyLabel: string;
  registrationUnit: string;
  companyTaxId: string;
  jobTitle: string;
  department: string;
  costCenter: string;
  startDate: string | null;
  monthlyValue: number;
  mealBenefit: number;
  transportBenefit: number;
  warnings: string[];
};

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(fragment: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeXml(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`).exec(fragment)?.[1] ?? "");
}

function xmlText(fragment: string) {
  return decodeXml(fragment.replace(/<[^>]+>/g, ""));
}

function normalizedText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function cellColumnIndex(reference: string) {
  const letters = /^[A-Z]+/i.exec(reference)?.[0]?.toUpperCase() ?? "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function workbookSheetRows(buffer: ArrayBuffer, requestedSheet: string) {
  const archive = unzipSync(new Uint8Array(buffer));
  const read = (name: string) => archive[name] ? strFromU8(archive[name]) : "";
  const workbookXml = read("xl/workbook.xml");
  const relationshipsXml = read("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relationshipsXml) throw new Error("O arquivo não possui uma estrutura XLSX válida.");

  const relationshipTargets = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    relationshipTargets.set(xmlAttribute(match[1], "Id"), xmlAttribute(match[1], "Target"));
  }

  let sheetRelationshipId = "";
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    if (normalizedText(xmlAttribute(match[1], "name")) === normalizedText(requestedSheet)) {
      sheetRelationshipId = xmlAttribute(match[1], "r:id");
      break;
    }
  }
  if (!sheetRelationshipId) throw new Error(`A aba “${requestedSheet}” não foi encontrada na planilha.`);
  const target = relationshipTargets.get(sheetRelationshipId) ?? "";
  const worksheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const worksheetXml = read(worksheetPath.replace(/\\/g, "/"));
  if (!worksheetXml) throw new Error(`Não foi possível ler a aba “${requestedSheet}”.`);

  const sharedStringsXml = read("xl/sharedStrings.xml");
  const sharedStrings = [...sharedStringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1]));
  const rows: unknown[][] = [];
  for (const rowMatch of worksheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Math.max(1, Number(xmlAttribute(rowMatch[1], "r")) || rows.length + 1);
    const row: unknown[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1] ?? cellMatch[2] ?? "";
      const body = cellMatch[3] ?? "";
      const reference = xmlAttribute(attributes, "r");
      const type = xmlAttribute(attributes, "t");
      const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
      let value: unknown = null;
      if (type === "s") value = sharedStrings[Number(rawValue)] ?? "";
      else if (type === "inlineStr") value = xmlText(body);
      else if (type === "str") value = decodeXml(rawValue);
      else if (type === "b") value = rawValue === "1";
      else if (type !== "e" && rawValue !== "") {
        const numeric = Number(rawValue);
        value = Number.isFinite(numeric) ? numeric : decodeXml(rawValue);
      }
      row[cellColumnIndex(reference)] = value;
    }
    rows[rowNumber - 1] = row;
  }
  return rows;
}

function numericValue(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value) : 0;
  const raw = String(value ?? "").trim();
  if (!raw || /^(x|sim|não|nao)$/i.test(raw) || raw.startsWith("#")) return 0;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const result = Number(normalized);
  return Number.isFinite(result) ? Math.max(0, result) : 0;
}

function excelDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 20_000 && value < 100_000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  const raw = String(value ?? "").trim();
  const brazilian = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (brazilian) return `${brazilian[3]}-${brazilian[2]}-${brazilian[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

export function isValidCnpj(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 14 || /^(\d)\1+$/.test(digits)) return false;
  const digit = (length: number) => {
    let sum = 0;
    let weight = length - 7;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * weight;
      weight -= 1;
      if (weight < 2) weight = 9;
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return digit(12) === Number(digits[12]) && digit(13) === Number(digits[13]);
}

export function parseEmployeeSheetRows(rows: unknown[][]) {
  const headerIndex = rows.findIndex((row) => normalizedText(row?.[2]) === "COLABORADOR" && normalizedText(row?.[6]) === "CPF" && normalizedText(row?.[7]) === "EMPRESA");
  if (headerIndex < 0) throw new Error("Não foi possível localizar o cabeçalho COLABORADOR/CPF/EMPRESA na aba GRUPO OPYT.");
  const records: EmployeeWorkbookRecord[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const fullName = String(row[2] ?? "").replace(/\s+/g, " ").trim();
    if (!fullName) continue;
    const rawCpf = String(row[6] ?? "").replace(/\D/g, "");
    const email = String(row[34] ?? "").trim().toLowerCase();
    const companyColumn = String(row[7] ?? "").replace(/\s+/g, " ").trim();
    const registrationUnit = String(row[8] ?? "").replace(/\s+/g, " ").trim();
    const isPj = [row[3], row[4], row[7]].some((value) => normalizedText(value) === "PJ");
    const companyLabel = isPj ? registrationUnit || companyColumn : companyColumn || registrationUnit;
    const rawCompanyTaxId = String(row[29] ?? "").trim();
    const validCompanyTaxId = isValidCnpj(rawCompanyTaxId) ? rawCompanyTaxId.replace(/\D/g, "") : "";
    const warnings: string[] = [];
    if (!rawCpf) warnings.push("cpf_ausente");
    if (!email) warnings.push("email_ausente");
    if (!companyLabel) warnings.push("empresa_ausente");
    if (rawCompanyTaxId && !validCompanyTaxId) warnings.push("cnpj_invalido");
    const startDate = row.slice(21, 29).map(excelDate).find(Boolean) ?? null;
    const monthlyValue = numericValue(row[11]);
    if (!monthlyValue) warnings.push("valor_mensal_ausente");
    records.push({
      sourceRow: index + 1,
      sourceIdentity: rawCpf ? `cpf:${rawCpf}` : email ? `email:${email}` : `nome:${normalizedText(fullName)}|${normalizedText(companyLabel)}|${normalizedText(registrationUnit)}`,
      fullName,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
      regime: isPj ? "pj" : "clt",
      companyLabel,
      registrationUnit,
      companyTaxId: validCompanyTaxId,
      jobTitle: String(row[4] ?? row[3] ?? "").replace(/\s+/g, " ").trim(),
      department: String(row[5] ?? "").replace(/\s+/g, " ").trim(),
      costCenter: String(row[9] ?? "").trim(),
      startDate,
      monthlyValue,
      mealBenefit: numericValue(row[19]),
      transportBenefit: numericValue(row[20]),
      warnings,
    });
  }
  if (!records.length) throw new Error("A aba GRUPO OPYT não contém funcionários para importar.");
  return records;
}

export function parseEmployeeWorkbook(buffer: ArrayBuffer) {
  return parseEmployeeSheetRows(workbookSheetRows(buffer, EMPLOYEE_WORKBOOK_SHEET));
}
