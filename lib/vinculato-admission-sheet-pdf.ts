import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { RegistrationSheet, RegistrationSheetField } from "./employee-registration-form.ts";

export type VinculatoSheetProvenance = Record<string, { source?: "document" | "registry" | "manual" }>;

export type VinculatoAdmissionSheetPdfInput = {
  sheet: RegistrationSheet;
  provenance?: VinculatoSheetProvenance;
  sourceFilename?: string;
  generatedAt?: Date;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 38;
const GAP = 10;
const COLUMN_WIDTH = (PAGE_WIDTH - MARGIN * 2 - GAP) / 2;
const FIELD_HEIGHT = 43;
const navy = rgb(0.035, 0.102, 0.18);
const blue = rgb(0.11, 0.45, 0.76);
const ink = rgb(0.09, 0.14, 0.2);
const muted = rgb(0.39, 0.45, 0.52);
const line = rgb(0.83, 0.87, 0.91);
const surface = rgb(0.965, 0.977, 0.99);
const warning = rgb(0.72, 0.38, 0.05);

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  document: "Documento",
  registry: "Cadastro Vinculato",
  manual: "Conferência manual",
};

function compact(value: string | undefined) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function fit(value: string, font: PDFFont, size: number, width: number) {
  const normalized = compact(value) || "—";
  if (font.widthOfTextAtSize(normalized, size) <= width) return normalized;
  let result = normalized;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}…`, size) > width) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}

function fieldDisplay(field: RegistrationSheetField) {
  if (field.status === "ok") return field.value;
  if (field.status === "invalid") return "Conferir no documento";
  return "Não informado";
}

function drawPageHeader(page: PDFPage, regular: PDFFont, bold: PDFFont, input: VinculatoAdmissionSheetPdfInput) {
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 102, width: PAGE_WIDTH, height: 102, color: navy });
  page.drawText("VINCULATO", { x: MARGIN, y: PAGE_HEIGHT - 43, size: 18, font: bold, color: rgb(1, 1, 1) });
  page.drawText("FICHA DE ADMISSÃO", { x: MARGIN, y: PAGE_HEIGHT - 66, size: 10, font: bold, color: rgb(0.59, 0.8, 1) });
  page.drawText("Documento consolidado para conferência e cadastro no ERP", {
    x: MARGIN, y: PAGE_HEIGHT - 83, size: 7.6, font: regular, color: rgb(0.82, 0.88, 0.94),
  });

  const total = input.sheet.blocks.reduce((sum, block) => sum + block.fields.length, 0);
  const summary = `${input.sheet.readable} prontos • ${Math.max(0, total - input.sheet.readable)} pendentes`;
  const width = Math.min(235, bold.widthOfTextAtSize(summary, 8) + 22);
  page.drawRectangle({
    x: PAGE_WIDTH - MARGIN - width, y: PAGE_HEIGHT - 67, width, height: 25,
    color: blue, borderColor: rgb(0.42, 0.7, 0.96), borderWidth: 0.5,
  });
  page.drawText(fit(summary, bold, 8, width - 18), {
    x: PAGE_WIDTH - MARGIN - width + 9, y: PAGE_HEIGHT - 58, size: 8, font: bold, color: rgb(1, 1, 1),
  });
}

function drawField(page: PDFPage, regular: PDFFont, bold: PDFFont, input: VinculatoAdmissionSheetPdfInput,
  field: RegistrationSheetField, x: number, y: number) {
  const isReady = field.status === "ok";
  page.drawRectangle({
    x, y: y - FIELD_HEIGHT, width: COLUMN_WIDTH, height: FIELD_HEIGHT,
    color: isReady ? rgb(1, 1, 1) : surface,
    borderColor: field.status === "invalid" ? rgb(0.9, 0.65, 0.35) : line,
    borderWidth: 0.55,
  });
  page.drawText(fit(field.label.toUpperCase(), bold, 6.7, COLUMN_WIDTH - 18), {
    x: x + 9, y: y - 13, size: 6.7, font: bold, color: muted,
  });
  page.drawText(fit(fieldDisplay(field), isReady ? regular : bold, 9, COLUMN_WIDTH - 18), {
    x: x + 9, y: y - 28, size: 9, font: isReady ? regular : bold,
    color: field.status === "invalid" ? warning : ink,
  });
  const source = input.provenance?.[field.key]?.source;
  if (isReady && source) {
    page.drawText(SOURCE_LABELS[source] ?? "", {
      x: x + 9, y: y - 38, size: 5.7, font: regular, color: muted,
    });
  }
}

/** Emite a ficha limpa do Vinculato; o PDF original permanece como evidência. */
export async function buildVinculatoAdmissionSheetPdf(input: VinculatoAdmissionSheetPdfInput) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pages: PDFPage[] = [];
  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  drawPageHeader(page, regular, bold, input);
  let y = PAGE_HEIGHT - 128;

  const newPage = () => {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    drawPageHeader(page, regular, bold, input);
    y = PAGE_HEIGHT - 128;
  };

  for (const block of input.sheet.blocks) {
    const rows = Math.ceil(block.fields.length / 2);
    const blockHeight = 27 + rows * FIELD_HEIGHT + 9;
    if (y - blockHeight < 58) newPage();

    page.drawRectangle({ x: MARGIN, y: y - 23, width: PAGE_WIDTH - MARGIN * 2, height: 23, color: navy });
    page.drawText(block.label.toUpperCase(), { x: MARGIN + 10, y: y - 15, size: 8, font: bold, color: rgb(1, 1, 1) });
    y -= 28;

    for (let index = 0; index < block.fields.length; index += 2) {
      drawField(page, regular, bold, input, block.fields[index], MARGIN, y);
      if (block.fields[index + 1]) {
        drawField(page, regular, bold, input, block.fields[index + 1], MARGIN + COLUMN_WIDTH + GAP, y);
      }
      y -= FIELD_HEIGHT;
    }
    y -= 9;
  }

  const issuedAt = input.generatedAt ?? new Date();
  const issuedLabel = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo",
  }).format(issuedAt);
  pages.forEach((target, index) => {
    target.drawLine({ start: { x: MARGIN, y: 38 }, end: { x: PAGE_WIDTH - MARGIN, y: 38 }, thickness: 0.5, color: line });
    target.drawText(`Emitida pelo Vinculato em ${issuedLabel}`, { x: MARGIN, y: 24, size: 6.6, font: regular, color: muted });
    target.drawText(`Página ${index + 1} de ${pages.length}`, {
      x: PAGE_WIDTH - MARGIN - 55, y: 24, size: 6.6, font: regular, color: muted,
    });
  });

  document.setTitle("Ficha de admissão — Vinculato");
  document.setProducer("Vinculato");
  document.setSubject(compact(input.sourceFilename)
    ? `Consolidação da ficha ${compact(input.sourceFilename)}`
    : "Ficha consolidada de admissão");
  return Buffer.from(await document.save());
}
