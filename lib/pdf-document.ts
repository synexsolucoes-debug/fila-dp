/**
 * Gerador de PDF mínimo, sem dependência.
 *
 * O projeto precisa emitir um documento de conferência com layout fixo — caixa
 * de cabeçalho, colunas alinhadas, réguas, números à direita. Três caminhos
 * foram considerados:
 *
 *  - **uma biblioteca de PDF**: `pdfkit` traz fontes e streams do Node, e
 *    `pdf-lib` é de baixo nível o bastante para não poupar quase nada do
 *    trabalho de layout. Nenhuma das duas resolve o que dá trabalho aqui, que é
 *    posicionar a tabela.
 *  - **HTML com folha de impressão**: não emite arquivo, abre a caixa de
 *    diálogo do navegador. Quem precisa anexar o extrato a um processo de
 *    conferência quer um arquivo, não um passo manual.
 *  - **navegador sem interface no servidor**: o Playwright já está no projeto,
 *    mas para o conector Sankhya, que roda em worker. Uma rota de painel em
 *    serverless não sobe navegador.
 *
 * Então o PDF é escrito à mão. Para um documento de texto, réguas e retângulos
 * isso é pequeno: o formato é uma lista de objetos numerados, um fluxo de
 * conteúdo com operadores de texto e linha, e uma tabela de referências no fim.
 *
 * As fontes são as três padrão do PDF (Helvetica, Helvetica-Bold, Courier), que
 * todo leitor tem e que não precisam ser embutidas. A tabela de larguras
 * abaixo é a métrica oficial da Helvetica — sem ela não há como alinhar número
 * à direita nem centralizar título, que é metade do que faz o documento
 * parecer um documento.
 */

const HELVETICA_WIDTHS: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "[": 278, "\\": 278, "]": 278, "^": 469, _: 556, "`": 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  "{": 334, "|": 260, "}": 334, "~": 584,
};

const HELVETICA_BOLD_WIDTHS: Record<string, number> = {
  ...HELVETICA_WIDTHS,
  A: 722, B: 722, D: 722, E: 667, J: 556, K: 722, L: 611, R: 722,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  ":": 333, ";": 333, "'": 238, "-": 333,
};

/** Letra sem acento, para reaproveitar a largura da base. Em Helvetica o
 *  acento não muda o avanço: "á" ocupa o mesmo que "a". */
const BASE_LETTER: Record<string, string> = {
  á: "a", à: "a", ã: "a", â: "a", ä: "a", é: "e", ê: "e", è: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i", ó: "o", ò: "o", õ: "o", ô: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u", ç: "c", ñ: "n", ý: "y",
  Á: "A", À: "A", Ã: "A", Â: "A", Ä: "A", É: "E", Ê: "E", È: "E", Ë: "E",
  Í: "I", Ì: "I", Î: "I", Ï: "I", Ó: "O", Ò: "O", Õ: "O", Ô: "O", Ö: "O",
  Ú: "U", Ù: "U", Û: "U", Ü: "U", Ç: "C", Ñ: "N",
  "º": "o", "ª": "a", "–": "-", "—": "-", "→": "-", "·": ".",
};

export type PdfFont = "helvetica" | "helvetica-bold" | "courier";

/** Largura do texto em pontos, para a fonte e o corpo dados. */
export function textWidth(text: string, font: PdfFont, size: number) {
  // Courier é monoespaçada: todo glifo avança 600/1000 do corpo.
  if (font === "courier") return text.length * 0.6 * size;
  const table = font === "helvetica-bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const character of text) {
    const width = table[character] ?? table[BASE_LETTER[character] ?? ""] ?? 556;
    total += width;
  }
  return (total / 1000) * size;
}

/**
 * Texto do PDF em Latin-1, que é o que a codificação WinAnsi das fontes padrão
 * entende. Caractere fora dela vira a base sem acento em vez de virar lixo —
 * um "?" no meio de um nome próprio num documento de conferência é pior que a
 * letra sem acento.
 */
function encodeText(text: string) {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 63;
    const usable = code <= 0xff ? character : (BASE_LETTER[character] ?? "?");
    for (const piece of usable) {
      const value = piece.codePointAt(0) ?? 63;
      if (piece === "(" || piece === ")" || piece === "\\") out += `\\${piece}`;
      else if (value < 32 || value > 0xff) out += "?";
      else if (value > 126) out += `\\${value.toString(8).padStart(3, "0")}`;
      else out += piece;
    }
  }
  return out;
}

const FONT_RESOURCE: Record<PdfFont, string> = {
  helvetica: "F1",
  "helvetica-bold": "F2",
  courier: "F3",
};

/** Uma página em construção: acumula operadores do fluxo de conteúdo. */
export class PdfPage {
  private readonly operations: string[] = [];
  readonly width: number;
  readonly height: number;

  /* Campos declarados e atribuídos, em vez de propriedade de parâmetro: o
     `--experimental-strip-types` do Node só remove anotações, e a forma
     `constructor(readonly x: number)` gera código em vez de sumir. O runner de
     testes do projeto roda nesse modo. */
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** Texto com o canto inferior esquerdo em (x, y), medido em pontos. */
  text(value: string, x: number, y: number, options: { font?: PdfFont; size?: number } = {}) {
    const font = options.font ?? "helvetica";
    const size = options.size ?? 8;
    this.operations.push(
      `BT /${FONT_RESOURCE[font]} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${encodeText(value)}) Tj ET`,
    );
    return this;
  }

  /** Texto terminando em `x` — é assim que coluna de valor fica alinhada. */
  textRight(value: string, x: number, y: number, options: { font?: PdfFont; size?: number } = {}) {
    const font = options.font ?? "helvetica";
    const size = options.size ?? 8;
    return this.text(value, x - textWidth(value, font, size), y, options);
  }

  /** Texto centrado em `x`. */
  textCenter(value: string, x: number, y: number, options: { font?: PdfFont; size?: number } = {}) {
    const font = options.font ?? "helvetica";
    const size = options.size ?? 8;
    return this.text(value, x - textWidth(value, font, size) / 2, y, options);
  }

  line(x1: number, y1: number, x2: number, y2: number, thickness = 0.5) {
    this.operations.push(
      `${thickness.toFixed(2)} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    );
    return this;
  }

  rect(x: number, y: number, width: number, height: number, thickness = 0.5) {
    this.operations.push(
      `${thickness.toFixed(2)} w ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S`,
    );
    return this;
  }

  /**
   * Caixa cujo rótulo interrompe a borda de cima, como nos quadros da folha.
   *
   * Desenhar o retângulo e escrever por cima faz a linha atravessar o texto —
   * some com a perna do "p" e o rótulo fica sujo. Aqui a borda superior é
   * desenhada em dois trechos, com o vão exato do rótulo no meio.
   */
  labelledBox(
    x: number, y: number, width: number, height: number, label: string,
    options: { font?: PdfFont; size?: number; indent?: number; thickness?: number } = {},
  ) {
    const font = options.font ?? "helvetica-bold";
    const size = options.size ?? 7;
    const indent = options.indent ?? 8;
    const thickness = options.thickness ?? 0.6;
    const top = y + height;
    const gap = textWidth(label, font, size) + 6;
    this.line(x, top, x + indent - 3, top, thickness);
    this.line(x + indent + gap - 3, top, x + width, top, thickness);
    this.line(x, y, x + width, y, thickness);
    this.line(x, y, x, top, thickness);
    this.line(x + width, y, x + width, top, thickness);
    this.text(label, x + indent, top - size / 2 - 0.5, { font, size });
    return this;
  }

  get content() {
    return this.operations.join("\n");
  }
}

/** A4 em pontos, que é a unidade do PDF (72 por polegada). */
export const A4 = { width: 595.28, height: 841.89 } as const;

/**
 * Monta o arquivo.
 *
 * A estrutura é a mínima que um leitor aceita: catálogo, árvore de páginas, as
 * páginas com o fluxo de conteúdo, as três fontes e a tabela de referências
 * cruzadas com o deslocamento de cada objeto em bytes — daí o cuidado de medir
 * em `latin1`, e não em caracteres.
 */
export function buildPdf(pages: PdfPage[], title: string) {
  if (pages.length === 0) throw new Error("Um PDF precisa de ao menos uma página.");
  const objects: string[] = [];
  const push = (body: string) => { objects.push(body); return objects.length; };

  const fontIds = [
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
  ];
  const resources = `<< /Font << /F1 ${fontIds[0]} 0 R /F2 ${fontIds[1]} 0 R /F3 ${fontIds[2]} 0 R >> >>`;

  // O número da árvore de páginas é conhecido antes de existir: as páginas
  // precisam apontar para o pai, e o pai precisa listar os filhos.
  const pagesId = objects.length + 1 + pages.length * 2;
  const pageIds: number[] = [];
  for (const page of pages) {
    const contentId = push(`<< /Length ${Buffer.byteLength(page.content, "latin1")} >>\nstream\n${page.content}\nendstream`);
    pageIds.push(push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}]`
      + ` /Resources ${resources} /Contents ${contentId} 0 R >>`,
    ));
  }
  const realPagesId = push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  if (realPagesId !== pagesId) throw new Error("A árvore de páginas saiu do lugar previsto.");
  const catalogId = push(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const infoId = push(`<< /Title (${encodeText(title)}) /Producer (Vinculato) >>`);

  let file = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(file, "latin1"));
    file += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(file, "latin1");
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) file += `${String(offset).padStart(10, "0")} 00000 n \n`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`;
  file += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(file, "latin1");
}
