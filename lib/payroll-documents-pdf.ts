import { A4, buildPdf, PdfPage } from "./pdf-document.ts";
import type { PayrollLine } from "./payroll-calc.ts";

/**
 * Documentos da folha do ERP DP (item 11 do roadmap, §4.38 da arquitetura):
 * recibo de pagamento (holerite), aviso e recibo de férias e demonstrativo de
 * verbas rescisórias com termo de quitação — a partir do resultado gravado ou
 * calculado, nunca de um número digitado à parte.
 *
 * Usa o gerador mínimo de `lib/pdf-document.ts`. Valor de dinheiro vem
 * precedido de asteriscos até largura fixa, como na folha impressa: impede
 * acrescentar um dígito à esquerda depois de assinado.
 */

export type DocumentCompany = { legalName: string; taxId: string; city?: string; state?: string };
export type DocumentEmployee = {
  name: string; registrationNumber: string; position: string; department: string; admissionDate: string; cpfLast4: string;
};

const MARGIN = 32;
const RIGHT = A4.width - MARGIN;
const BODY = 8;

const money = (cents: number) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((cents || 0) / 100);
const protectedMoney = (cents: number) => {
  const text = money(cents);
  return `${"*".repeat(Math.max(0, 13 - text.length))}${text}`;
};
export const brDate = (date: string | null | undefined) => {
  if (!date) return "—";
  const [y, m, d] = date.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
export function formatTaxId(taxId: string) {
  const digits = taxId.replace(/\D/gu, "");
  return digits.length === 14 ? digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/u, "$1.$2.$3/$4-$5") : taxId;
}
const competenceLabel = (competence: string) => {
  const months = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const [y, m] = competence.split("-").map(Number);
  return `${months[m - 1]} de ${y}`;
};

/** Cabeçalho comum: empresa e colaborador num quadro. Devolve o y logo abaixo. */
function header(page: PdfPage, top: number, title: string, subtitle: string, company: DocumentCompany, employee: DocumentEmployee) {
  page.text(title, MARGIN, top, { font: "helvetica-bold", size: 11 });
  page.textRight(subtitle, RIGHT, top, { font: "helvetica-bold", size: 9 });
  const boxTop = top - 8;
  const height = 42;
  page.rect(MARGIN, boxTop - height, RIGHT - MARGIN, height, 0.7);
  page.text("EMPREGADOR", MARGIN + 6, boxTop - 10, { font: "helvetica-bold", size: 6.5 });
  page.text(company.legalName, MARGIN + 6, boxTop - 20, { size: BODY });
  page.text(`CNPJ ${formatTaxId(company.taxId)}`, MARGIN + 6, boxTop - 30, { size: BODY });
  const mid = MARGIN + (RIGHT - MARGIN) / 2;
  page.line(mid, boxTop, mid, boxTop - height, 0.4);
  page.text("EMPREGADO", mid + 6, boxTop - 10, { font: "helvetica-bold", size: 6.5 });
  page.text(`${employee.registrationNumber} · ${employee.name}`, mid + 6, boxTop - 20, { size: BODY });
  page.text(`${employee.position || "Sem cargo"} · ${employee.department || "Sem departamento"}`, mid + 6, boxTop - 30, { size: BODY });
  page.text(`Admissão ${brDate(employee.admissionDate)}${employee.cpfLast4 ? ` · CPF final ${employee.cpfLast4}` : ""}`, mid + 6, boxTop - 39, { size: 7 });
  return boxTop - height - 14;
}

const COL = { code: MARGIN + 4, label: MARGIN + 40, reference: MARGIN + 300, earning: MARGIN + 440, deduction: RIGHT - 4 };

/** A tabela de rubricas. Devolve o y abaixo dos totais. */
function linesTable(page: PdfPage, top: number, lines: readonly PayrollLine[], maxRows: number) {
  let y = top;
  page.line(MARGIN, y + 9, RIGHT, y + 9, 0.6);
  page.text("CÓD.", COL.code, y, { font: "helvetica-bold", size: 7 });
  page.text("DESCRIÇÃO", COL.label, y, { font: "helvetica-bold", size: 7 });
  page.text("REFERÊNCIA", COL.reference, y, { font: "helvetica-bold", size: 7 });
  page.textRight("VENCIMENTOS", COL.earning, y, { font: "helvetica-bold", size: 7 });
  page.textRight("DESCONTOS", COL.deduction, y, { font: "helvetica-bold", size: 7 });
  y -= 4;
  page.line(MARGIN, y, RIGHT, y, 0.4);
  y -= 11;
  const rows = lines.filter((line) => line.kind !== "info").slice(0, maxRows);
  for (const line of rows) {
    page.text(line.code, COL.code, y, { font: "courier", size: 7.5 });
    page.text(line.label.slice(0, 52), COL.label, y, { size: BODY });
    page.text((line.reference ?? "").slice(0, 24), COL.reference, y, { size: 7.5 });
    if (line.kind === "earning") page.textRight(money(line.amount), COL.earning, y, { font: "courier", size: 7.5 });
    else page.textRight(money(line.amount), COL.deduction, y, { font: "courier", size: 7.5 });
    y -= 10.5;
  }
  if (lines.filter((line) => line.kind !== "info").length > maxRows) {
    page.text("(continua: rubricas além do espaço do recibo constam no resultado gravado)", COL.label, y, { size: 7 });
    y -= 10.5;
  }
  page.line(MARGIN, y + 6, RIGHT, y + 6, 0.4);
  return y;
}

function totalsRow(page: PdfPage, y: number, earnings: number, deductions: number) {
  page.text("TOTAIS", COL.label, y, { font: "helvetica-bold", size: BODY });
  page.textRight(protectedMoney(earnings), COL.earning, y, { font: "courier", size: 8 });
  page.textRight(protectedMoney(deductions), COL.deduction, y, { font: "courier", size: 8 });
  y -= 14;
  page.rect(COL.reference - 6, y - 5, RIGHT - COL.reference + 6, 16, 0.7);
  page.text("LÍQUIDO A RECEBER", COL.reference, y, { font: "helvetica-bold", size: 8.5 });
  page.textRight(`R$ ${protectedMoney(earnings - deductions)}`, COL.deduction, y, { font: "courier", size: 9 });
  return y - 18;
}

function signature(page: PdfPage, y: number, declaration: string, place: string) {
  page.text(declaration, MARGIN, y, { size: 7.5 });
  y -= 28;
  page.line(MARGIN, y, MARGIN + 150, y, 0.5);
  page.line(MARGIN + 190, y, RIGHT, y, 0.5);
  page.text(`${place}, ____/____/________`, MARGIN, y - 9, { size: 7 });
  page.text("Assinatura do empregado", MARGIN + 190, y - 9, { size: 7 });
  return y - 20;
}

/* -------------------------------------------------------------------------- */
/* Holerite                                                                   */
/* -------------------------------------------------------------------------- */

export type PayslipData = {
  company: DocumentCompany;
  employee: DocumentEmployee;
  competence: string;
  salaryCents: number;
  lines: PayrollLine[];
  earningsCents: number;
  deductionsCents: number;
  fgtsCents: number;
};

/** Duas vias por página: a do empregador, que volta assinada, e a do empregado. */
function payslipCopy(page: PdfPage, top: number, data: PayslipData, copy: string) {
  let y = header(page, top, "RECIBO DE PAGAMENTO DE SALÁRIO", `${competenceLabel(data.competence)} · ${copy}`, data.company, data.employee);
  y = linesTable(page, y, data.lines, 16);
  y = totalsRow(page, y - 4, data.earningsCents, data.deductionsCents);
  const info = (code: string) => data.lines.find((line) => line.code === code)?.amount ?? 0;
  const bases: Array<[string, number]> = [
    ["Salário-base", data.salaryCents], ["Base INSS", info("9000")], ["Base FGTS", info("9000")],
    ["FGTS do mês", data.fgtsCents], ["Base IRRF", info("9001")],
  ];
  const width = (RIGHT - MARGIN) / bases.length;
  page.rect(MARGIN, y - 14, RIGHT - MARGIN, 24, 0.4);
  bases.forEach(([label, value], index) => {
    const x = MARGIN + index * width;
    if (index) page.line(x, y + 10, x, y - 14, 0.3);
    page.text(label.toUpperCase(), x + 4, y + 2, { font: "helvetica-bold", size: 6 });
    page.textRight(money(value), x + width - 4, y - 9, { font: "courier", size: 7.5 });
  });
  y -= 30;
  return signature(page, y, "Declaro ter recebido a importância líquida discriminada neste recibo.", data.company.city || "Local");
}

export function payslipPdf(items: readonly PayslipData[], title = "Recibos de pagamento") {
  if (!items.length) throw new Error("Nenhum recibo para gerar.");
  const pages = items.map((data) => {
    const page = new PdfPage(A4.width, A4.height);
    const bottom = payslipCopy(page, A4.height - MARGIN, data, "via do empregador");
    page.line(MARGIN, A4.height / 2, RIGHT, A4.height / 2, 0.3);
    payslipCopy(page, Math.min(bottom - 10, A4.height / 2 - 18), data, "via do empregado");
    return page;
  });
  return buildPdf(pages, title);
}

/* -------------------------------------------------------------------------- */
/* Férias                                                                     */
/* -------------------------------------------------------------------------- */

export type VacationDocumentData = {
  company: DocumentCompany;
  employee: DocumentEmployee;
  acquisitiveStart: string;
  acquisitiveEnd: string;
  start: string;
  end: string;
  returnDate: string;
  restDays: number;
  soldDays: number;
  paymentDue: string;
  lines: PayrollLine[];
  earningsCents: number;
  deductionsCents: number;
};

export function vacationPdf(data: VacationDocumentData) {
  const notice = new PdfPage(A4.width, A4.height);
  let y = header(notice, A4.height - MARGIN, "AVISO DE FÉRIAS", "CLT art. 135", data.company, data.employee);
  const paragraphs = [
    `Comunicamos, com a antecedência mínima de 30 dias exigida pelo art. 135 da CLT, que suas férias referentes ao período aquisitivo de ${brDate(data.acquisitiveStart)} a ${brDate(data.acquisitiveEnd)} serão concedidas conforme abaixo.`,
  ];
  for (const text of paragraphs) {
    for (const chunk of wrap(text, 110)) { notice.text(chunk, MARGIN, y, { size: 9 }); y -= 13; }
  }
  y -= 6;
  const facts: Array<[string, string]> = [
    ["Período de gozo", `${brDate(data.start)} a ${brDate(data.end)} (${data.restDays} dias)`],
    ["Retorno ao trabalho", brDate(data.returnDate)],
    ["Abono pecuniário (art. 143)", data.soldDays ? `${data.soldDays} dias convertidos em dinheiro` : "Não"],
    ["Pagamento até", `${brDate(data.paymentDue)} (2 dias antes do início — art. 145)`],
  ];
  for (const [label, value] of facts) {
    notice.text(label, MARGIN, y, { font: "helvetica-bold", size: 9 });
    notice.text(value, MARGIN + 170, y, { size: 9 });
    y -= 15;
  }
  y -= 10;
  signature(notice, y, "Ciente do aviso de férias.", data.company.city || "Local");

  const receipt = new PdfPage(A4.width, A4.height);
  y = header(receipt, A4.height - MARGIN, "RECIBO DE FÉRIAS", `Gozo ${brDate(data.start)} a ${brDate(data.end)}`, data.company, data.employee);
  y = linesTable(receipt, y, data.lines, 20);
  y = totalsRow(receipt, y - 4, data.earningsCents, data.deductionsCents);
  signature(receipt, y - 6, "Recebi a importância líquida acima, referente às férias descritas, nos termos do art. 145 da CLT.", data.company.city || "Local");
  return buildPdf([notice, receipt], `Férias ${data.employee.registrationNumber}`);
}

/* -------------------------------------------------------------------------- */
/* Rescisão                                                                   */
/* -------------------------------------------------------------------------- */

export type TerminationDocumentData = {
  company: DocumentCompany;
  employee: DocumentEmployee;
  kindLabel: string;
  terminationDate: string;
  projectedEnd: string;
  noticeDays: number;
  paymentDue: string;
  lines: PayrollLine[];
  earningsCents: number;
  deductionsCents: number;
  notes: string[];
};

export function terminationPdf(data: TerminationDocumentData) {
  const page = new PdfPage(A4.width, A4.height);
  let y = header(page, A4.height - MARGIN, "DEMONSTRATIVO DE VERBAS RESCISÓRIAS", data.kindLabel, data.company, data.employee);
  const facts: Array<[string, string]> = [
    ["Último dia trabalhado", brDate(data.terminationDate)],
    ["Aviso prévio indenizado", data.noticeDays ? `${data.noticeDays} dias · projeção até ${brDate(data.projectedEnd)}` : "Não há"],
    ["Prazo de pagamento", `${brDate(data.paymentDue)} (CLT art. 477, §6º)`],
  ];
  for (const [label, value] of facts) {
    page.text(label, MARGIN, y, { font: "helvetica-bold", size: 8.5 });
    page.text(value, MARGIN + 150, y, { size: 8.5 });
    y -= 13;
  }
  y -= 6;
  y = linesTable(page, y, data.lines, 22);
  y = totalsRow(page, y - 4, data.earningsCents, data.deductionsCents);
  const info = data.lines.filter((line) => line.kind === "info");
  for (const line of info) {
    page.text(`${line.label}${line.reference ? ` (${line.reference})` : ""}: R$ ${money(line.amount)}`, MARGIN, y, { size: 7.5 });
    y -= 10;
  }
  y -= 8;
  page.text("TERMO DE QUITAÇÃO", MARGIN, y, { font: "helvetica-bold", size: 9 });
  y -= 13;
  const text = "Recebi do empregador acima a importância líquida discriminada neste demonstrativo, dando plena e geral quitação somente quanto às parcelas e valores nele especificados (CLT, art. 477, §2º). Os mesmos valores alimentam o TRCT e a homologação no sistema oficial.";
  for (const chunk of wrap(text, 118)) { page.text(chunk, MARGIN, y, { size: 8 }); y -= 11; }
  y -= 6;
  signature(page, y, "", data.company.city || "Local");
  return buildPdf([page], `Rescisão ${data.employee.registrationNumber}`);
}

/** Quebra de linha por número de caracteres — suficiente para parágrafos em corpo fixo. */
export function wrap(text: string, width: number) {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if ((line + " " + word).trim().length > width) { out.push(line.trim()); line = word; }
    else line += ` ${word}`;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
