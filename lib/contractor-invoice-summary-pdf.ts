import { A4, buildPdf, PdfPage, textWidth } from "./pdf-document.ts";

/**
 * Relação de líquidos em nota fiscal, em PDF.
 *
 * O extrato analítico abre a apuração rubrica a rubrica: ele responde "de onde
 * veio este número". Esta relação responde a outra pergunta, que é a do
 * pagamento — **quanto cada prestador vai emitir em nota nesta competência** —
 * e é o documento que se leva para a conferência dos avisos de NF, para o
 * financeiro e para a contabilidade.
 *
 * Por isso ela é uma lista, e não um bloco por pessoa: uma linha por
 * prestador, o valor à direita, o total no fim. É o desenho do relatório de
 * líquidos da folha, que quem confere já sabe ler de cima para baixo somando a
 * coluna com o dedo.
 *
 * Duas escolhas merecem registro:
 *
 *  - **o complemento não entra.** No PJ o total apurado sai por dois caminhos,
 *    nota fiscal e complemento, e este documento fala de um só. Somar os dois
 *    aqui faria a relação afirmar um valor de nota que ninguém vai emitir — e
 *    é exatamente o número que o prestador copia para dentro da nota dele. O
 *    cabeçalho diz isso em letras, para que nenhuma folha solta seja lida como
 *    o pagamento inteiro.
 *  - **a empresa abre o bloco, e não uma coluna.** A mesma pessoa presta
 *    serviço para mais de uma empresa do grupo, e cada uma recebe a sua nota:
 *    somar as duas numa linha só esconderia que são dois documentos a emitir.
 *    Então cada fechamento é uma linha, agrupada sob o nome da empresa que
 *    recebe aquelas notas — e quando o documento cobre mais de uma, cada bloco
 *    fecha o seu subtotal antes do total do grupo. Repetir a empresa em toda
 *    linha diria a mesma coisa tirando a largura do nome do prestador, que é o
 *    que se lê.
 */

export type InvoiceSummaryLine = {
  codigo: string;
  prestador: string;
  cnpj: string;
  situacao: string;
  valor: number;
};

export type InvoiceSummaryGroup = {
  empresa: string;
  linhas: InvoiceSummaryLine[];
  total: number;
};

export type InvoiceSummaryDocument = {
  empresa: string;
  cnpjEmpresa: string;
  competencia: string;
  competenciaLabel: string;
  periodo: string;
  emitidoEm: string;
  emitidoPor: string;
  grupos: InvoiceSummaryGroup[];
  /** Quantas notas a competência tem — uma por linha, não por prestador. */
  quantidade: number;
  total: number;
  /** Só há subtotal por empresa quando há mais de uma: com uma só, o subtotal
   *  repetiria o total logo abaixo dele. O título da empresa abre o bloco nos
   *  dois casos — é ele que diz de quem é a nota, e é o que permite a coluna
   *  de empresa não existir na tabela. */
  agrupadoPorEmpresa: boolean;
};

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);

/** Proteção contra adulteração, como na folha: asteriscos até a largura fixa,
 *  o que impede acrescentar um dígito à esquerda depois de impresso. */
const protectedMoney = (value: number) => {
  const text = money(value);
  return `${"*".repeat(Math.max(0, 14 - text.length))}${text}`;
};

const MARGIN = 28;
const LINE = 11;
const BODY = 7.4;

const RIGHT = A4.width - MARGIN;

/* As colunas, em pontos. A de valor é posição de TÉRMINO: número alinha à
   direita, senão a coluna deixa de ser coluna. */
const COL = {
  codigo: MARGIN + 4,
  prestador: MARGIN + 96,
  cnpj: MARGIN + 320,
  situacao: MARGIN + 418,
  valor: RIGHT - 4,
} as const;

/* A largura reservada ao valor. O maior número plausível numa competência —
   "216.615,18" — ocupa 37 pontos no corpo do documento; o resto é a folga que
   separa a situação do número, e é ela que faz a coluna parecer coluna. */
const VALOR = 52;

class SummaryBuilder {
  readonly pages: PdfPage[] = [];
  private page!: PdfPage;
  private y = 0;
  private pageNumber = 0;
  private readonly documento: InvoiceSummaryDocument;

  constructor(documento: InvoiceSummaryDocument) {
    this.documento = documento;
    this.newPage();
  }

  private get remaining() {
    return this.y - (MARGIN + 24);
  }

  private newPage() {
    this.pageNumber += 1;
    this.page = new PdfPage(A4.width, A4.height);
    this.pages.push(this.page);
    this.y = A4.height - MARGIN;
    this.drawHeader();
  }

  private ensure(needed: number) {
    if (this.remaining < needed) this.newPage();
  }

  private drawHeader() {
    const { documento } = this;
    this.page.textCenter("RELAÇÃO DE LÍQUIDOS EM NOTA FISCAL", A4.width / 2, this.y, { font: "helvetica-bold", size: 9.5 });
    this.y -= 14;

    // A caixa se repete em toda página: quem recebe uma folha solta precisa
    // saber de que grupo e de que competência ela é.
    const boxTop = this.y;
    const boxHeight = 40;
    this.page.rect(MARGIN, boxTop - boxHeight, RIGHT - MARGIN, boxHeight, 0.8);
    let linha = boxTop - 11;
    this.page.text(`Empresa : ${documento.empresa}`, MARGIN + 5, linha, { font: "helvetica-bold", size: 8 });
    this.page.textRight(`Página : ${String(this.pageNumber).padStart(5, "0")}`, RIGHT - 5, linha, { size: 8 });
    linha -= 13;
    this.page.text(`CNPJ : ${documento.cnpjEmpresa}`, MARGIN + 5, linha, { size: 8 });
    this.page.textRight(`Competência : ${documento.competenciaLabel}`, RIGHT - 5, linha, { size: 8 });
    linha -= 13;
    this.page.text(`Ref.: ${documento.periodo}`, MARGIN + 5, linha, { size: 8 });
    this.page.textRight(`Emitido em ${documento.emitidoEm} por ${documento.emitidoPor}`, RIGHT - 5, linha, { size: 7.2 });
    this.y = boxTop - boxHeight - 10;

    /* O aviso não é decoração: sem ele a folha é lida como o pagamento inteiro,
       e o complemento — que sai por outro caminho — apareceria como diferença
       inexplicada na conferência. */
    this.page.text(
      "SOMENTE O VALOR A EMITIR EM NOTA FISCAL NA COMPETÊNCIA. O COMPLEMENTO É PAGO POR OUTRO CAMINHO E NÃO ENTRA NESTA RELAÇÃO.",
      MARGIN, this.y, { size: 6.8 },
    );
    this.y -= 12;

    this.drawColumnHeader();
  }

  private drawColumnHeader() {
    const top = this.y;
    const height = 15;
    this.page.rect(MARGIN, top - height, RIGHT - MARGIN, height, 0.8);
    const base = top - 10.5;
    const opcoes = { font: "helvetica-bold", size: 7.2 } as const;
    this.page.text("Código", COL.codigo, base, opcoes);
    this.page.text("Prestador", COL.prestador, base, opcoes);
    this.page.text("CNPJ", COL.cnpj, base, opcoes);
    this.page.text("Situação da NF", COL.situacao, base, opcoes);
    this.page.textRight("Valor da NF", COL.valor, base, opcoes);
    this.y = top - height - 3;
  }

  addGroup(grupo: InvoiceSummaryGroup) {
    /* A empresa é título do bloco, e não coluna repetida em cada linha: ela é
       a mesma para todo o bloco, e uma coluna que repete o mesmo texto em
       trinta linhas só tira largura do nome do prestador — que é o que se lê.
       O título nunca fica sozinho no pé da página: uma folha que termina
       anunciando uma empresa e não mostra ninguém dela faz quem confere
       procurar linhas que estão na página seguinte. */
    this.ensure(LINE * 3);
    this.page.text(grupo.empresa.toLocaleUpperCase("pt-BR"), COL.codigo, this.y - 8, { font: "helvetica-bold", size: 7.6 });
    this.y -= LINE + 2;

    for (const linha of grupo.linhas) {
      this.ensure(LINE + 8);
      const base = this.y - 8;
      /* Cortar por número de caracteres mede a coisa errada: catorze "M" não
         cabem onde catorze "i" sobram. A conta é a largura real do texto. */
      this.page.text(this.fit(linha.codigo, COL.prestador - 8 - COL.codigo, BODY), COL.codigo, base, { size: BODY });
      this.page.text(this.fit(linha.prestador, COL.cnpj - 8 - COL.prestador, BODY), COL.prestador, base, { size: BODY });
      this.page.text(this.fit(linha.cnpj, COL.situacao - 8 - COL.cnpj, BODY), COL.cnpj, base, { size: BODY });
      this.page.text(this.fit(linha.situacao, COL.valor - VALOR - COL.situacao, BODY), COL.situacao, base, { size: BODY });
      this.page.textRight(money(linha.valor), COL.valor, base, { size: BODY });
      this.y -= LINE;
    }

    if (this.documento.agrupadoPorEmpresa) {
      this.ensure(LINE + 10);
      this.page.line(COL.situacao, this.y - 2, COL.valor, this.y - 2, 0.6);
      this.y -= 4;
      const base = this.y - 8;
      const rotulo = `Subtotal ${grupo.empresa} — ${grupo.linhas.length} nota(s)`;
      const fim = COL.valor - VALOR - 8;
      this.page.textRight(this.fit(rotulo, fim - COL.codigo, BODY, "helvetica-bold"), fim, base,
        { font: "helvetica-bold", size: BODY });
      this.page.textRight(money(grupo.total), COL.valor, base, { font: "helvetica-bold", size: BODY });
      this.y -= LINE + 6;
    }
  }

  /** O fecho da competência, no mesmo quadro do extrato analítico. */
  addTotals() {
    const { documento } = this;
    this.ensure(3 * LINE + 30);
    const top = this.y - 6;
    const altura = 2 * LINE + 12;
    this.page.labelledBox(MARGIN, top - altura, RIGHT - MARGIN, altura,
      `TOTAL DA COMPETÊNCIA — ${documento.quantidade} nota(s) fiscal(is)`, { size: 7.6, thickness: 0.9 });
    let linha = top - 16;
    this.page.text("Notas fiscais a emitir", MARGIN + 12, linha, { size: 7.6 });
    this.page.textRight(String(documento.quantidade), RIGHT - 12, linha, { size: 7.6 });
    linha -= LINE;
    this.page.text("Valor total a emitir em nota fiscal", MARGIN + 12, linha, { font: "helvetica-bold", size: 7.6 });
    this.page.textRight(protectedMoney(documento.total), RIGHT - 12, linha, { font: "courier", size: 7.6 });
    this.y = top - altura - 8;
  }

  /** A folha sem ninguém diz por que está vazia. Uma página só com cabeçalho
   *  parece documento truncado, e quem recebe volta para perguntar. */
  addEmptyNote() {
    this.page.text(
      "Nenhum prestador tem valor a emitir em nota fiscal nesta competência.",
      COL.codigo, this.y - 10, { size: 7.6 },
    );
    this.y -= 20;
  }

  /** Corta o texto que não cabe na coluna, com reticências. */
  private fit(text: string, width: number, size: number, font: "helvetica" | "helvetica-bold" = "helvetica") {
    if (textWidth(text, font, size) <= width) return text;
    let cut = text;
    while (cut.length > 1 && textWidth(`${cut}...`, font, size) > width) cut = cut.slice(0, -1);
    return `${cut}...`;
  }
}

/** Monta o PDF da relação de líquidos em nota fiscal. */
export function renderInvoiceSummary(documento: InvoiceSummaryDocument) {
  const builder = new SummaryBuilder(documento);
  if (documento.quantidade === 0) builder.addEmptyNote();
  for (const grupo of documento.grupos) builder.addGroup(grupo);
  if (documento.quantidade > 0) builder.addTotals();
  return buildPdf(builder.pages, `Líquidos em nota fiscal ${documento.competencia}`);
}
