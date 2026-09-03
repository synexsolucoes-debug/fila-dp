import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFImage, type PDFFont, type PDFPage } from "pdf-lib";

export type ContractorStatementComponent = {
  direction: "credit" | "debit" | string;
  description: string;
  componentType: string;
  amount: number;
  status: "active" | "canceled" | string;
};

export type ContractorStatement = {
  company: {
    legalName: string;
    tradeName: string;
    taxId: string;
    address: string;
  };
  competence: string;
  issuedAt: Date;
  contractor: {
    code: string;
    legalName: string;
    tradeName: string;
    taxId: string;
    contractReference: string;
    roleTitle: string;
  };
  closing: {
    baseAmount: number;
    creditsAmount: number;
    debitsAmount: number;
    netAmount: number;
    invoiceExpectedAmount: number;
    complementAmount: number;
    cajuAmount: number;
    invoiceNumber: string;
    invoiceReceivedAmount: number;
    invoiceStatus: string;
  };
  components: ContractorStatementComponent[];
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const navy = rgb(0.035, 0.102, 0.18);
const blue = rgb(0.11, 0.45, 0.76);
const cyan = rgb(0.37, 0.75, 0.95);
const ink = rgb(0.09, 0.14, 0.2);
const muted = rgb(0.39, 0.45, 0.52);
const line = rgb(0.85, 0.88, 0.92);
const surface = rgb(0.96, 0.975, 0.99);
const success = rgb(0.11, 0.49, 0.35);
const danger = rgb(0.73, 0.19, 0.24);

const money = (value: number) => new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
}).format(Number(value) || 0);

const competenceLabel = (value: string) => {
  const [year, month] = value.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(date);
};

const formatTaxId = (value: string) => {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 14) return value || "Não informado";
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

const units = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const teens = ["dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const tens = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const hundreds = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

function wordsBelowThousand(value: number) {
  if (value === 0) return "";
  if (value === 100) return "cem";
  const parts: string[] = [];
  const hundred = Math.floor(value / 100);
  const remainder = value % 100;
  if (hundred) parts.push(hundreds[hundred]);
  if (remainder >= 20) {
    parts.push(tens[Math.floor(remainder / 10)]);
    if (remainder % 10) parts.push(units[remainder % 10]);
  } else if (remainder >= 10) {
    parts.push(teens[remainder - 10]);
  } else if (remainder) {
    parts.push(units[remainder]);
  }
  return parts.join(" e ");
}

function amountInWords(value: number) {
  const cents = Math.round((Number(value) || 0) * 100);
  const whole = Math.floor(cents / 100);
  const fractional = cents % 100;
  const groups = [
    { divisor: 1_000_000_000, singular: "bilhão", plural: "bilhões" },
    { divisor: 1_000_000, singular: "milhão", plural: "milhões" },
    { divisor: 1_000, singular: "mil", plural: "mil" },
    { divisor: 1, singular: "", plural: "" },
  ];
  let remaining = whole;
  const parts: string[] = [];
  for (const group of groups) {
    const amount = Math.floor(remaining / group.divisor);
    remaining %= group.divisor;
    if (!amount) continue;
    if (group.divisor === 1) parts.push(wordsBelowThousand(amount));
    else if (group.divisor === 1_000 && amount === 1) parts.push("mil");
    else parts.push(`${wordsBelowThousand(amount)} ${amount === 1 ? group.singular : group.plural}`);
  }
  const wholeWords = parts.join(" ") || "zero";
  const currency = whole === 1 ? "real" : "reais";
  if (!fractional) return `${wholeWords} ${currency}`;
  return `${wholeWords} ${currency} e ${wordsBelowThousand(fractional)} ${fractional === 1 ? "centavo" : "centavos"}`;
}

const activeComponents = (statement: ContractorStatement) =>
  statement.components.filter((component) => component.status === "active");

export function contractorStatementTotals(statement: ContractorStatement) {
  const components = activeComponents(statement);
  const credits = components.filter((component) => component.direction === "credit");
  const debits = components.filter((component) => component.direction === "debit");
  return {
    credits,
    debits,
    totalEarnings: statement.closing.baseAmount + credits.reduce((total, item) => total + Number(item.amount || 0), 0),
    totalDiscounts: debits.reduce((total, item) => total + Number(item.amount || 0), 0),
  };
}

function fitText(value: string, font: PDFFont, size: number, width: number) {
  const normalized = value.replace(/\s+/g, " ").trim() || "—";
  if (font.widthOfTextAtSize(normalized, size) <= width) return normalized;
  let result = normalized;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}…`, size) > width) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}

function wrapText(value: string, font: PDFFont, size: number, width: number) {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function drawOpytLogo(page: PDFPage, italic: PDFFont) {
  const orange = rgb(1, 0.54, 0.05);
  const gray = rgb(0.7, 0.72, 0.74);
  page.drawText("opyt", { x: MARGIN, y: PAGE_HEIGHT - 58, size: 33, font: italic, color: orange });
  page.drawLine({ start: { x: MARGIN + 55, y: PAGE_HEIGHT - 16 }, end: { x: MARGIN + 102, y: PAGE_HEIGHT - 16 }, thickness: 4, color: gray });
  page.drawCircle({ x: MARGIN + 108, y: PAGE_HEIGHT - 16, size: 6, color: gray });
}

function drawWatermark(page: PDFPage, logo: PDFImage) {
  const width = 250;
  const height = width * (logo.height / logo.width);
  page.drawImage(logo, {
    x: (PAGE_WIDTH - width) / 2,
    y: (PAGE_HEIGHT - height) / 2 - 18,
    width,
    height,
    opacity: 0.15,
  });
}

function drawHeader(page: PDFPage, regular: PDFFont, bold: PDFFont, italic: PDFFont, statement: ContractorStatement, continuation = false) {
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 96, width: PAGE_WIDTH, height: 96, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: MARGIN, y: PAGE_HEIGHT - 96 }, end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 96 }, thickness: 0.8, color: line });
  drawOpytLogo(page, italic);
  page.drawText(continuation ? "RECIBO DE PAGAMENTO - CONTINUAÇÃO" : "RECIBO DE PAGAMENTO", {
    x: 307,
    y: PAGE_HEIGHT - 42,
    size: continuation ? 10 : 12,
    font: bold,
    color: navy,
  });
  page.drawText("PRESTAÇÃO DE SERVIÇOS", { x: 307, y: PAGE_HEIGHT - 59, size: 7.4, font: regular, color: muted });
  const label = competenceLabel(statement.competence).toUpperCase();
  const labelWidth = bold.widthOfTextAtSize(label, 9) + 22;
  page.drawRectangle({ x: PAGE_WIDTH - MARGIN - labelWidth, y: PAGE_HEIGHT - 83, width: labelWidth, height: 20, color: rgb(0.93, 0.97, 1), borderColor: rgb(0.65, 0.8, 0.96), borderWidth: 0.6 });
  page.drawText(label, { x: PAGE_WIDTH - MARGIN - labelWidth + 11, y: PAGE_HEIGHT - 76, size: 8, font: bold, color: blue });

  page.drawText(fitText(statement.contractor.legalName, bold, 15, CONTENT_WIDTH - 120), {
    x: MARGIN,
    y: PAGE_HEIGHT - 122,
    size: 15,
    font: bold,
    color: ink,
  });
  page.drawText(fitText(statement.contractor.roleTitle || statement.contractor.tradeName || "Prestador PJ", regular, 9, CONTENT_WIDTH - 120), {
    x: MARGIN,
    y: PAGE_HEIGHT - 138,
    size: 9,
    font: regular,
    color: muted,
  });
}

function drawInfoCard(page: PDFPage, regular: PDFFont, bold: PDFFont, statement: ContractorStatement, y: number) {
  page.drawRectangle({ x: MARGIN, y: y - 68, width: CONTENT_WIDTH, height: 68, color: surface, borderColor: line, borderWidth: 0.8 });
  const fields = [
    ["RECEBEDOR", statement.contractor.legalName],
    ["CNPJ DO RECEBEDOR", formatTaxId(statement.contractor.taxId)],
    ["REFERÊNCIA", statement.contractor.contractReference || "Prestação de serviços"],
  ];
  const columnWidth = CONTENT_WIDTH / fields.length;
  fields.forEach(([label, value], index) => {
    const x = MARGIN + 14 + index * columnWidth;
    page.drawText(label, { x, y: y - 19, size: 7, font: bold, color: blue });
    page.drawText(fitText(value, regular, 8.5, columnWidth - 24), { x, y: y - 37, size: 8.5, font: regular, color: ink });
  });
}

function drawReceiptDeclaration(page: PDFPage, regular: PDFFont, bold: PDFFont, statement: ContractorStatement, y: number) {
  const payerName = statement.company.legalName || statement.company.tradeName || "EMPRESA PAGADORA";
  const payerTaxId = formatTaxId(statement.company.taxId);
  const payerAddress = statement.company.address ? `, LOCALIZADA EM ${statement.company.address}` : "";
  const amount = money(statement.closing.netAmount);
  const sentence = `RECEBI DA EMPRESA ${payerName}, INSCRITA NO CNPJ SOB O Nº ${payerTaxId}${payerAddress}, A IMPORTÂNCIA DE ${amount} (${amountInWords(statement.closing.netAmount).toUpperCase()}), REFERENTE À PRESTAÇÃO DE SERVIÇOS NA COMPETÊNCIA ${competenceLabel(statement.competence).toUpperCase()}.`;
  const note = "DOU QUITAÇÃO EXCLUSIVAMENTE AO VALOR E À COMPETÊNCIA ACIMA INDICADOS. A QUITAÇÃO SE APERFEIÇOA COM A ASSINATURA DO RECEBEDOR E A EFETIVA LIQUIDAÇÃO DO PAGAMENTO.";
  const sentenceLines = wrapText(sentence, regular, 8.5, CONTENT_WIDTH - 32);
  const noteLines = wrapText(note, regular, 7.4, CONTENT_WIDTH - 32);
  const height = 39 + sentenceLines.length * 11 + noteLines.length * 9;
  page.drawRectangle({ x: MARGIN, y: y - height, width: CONTENT_WIDTH, height, color: rgb(1, 1, 1), borderColor: line, borderWidth: 0.8, opacity: 0.94 });
  page.drawText("DECLARAÇÃO DE RECEBIMENTO", { x: MARGIN + 16, y: y - 20, size: 8, font: bold, color: blue });
  let textY = y - 36;
  for (const item of sentenceLines) {
    page.drawText(item, { x: MARGIN + 16, y: textY, size: 8.5, font: regular, color: ink });
    textY -= 11;
  }
  textY -= 4;
  for (const item of noteLines) {
    page.drawText(item, { x: MARGIN + 16, y: textY, size: 7.4, font: regular, color: muted });
    textY -= 9;
  }
  return y - height - 16;
}

function drawSectionTitle(page: PDFPage, bold: PDFFont, title: string, total: number, y: number, tone: "credit" | "debit") {
  const color = tone === "credit" ? success : danger;
  page.drawRectangle({ x: MARGIN, y: y - 28, width: CONTENT_WIDTH, height: 28, color: surface });
  page.drawRectangle({ x: MARGIN, y: y - 28, width: 4, height: 28, color });
  page.drawText(title.toUpperCase(), { x: MARGIN + 14, y: y - 18, size: 9, font: bold, color });
  const totalText = money(total);
  page.drawText(totalText, { x: PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize(totalText, 9), y: y - 18, size: 9, font: bold, color: ink });
}

function drawRow(page: PDFPage, regular: PDFFont, bold: PDFFont, label: string, amount: number, y: number, index: number) {
  if (index % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - 23, width: CONTENT_WIDTH, height: 23, color: rgb(0.985, 0.99, 0.997) });
  page.drawText(fitText(label, regular, 8.5, CONTENT_WIDTH - 135), { x: MARGIN + 14, y: y - 16, size: 8.5, font: regular, color: ink });
  const value = money(amount);
  page.drawText(value, { x: PAGE_WIDTH - MARGIN - 14 - bold.widthOfTextAtSize(value, 8.5), y: y - 16, size: 8.5, font: bold, color: ink });
  page.drawLine({ start: { x: MARGIN, y: y - 23 }, end: { x: PAGE_WIDTH - MARGIN, y: y - 23 }, thickness: 0.45, color: line });
}

function drawSummary(page: PDFPage, regular: PDFFont, bold: PDFFont, statement: ContractorStatement, y: number) {
  page.drawRectangle({ x: MARGIN, y: y - 62, width: CONTENT_WIDTH, height: 62, color: rgb(0.93, 0.97, 1), borderColor: blue, borderWidth: 0.9 });
  page.drawText("VALOR TOTAL DO RECIBO", { x: MARGIN + 16, y: y - 23, size: 7.4, font: bold, color: muted });
  page.drawText("Valor líquido recebido", { x: MARGIN + 16, y: y - 43, size: 10, font: regular, color: ink });
  const net = money(statement.closing.netAmount);
  page.drawText(net, { x: PAGE_WIDTH - MARGIN - 16 - bold.widthOfTextAtSize(net, 18), y: y - 43, size: 18, font: bold, color: blue });

  const paymentY = y - 83;
  page.drawText("COMPOSIÇÃO DO PAGAMENTO", { x: MARGIN, y: paymentY, size: 8, font: bold, color: muted });
  const items = [
    ["VALOR DE DEPÓSITO", statement.closing.invoiceExpectedAmount],
    ["VALOR DO COMPLEMENTO CAJU", statement.closing.cajuAmount],
  ] as const;
  const gap = 10;
  const cardWidth = (CONTENT_WIDTH - gap) / 2;
  items.forEach(([label, amount], index) => {
    const x = MARGIN + index * (cardWidth + gap);
    const value = money(amount);
    page.drawRectangle({ x, y: paymentY - 63, width: cardWidth, height: 49, color: surface, borderColor: line, borderWidth: 0.8 });
    page.drawText(label, { x: x + 12, y: paymentY - 31, size: 6.7, font: bold, color: muted });
    page.drawText(value, { x: x + 12, y: paymentY - 51, size: 12.5, font: bold, color: ink });
  });

  const acknowledgementY = paymentY - 88;
  page.drawText("Assine após a efetiva liquidação do pagamento.", { x: MARGIN, y: acknowledgementY, size: 8.4, font: regular, color: ink });
  const signatureY = acknowledgementY - 36;
  const signatureWidth = 214;
  page.drawLine({ start: { x: MARGIN, y: signatureY }, end: { x: MARGIN + signatureWidth, y: signatureY }, thickness: 0.7, color: muted });
  page.drawLine({ start: { x: PAGE_WIDTH - MARGIN - 130, y: signatureY }, end: { x: PAGE_WIDTH - MARGIN, y: signatureY }, thickness: 0.7, color: muted });
  page.drawText("Assinatura do prestador", { x: MARGIN, y: signatureY - 12, size: 7.2, font: regular, color: muted });
  page.drawText("Data", { x: PAGE_WIDTH - MARGIN - 130, y: signatureY - 12, size: 7.2, font: regular, color: muted });
}

function drawFooter(page: PDFPage, regular: PDFFont, statement: ContractorStatement, pageNumber: number) {
  const issued = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(statement.issuedAt);
  page.drawLine({ start: { x: MARGIN, y: 34 }, end: { x: PAGE_WIDTH - MARGIN, y: 34 }, thickness: 0.6, color: line });
  page.drawText(`Emitido em ${issued} · somente lançamentos ativos`, { x: MARGIN, y: 20, size: 7, font: regular, color: muted });
  const number = `Página ${pageNumber}`;
  page.drawText(number, { x: PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(number, 7), y: 20, size: 7, font: regular, color: muted });
}

export async function generateContractorStatementsPdf(statements: ContractorStatement[]) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const watermark = await pdf.embedPng(await readFile(join(process.cwd(), "public", "brand", "vinculato-mark.png")));
  let pageNumber = 0;

  for (const statement of statements) {
    const totals = contractorStatementTotals(statement);
    let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pageNumber += 1;
    drawWatermark(page, watermark);
    drawHeader(page, regular, bold, italic, statement);
    drawInfoCard(page, regular, bold, statement, PAGE_HEIGHT - 158);
    let y = drawReceiptDeclaration(page, regular, bold, statement, PAGE_HEIGHT - 244);

    const newContinuationPage = () => {
      drawFooter(page, regular, statement, pageNumber);
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pageNumber += 1;
      drawWatermark(page, watermark);
      drawHeader(page, regular, bold, italic, statement, true);
      y = PAGE_HEIGHT - 166;
    };

    const section = (title: string, items: Array<{ description: string; componentType: string; amount: number }>, total: number, tone: "credit" | "debit", base = false) => {
      const rowCount = items.length + (base ? 1 : 0);
      if (y - 34 - Math.min(rowCount, 2) * 23 < 178) newContinuationPage();
      drawSectionTitle(page, bold, title, total, y, tone);
      y -= 31;
      let index = 0;
      if (base) {
        drawRow(page, regular, bold, "Valor contratual", statement.closing.baseAmount, y, index++);
        y -= 23;
      }
      if (items.length === 0 && !base) {
        drawRow(page, regular, bold, "Nenhum desconto nesta competência", 0, y, index++);
        y -= 23;
      }
      for (const item of items) {
        if (y - 23 < 178) {
          newContinuationPage();
          drawSectionTitle(page, bold, `${title} · continuação`, total, y, tone);
          y -= 31;
        }
        drawRow(page, regular, bold, item.description || item.componentType, item.amount, y, index++);
        y -= 23;
      }
      y -= 15;
    };

    section("Proventos", totals.credits, totals.totalEarnings, "credit", true);
    section("Descontos", totals.debits, totals.totalDiscounts, "debit");
    if (y - 220 < 45) newContinuationPage();
    drawSummary(page, regular, bold, statement, y);
    drawFooter(page, regular, statement, pageNumber);
  }

  return pdf.save();
}
