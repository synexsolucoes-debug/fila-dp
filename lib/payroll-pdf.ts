import { extractText, getDocumentProxy } from "unpdf";

export type PayrollPdfModel = "sankhya_summary" | "dominio_analytical";

export type PayrollPdfMetrics = {
  model: PayrollPdfModel;
  modelLabel: string;
  totalPages: number;
  companyName: string;
  taxId: string;
  period: string;
  headcount: number;
  leavesCount: number;
  admissions: number;
  terminations: number;
  baseSalary: number;
  additionalPay: number;
  grossPayroll: number;
  employeeInss: number;
  employeeIrrf: number;
  employeeOtherDeductions: number;
  totalDeductions: number;
  netPay: number;
  employerInss: number;
  ratContribution: number;
  thirdPartyContributions: number;
  fgts: number;
  fgtsPenalty: number;
  employerCharges: number;
  payrollCost: number;
  warnings: string[];
};

const amount = (value: string | undefined) => {
  if (!value) return 0;
  const parsed = Number(value.replace(/\./gu, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
};

const rounded = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const digits = (value: string) => value.replace(/\D/gu, "");
const taxId = (text: string) => text.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/u)?.[0] ?? "";

function period(text: string) {
  const match = text.match(/(?:Competência:\s*|EXTRATO MENSAL\s*)(\d{2})\/(\d{4})/iu);
  return match ? `${match[2]}-${match[1]}` : "";
}

function labeledAmount(text: string, label: RegExp) {
  return amount(text.match(new RegExp(`${label.source}\\s*([\\d.]+,\\d{2})`, label.flags))?.[1]);
}

function parseSankhyaSummary(pages: string[]): PayrollPdfMetrics {
  const first = pages[0] ?? "";
  const charges = pages.find((page) => /Dados FGTS/iu.test(page)) ?? pages[1] ?? "";
  const totals = first.match(/Total Líquido:\s*([\d.]+,\d{2})\s*([\d.]+,\d{2})Sal\. Base:\s*([\d.]+,\d{2})\s*Total de Descontos:Total Bruto:\s*([\d.]+,\d{2})/iu);
  const people = first.match(/Admitidos no\s*(\d+)\s*(\d+)Demitidos no Afastados no\s*(\d+)\s*Total de\s*(\d+)/iu);
  if (!totals) throw new Error("Não foi possível localizar os totais do resumo da folha.");
  const grossPayroll = amount(totals[1]);
  const baseSalary = amount(totals[2]);
  const netPay = amount(totals[3]);
  const totalDeductions = amount(totals[4]);
  const employeeInss = amount(first.match(/\s([\d.]+,\d{2})9010\s*-\s*INSS(?:\s|$)/iu)?.[1])
    + amount(first.match(/\s([\d.]+,\d{2})9120\s*-\s*INSS\s*-\s*PRO LABORE/iu)?.[1]);
  const employeeIrrf = amount(first.match(/\s([\d.]+,\d{2})9040\s*-\s*IRRF/iu)?.[1]);
  const employerInss = labeledAmount(charges, /Parte Empresa:/iu);
  const ratContribution = amount(charges.match(/RAT Ajustado[^\n]*\):\s*([\d.]+,\d{2})/iu)?.[1]);
  const thirdPartyContributions = labeledAmount(charges, /Outros:/iu);
  const fgtsPair = charges.match(/Total:\s*([\d.]+,\d{2})(\d{2}\.\d{3},\d{2})/u);
  const fgts = amount(fgtsPair?.[1]);
  const employerCharges = rounded(employerInss + ratContribution + thirdPartyContributions + fgts);
  const name = first.match(/\n([^\n]+?)\s*-\s*\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\s*\nCompetência:/u)?.[1]?.trim() ?? "";
  return {
    model: "sankhya_summary", modelLabel: "Resumo da folha (Pessoal+ / Sankhya)", totalPages: pages.length,
    companyName: name, taxId: taxId(first), period: period(first), headcount: Number(people?.[4] ?? 0),
    admissions: Number(people?.[1] ?? 0), terminations: Number(people?.[2] ?? 0), leavesCount: Number(people?.[3] ?? 0),
    baseSalary, additionalPay: rounded(Math.max(0, grossPayroll - baseSalary)), grossPayroll,
    employeeInss, employeeIrrf, employeeOtherDeductions: rounded(Math.max(0, totalDeductions - employeeInss - employeeIrrf)),
    totalDeductions, netPay, employerInss, ratContribution, thirdPartyContributions, fgts, fgtsPenalty: 0,
    employerCharges, payrollCost: rounded(grossPayroll + employerCharges),
    warnings: ["Custos de benefícios e provisões não constam de forma consolidada neste modelo e permanecem zerados."],
  };
}

function parseDominioAnalytical(pages: string[]): PayrollPdfMetrics {
  const all = pages.join("\n");
  const totalsPage = pages.find((page) => /Total Geral Proventos:/iu.test(page)) ?? all;
  const charges = pages.find((page) => /FGTS, PIS e ISS/iu.test(page)) ?? all;
  const totals = totalsPage.match(/Total Geral Proventos:\s*Total Geral Descontos:\s*([\d.]+,\d{2})\s*([\d.]+,\d{2})[\s\S]*?Líquido Geral:\s*([\d.]+,\d{2})/iu);
  if (!totals) throw new Error("Não foi possível localizar os totais do extrato mensal.");
  const grossPayroll = amount(totals[1]);
  const totalDeductions = amount(totals[2]);
  const netPay = amount(totals[3]);
  const employeeInss = labeledAmount(charges, /Segurados:/iu);
  const irrfPair = charges.match(/Valor Total do IRRF:\s*Valor Total do IRRF:\s*([\d.]+,\d{2})\s*([\d.]+,\d{2})/iu);
  const employeeIrrf = amount(irrfPair?.[1]);
  const employerInss = labeledAmount(charges, /Empresa:/iu);
  const ratContribution = labeledAmount(charges, /RAT:/iu);
  const thirdPartyContributions = labeledAmount(charges, /Terceiros:/iu);
  const fgts = amount(charges.match(/\n([\d.]+,\d{2})Salário contribuição contribuintes:[^\n]*Valor do FGTS:/iu)?.[1]);
  const employerCharges = rounded(employerInss + ratContribution + thirdPartyContributions + fgts);
  const employeeBlocks = pages.slice(0, 4).join("\n").match(/^\d+\s+.+?(?:Empr\.:|Contr:)/gmu) ?? [];
  const header = pages[0] ?? "";
  const name = header.match(/\n\d+\s*-\s*([^\n]+)\nCNPJ:/u)?.[1]?.trim() ?? "";
  return {
    model: "dominio_analytical", modelLabel: "Extrato mensal analítico (Domínio)", totalPages: pages.length,
    companyName: name, taxId: taxId(header), period: period(header), headcount: employeeBlocks.length,
    admissions: 0, terminations: 0, leavesCount: 0, baseSalary: 0, additionalPay: 0, grossPayroll,
    employeeInss, employeeIrrf, employeeOtherDeductions: rounded(Math.max(0, totalDeductions - employeeInss - employeeIrrf)),
    totalDeductions, netPay, employerInss, ratContribution, thirdPartyContributions, fgts, fgtsPenalty: 0,
    employerCharges, payrollCost: rounded(grossPayroll + employerCharges),
    warnings: ["O modelo analítico não separa admissões e desligamentos com segurança no texto do PDF; esses campos permanecem zerados."],
  };
}

export function parsePayrollTextPages(pages: string[]) {
  const cleaned = pages.map((page) => page.normalize("NFC").replace(/\u0000/gu, ""));
  const first = cleaned[0] ?? "";
  const parsed = /Pessoal\s*\+|Resumo Geral|Dados FGTS/iu.test(cleaned.join("\n"))
    ? parseSankhyaSummary(cleaned)
    : /EXTRATO MENSAL/iu.test(first) ? parseDominioAnalytical(cleaned) : null;
  if (!parsed) throw new Error("Modelo de folha não reconhecido. Envie o resumo Pessoal+ ou o extrato mensal Domínio.");
  if (!parsed.period || !parsed.taxId || !parsed.grossPayroll || !parsed.netPay) throw new Error("O PDF não contém empresa, competência e totais suficientes para uma importação segura.");
  if (digits(parsed.taxId).length !== 14) throw new Error("O CNPJ identificado no PDF é inválido.");
  return parsed;
}

export async function readPayrollPdf(buffer: ArrayBuffer) {
  if (buffer.byteLength > 12 * 1024 * 1024) throw new Error("O PDF deve ter no máximo 12 MB.");
  const signature = new TextDecoder("ascii").decode(buffer.slice(0, 5));
  if (signature !== "%PDF-") throw new Error("O arquivo enviado não é um PDF válido.");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  if (pdf.numPages > 100) throw new Error("O PDF deve ter no máximo 100 páginas.");
  const extracted = await extractText(pdf, { mergePages: false });
  return parsePayrollTextPages(extracted.text);
}
