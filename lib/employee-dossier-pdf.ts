import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Dossiê do colaborador, passo 1 — o documento (§4.18).
 *
 * O problema que o roteiro de produto nomeou: montar os subsídios de uma
 * defesa trabalhista hoje é abrir três telas diferentes (EPI, ASO,
 * treinamento) e copiar à mão. As três já são dados estruturados e reais —
 * este módulo só os imprime juntos, num documento que o DP anexa a um
 * processo ou entrega a um advogado. Nenhuma tabela nova: é leitura, como a
 * Central de Trabalho (§93).
 *
 * Acidente de trabalho fica de fora de propósito: `fdp_work_accidents` é
 * anonimizado, sem FK de colaborador (§83) — não há o que juntar aqui.
 */

export type DossierEpiDelivery = {
  deliveredOn: string;
  productName: string;
  caNumber: string;
  quantity: number;
  status: string;
  signatureName: string;
};

export type DossierExam = {
  examDate: string;
  examType: string;
  result: string;
  nextDueDate: string | null;
};

export type DossierTraining = {
  completedOn: string;
  trainingName: string;
  validUntil: string | null;
  providerName: string;
};

export type EmployeeDossier = {
  workspaceName: string;
  companyName: string;
  employeeName: string;
  registrationNumber: string;
  positionName: string;
  admissionDate: string;
  issuedAt: Date;
  /** `null` — e não `[]` — quando quem pediu o dossiê não tem a capacidade da
   *  seção: "sem permissão para ver" não pode imprimir como "nenhum registro". */
  epiDeliveries: DossierEpiDelivery[] | null;
  exams: DossierExam[] | null;
  trainings: DossierTraining[] | null;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ink = rgb(0.09, 0.11, 0.15);
const muted = rgb(0.44, 0.48, 0.54);
const line = rgb(0.82, 0.85, 0.89);
const surface = rgb(0.97, 0.98, 0.99);
const blue = rgb(0.11, 0.45, 0.76);

const dateOf = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("pt-BR") : "—";

const examTypeLabels: Record<string, string> = {
  admission: "Admissional", periodic: "Periódico", return_to_work: "Retorno ao trabalho",
  role_change: "Mudança de função", termination: "Demissional", other: "Outro",
};
const examResultLabels: Record<string, string> = {
  fit: "Apto", unfit: "Inapto", fit_with_restriction: "Apto com restrição",
};
const epiStatusLabels: Record<string, string> = {
  delivered: "Entregue", pending_signature: "Aguardando ciência", signed: "Ciência confirmada", canceled: "Cancelada",
};

function fitText(value: string, font: PDFFont, size: number, width: number) {
  const normalized = value.replace(/\s+/g, " ").trim() || "—";
  if (font.widthOfTextAtSize(normalized, size) <= width) return normalized;
  let result = normalized;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}…`, size) > width) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}

function drawHeader(page: PDFPage, regular: PDFFont, bold: PDFFont, dossier: EmployeeDossier) {
  page.drawText("DOSSIÊ DO COLABORADOR", { x: MARGIN, y: PAGE_HEIGHT - 50, size: 14, font: bold, color: blue });
  page.drawText(fitText(dossier.employeeName, bold, 13, CONTENT_WIDTH), { x: MARGIN, y: PAGE_HEIGHT - 72, size: 13, font: bold, color: ink });
  const subtitle = [dossier.positionName, dossier.companyName, `matrícula ${dossier.registrationNumber || "—"}`].filter(Boolean).join(" · ");
  page.drawText(fitText(subtitle, regular, 9, CONTENT_WIDTH), { x: MARGIN, y: PAGE_HEIGHT - 87, size: 9, font: regular, color: muted });
  page.drawLine({ start: { x: MARGIN, y: PAGE_HEIGHT - 98 }, end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 98 }, thickness: 0.8, color: line });
}

function drawFooter(page: PDFPage, regular: PDFFont, dossier: EmployeeDossier, pageNumber: number) {
  const issued = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(dossier.issuedAt);
  page.drawLine({ start: { x: MARGIN, y: 34 }, end: { x: PAGE_WIDTH - MARGIN, y: 34 }, thickness: 0.6, color: line });
  page.drawText(`Emitido em ${issued} · ${dossier.workspaceName}`, { x: MARGIN, y: 20, size: 7, font: regular, color: muted });
  const number = `Página ${pageNumber}`;
  page.drawText(number, { x: PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(number, 7), y: 20, size: 7, font: regular, color: muted });
}

function drawSectionTitle(page: PDFPage, bold: PDFFont, title: string, count: number | null, y: number) {
  page.drawRectangle({ x: MARGIN, y: y - 24, width: CONTENT_WIDTH, height: 24, color: surface });
  page.drawRectangle({ x: MARGIN, y: y - 24, width: 4, height: 24, color: blue });
  page.drawText(title.toUpperCase(), { x: MARGIN + 14, y: y - 16, size: 9, font: bold, color: blue });
  const countText = count === null ? "sem permissão" : count === 1 ? "1 registro" : `${count} registros`;
  page.drawText(countText, { x: PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize(countText, 8), y: y - 16, size: 8, font: bold, color: muted });
}

function drawRow(page: PDFPage, regular: PDFFont, columns: Array<{ text: string; x: number; width: number }>, y: number, index: number) {
  if (index % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - 20, width: CONTENT_WIDTH, height: 20, color: surface });
  for (const column of columns) page.drawText(fitText(column.text, regular, 8, column.width), { x: column.x, y: y - 14, size: 8, font: regular, color: ink });
  page.drawLine({ start: { x: MARGIN, y: y - 20 }, end: { x: PAGE_WIDTH - MARGIN, y: y - 20 }, thickness: 0.4, color: line });
}

const ROW_HEIGHT = 20;
const MIN_Y = 60;

export async function generateEmployeeDossierPdf(dossier: EmployeeDossier) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let pageNumber = 1;
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeader(page, regular, bold, dossier);
  let y = PAGE_HEIGHT - 118;

  const newPage = () => {
    drawFooter(page, regular, dossier, pageNumber);
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pageNumber += 1;
    drawHeader(page, regular, bold, dossier);
    y = PAGE_HEIGHT - 118;
  };

  const section = <T,>(title: string, items: T[] | null, toColumns: (item: T) => Array<{ text: string; x: number; width: number }>) => {
    if (y - 24 - ROW_HEIGHT < MIN_Y) newPage();
    drawSectionTitle(page, bold, title, items === null ? null : items.length, y);
    y -= 24 + 8;
    if (items === null) {
      page.drawText("Quem gerou este dossiê não tem permissão para consultar esta seção.", { x: MARGIN + 14, y: y - 12, size: 8, font: regular, color: muted });
      y -= ROW_HEIGHT + 12;
      return;
    }
    if (!items.length) {
      page.drawText("Nenhum registro.", { x: MARGIN + 14, y: y - 12, size: 8, font: regular, color: muted });
      y -= ROW_HEIGHT + 12;
      return;
    }
    items.forEach((item, index) => {
      if (y - ROW_HEIGHT < MIN_Y) {
        newPage();
        drawSectionTitle(page, bold, `${title} · continuação`, items.length, y);
        y -= 24 + 8;
      }
      drawRow(page, regular, toColumns(item), y, index);
      y -= ROW_HEIGHT;
    });
    y -= 14;
  };

  const col1 = MARGIN + 6;
  const col2 = MARGIN + 90;
  const col3 = MARGIN + 300;
  const col4 = MARGIN + 400;

  section("Entregas de EPI", dossier.epiDeliveries, (item) => [
    { text: dateOf(item.deliveredOn), x: col1, width: 78 },
    { text: item.productName, x: col2, width: 200 },
    { text: item.caNumber ? `CA ${item.caNumber}` : "—", x: col3, width: 90 },
    { text: `${epiStatusLabels[item.status] ?? item.status} · ${item.signatureName || "sem assinatura"}`, x: col4, width: PAGE_WIDTH - MARGIN - col4 },
  ]);

  section("Exames ocupacionais (ASO)", dossier.exams, (item) => [
    { text: dateOf(item.examDate), x: col1, width: 78 },
    { text: examTypeLabels[item.examType] ?? item.examType, x: col2, width: 150 },
    { text: examResultLabels[item.result] ?? item.result, x: col3, width: 120 },
    { text: item.nextDueDate ? `Próximo: ${dateOf(item.nextDueDate)}` : "Sem próxima data", x: col4, width: PAGE_WIDTH - MARGIN - col4 },
  ]);

  section("Treinamentos obrigatórios (NR)", dossier.trainings, (item) => [
    { text: dateOf(item.completedOn), x: col1, width: 78 },
    { text: item.trainingName, x: col2, width: 220 },
    { text: item.providerName || "—", x: col3, width: 100 },
    { text: item.validUntil ? `Válido até: ${dateOf(item.validUntil)}` : "Sem validade registrada", x: col4, width: PAGE_WIDTH - MARGIN - col4 },
  ]);

  drawFooter(page, regular, dossier, pageNumber);
  return pdf.save();
}
