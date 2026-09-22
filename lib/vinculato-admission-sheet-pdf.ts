import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { RegistrationSheet, RegistrationSheetField } from "./employee-registration-form.ts";

export type VinculatoSheetProvenance = Record<string, { source?: "document" | "registry" | "manual" }>;

/**
 * Sugestão lida por OCR de foto de documento (RG, CPF, CTPS) — mesma forma de
 * `PhotoOcrSuggestion` (lib/admission-sheet-photo-ocr-service.ts). Nunca vira
 * o valor do campo aqui: é impressa ao lado, marcada como não confirmada, pela
 * mesma razão de nunca escrever direto na ficha (ver lib/photo-document-fields.ts).
 */
export type VinculatoSheetPhotoSuggestion = {
  sourceFilename: string;
  fields: Record<string, { value: string; confidence: "ok" | "low" }>;
};

export type VinculatoAdmissionSheetPdfInput = {
  sheet: RegistrationSheet;
  provenance?: VinculatoSheetProvenance;
  photoSuggestions?: readonly VinculatoSheetPhotoSuggestion[];
  sourceFilename?: string;
  generatedAt?: Date;
};

type FieldSuggestion = { value: string; confidence: "ok" | "low"; sourceFilename: string };

/** Uma sugestão por campo, a de maior confiança quando mais de uma foto sugere o mesmo campo. */
function suggestionsByField(photoSuggestions: readonly VinculatoSheetPhotoSuggestion[] | undefined) {
  const byField = new Map<string, FieldSuggestion>();
  for (const photo of photoSuggestions ?? []) {
    for (const [key, field] of Object.entries(photo.fields)) {
      const current = byField.get(key);
      if (!current || (current.confidence === "low" && field.confidence === "ok")) {
        byField.set(key, { value: field.value, confidence: field.confidence, sourceFilename: photo.sourceFilename });
      }
    }
  }
  return byField;
}

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
const suggestion = rgb(0.42, 0.29, 0.64);

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
  field: RegistrationSheetField, x: number, y: number, fieldSuggestion: FieldSuggestion | undefined) {
  const isReady = field.status === "ok";
  const hasSuggestion = !isReady && Boolean(fieldSuggestion);
  page.drawRectangle({
    x, y: y - FIELD_HEIGHT, width: COLUMN_WIDTH, height: FIELD_HEIGHT,
    color: isReady ? rgb(1, 1, 1) : surface,
    borderColor: hasSuggestion ? suggestion : field.status === "invalid" ? rgb(0.9, 0.65, 0.35) : line,
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
  /* Sugestão da foto: nunca substitui o campo, só aparece ao lado do que está
     em branco/ilegível — o prefixo "Conferir:" e a cor própria (nunca a mesma
     de um valor confirmado) são o que impede alguém de ler isto como fato. */
  if (hasSuggestion && fieldSuggestion) {
    const label = fieldSuggestion.confidence === "low" ? "Conferir (sugestão, foto):" : "Conferir e confirmar (foto):";
    page.drawText(fit(`${label} ${fieldSuggestion.value}`, bold, 5.9, COLUMN_WIDTH - 18), {
      x: x + 9, y: y - 38, size: 5.9, font: bold, color: suggestion,
    });
  }
}

/** Emite a ficha limpa do Vinculato; o PDF original permanece como evidência. */
export async function buildVinculatoAdmissionSheetPdf(input: VinculatoAdmissionSheetPdfInput) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pages: PDFPage[] = [];
  const suggestionsByFieldKey = suggestionsByField(input.photoSuggestions);
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
      drawField(page, regular, bold, input, block.fields[index], MARGIN, y,
        suggestionsByFieldKey.get(block.fields[index].key));
      if (block.fields[index + 1]) {
        drawField(page, regular, bold, input, block.fields[index + 1], MARGIN + COLUMN_WIDTH + GAP, y,
          suggestionsByFieldKey.get(block.fields[index + 1].key));
      }
      y -= FIELD_HEIGHT;
    }
    y -= 9;
  }

  const issuedAt = input.generatedAt ?? new Date();
  const issuedLabel = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo",
  }).format(issuedAt);
  const hasAnySuggestion = suggestionsByFieldKey.size > 0;
  pages.forEach((target, index) => {
    target.drawLine({ start: { x: MARGIN, y: 38 }, end: { x: PAGE_WIDTH - MARGIN, y: 38 }, thickness: 0.5, color: line });
    target.drawText(`Emitida pelo Vinculato em ${issuedLabel}`, { x: MARGIN, y: 24, size: 6.6, font: regular, color: muted });
    target.drawText(`Página ${index + 1} de ${pages.length}`, {
      x: PAGE_WIDTH - MARGIN - 55, y: 24, size: 6.6, font: regular, color: muted,
    });
    /* Legenda da cor roxa: sem ela, "Conferir (sugestão, foto)" apareceria como
       mais um campo lido, e é exatamente o que este recurso nunca pode ser. */
    if (hasAnySuggestion) {
      target.drawText("Em roxo: lido por OCR de foto, ainda não confirmado — confira e corrija na tela antes do cadastro.", {
        x: MARGIN, y: 14, size: 6.2, font: bold, color: suggestion,
      });
    }
  });

  document.setTitle("Ficha de admissão — Vinculato");
  document.setProducer("Vinculato");
  document.setSubject(compact(input.sourceFilename)
    ? `Consolidação da ficha ${compact(input.sourceFilename)}`
    : "Ficha consolidada de admissão");
  return Buffer.from(await document.save());
}
