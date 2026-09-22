/**
 * Fatiamento de texto por rótulo conhecido, sem depender da ordem em que ele aparece.
 *
 * Extraído de `lib/registration-form-pdf.ts`, que já resolvia isso para o
 * Registro de Empregado. A técnica não é específica de PDF — serve para
 * qualquer texto (inclusive o que sai de OCR) sempre que o conjunto de rótulos
 * é fechado e conhecido de antemão. Ver `registration-form-pdf.ts` para a
 * explicação completa do algoritmo (âncoras, reserva de trecho, ordenação por
 * posição real).
 */

/** Acento e caixa somem, e o comprimento não muda — os índices continuam valendo. */
const FOLD: Readonly<Record<string, string>> = {
  á: "a", à: "a", ã: "a", â: "a", ä: "a", é: "e", ê: "e", è: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i", ó: "o", ô: "o", õ: "o", ò: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u", ç: "c", ñ: "n", º: "o", "°": "o", ª: "a",
};

export function foldKeepingLength(value: string) {
  let folded = "";
  for (const character of value.toLowerCase()) folded += FOLD[character] ?? character;
  return folded;
}

const isLetter = (character: string | undefined) => character !== undefined && /\p{L}/u.test(character);

/** Localiza o rótulo respeitando fronteira de palavra e trechos já reservados. */
function findLabel(haystack: string, needle: string, claimed: Array<{ start: number; end: number }>) {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return -1;
    const end = index + needle.length;
    const overlaps = claimed.some((span) => index < span.end && end > span.start);
    const boundedBefore = !isLetter(haystack[index - 1]);
    const boundedAfter = !isLetter(haystack[end]);
    if (!overlaps && boundedBefore && boundedAfter) return index;
    from = index + 1;
  }
}

/** Separador residual entre rótulo e valor, que o documento escreve de formas variadas. */
function trimValue(value: string) {
  return value.replace(/^[\s:.\-–—|]+/u, "").replace(/[\s:.\-–—|]+$/u, "").replace(/\s+/gu, " ").trim();
}

/**
 * Recusa o que tem cara de fatiamento errado.
 *
 * Um valor longo demais quer dizer que o próximo rótulo não foi encontrado e a
 * fatia engoliu o resto do texto. Um valor que contém outro rótulo quer dizer
 * que a fatia atravessou um campo. Nos dois casos a ausência é melhor do que o
 * conteúdo: campo vazio se denuncia a quem transcreve, campo errado não.
 */
function plausibleValue(value: string, maxValue: number, foldedLabels: readonly string[]) {
  if (!value || value.length > maxValue) return false;
  const folded = foldKeepingLength(value);
  return !foldedLabels.some((label) => folded.includes(label));
}

export type LabelSliceResult = { fields: Record<string, string>; warnings: string[]; found: number };

/**
 * Fatia `text` em campos, ancorando em `labels` (chave → rótulo exato).
 *
 * Recebe texto já extraído — assim a regra é testável sem PDF nem imagem, e a
 * extração (PDF, foto) não precisa repetir a regra.
 */
export function sliceByLabels(text: string, labels: Readonly<Record<string, string>>, maxValue = 220): LabelSliceResult {
  const warnings: string[] = [];
  if (!text.trim()) return { fields: {}, warnings: ["O documento não tem texto legível."], found: 0 };

  const folded = foldKeepingLength(text);
  const entries = Object.entries(labels).sort(([, a], [, b]) => b.length - a.length);

  const claimed: Array<{ start: number; end: number }> = [];
  const anchors: Array<{ key: string; start: number; end: number }> = [];
  for (const [key, label] of entries) {
    const index = findLabel(folded, foldKeepingLength(label), claimed);
    if (index < 0) {
      warnings.push(`Rótulo não encontrado no documento: ${label}.`);
      continue;
    }
    const span = { start: index, end: index + label.length };
    claimed.push(span);
    anchors.push({ key, ...span });
  }

  anchors.sort((a, b) => a.start - b.start);
  const foldedLabels = Object.values(labels).map(foldKeepingLength);

  const fields: Record<string, string> = {};
  anchors.forEach((anchor, index) => {
    const stop = anchors[index + 1]?.start ?? text.length;
    const value = trimValue(text.slice(anchor.end, stop));
    if (!value) return;
    if (!plausibleValue(value, maxValue, foldedLabels)) {
      warnings.push(`${labels[anchor.key]}: o trecho lido não parece ser o valor do campo.`);
      return;
    }
    fields[anchor.key] = value;
  });

  return { fields, warnings, found: anchors.length };
}
