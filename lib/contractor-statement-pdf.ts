import { A4, buildPdf, PdfPage, textWidth } from "./pdf-document.ts";

/**
 * Extrato analítico de pagamento PJ, no formato da folha analítica.
 *
 * O modelo é a folha de pagamento analítica que o escritório já usa para
 * conferir CLT: caixa de cabeçalho repetida por página, uma linha por rubrica,
 * régua de totais, um quadro de resumo por pessoa e um rodapé com as bases.
 * Quem confere já sabe ler esse desenho — mudar o desenho custaria mais que
 * mudar o conteúdo.
 *
 * O que muda é o fecho. Na folha CLT a última coluna é o **líquido**: um número
 * só, que é o que a pessoa recebe. No PJ o pagamento sai por dois caminhos, e é
 * essa separação que a conferência precisa enxergar:
 *
 *     valor a emitir em nota fiscal  +  complemento  =  total apurado
 *
 * A identidade é exata e vem do próprio cálculo: a nota é o líquido regular
 * limitado pelo teto do contrato, e o complemento é o que sobra desse teto mais
 * a diferença fixa. Por isso as duas colunas substituem "Líquido" e o quadro de
 * resumo fecha nas duas linhas em vez de uma.
 *
 * O complemento é mostrado com a forma pela qual ele sai — Caju Saldo Livre na
 * maioria dos contratos. Quando a forma é outra, o documento diz qual: somar o
 * complemento como se fosse sempre Caju faria o extrato afirmar um destino que
 * o cadastro não confirma.
 */

export type StatementLine = {
  rubrica: string;
  descricao: string;
  referencia: string;
  proventos: number;
  descontos: number;
  cancelado: boolean;
};

export type StatementProvider = {
  codigo: string;
  nome: string;
  cnpj: string;
  contrato: string;
  funcao: string;
  valorContrato: number;
  linhas: StatementLine[];
  totalProventos: number;
  totalDescontos: number;
  totalApurado: number;
  valorNotaFiscal: number;
  complemento: number;
  formaComplemento: string;
  limiteNotaFiscal: number | null;
  origemLimite: string;
  statusNotaFiscal: string;
  statusFechamento: string;
};

export type StatementDocument = {
  empresa: string;
  cnpjEmpresa: string;
  competencia: string;
  competenciaLabel: string;
  periodo: string;
  emitidoEm: string;
  emitidoPor: string;
  prestadores: StatementProvider[];
};

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);

/** Proteção contra adulteração, como na folha: o valor vem precedido de
 *  asteriscos até uma largura fixa, o que impede acrescentar um dígito à
 *  esquerda depois de impresso. */
const protectedMoney = (value: number) => {
  const text = money(value);
  return `${"*".repeat(Math.max(0, 14 - text.length))}${text}`;
};

const MARGIN = 28;
const LINE = 11.2;
const BODY = 7.6;

const RIGHT = A4.width - MARGIN;

/* As colunas, em pontos. As de valor são posições de TÉRMINO: número alinha à
   direita, senão a coluna deixa de ser coluna.
   Toda coluna declarada no cabeçalho é preenchida em algum lugar do bloco —
   "Valor NF" e "Complemento" na linha de totais do prestador, como o líquido
   na folha. Anunciar coluna que nunca recebe valor é pior que não ter a
   coluna: quem confere procura o número e conclui que faltou. */
const COL = {
  codigo: MARGIN + 4,
  nome: MARGIN + 62,
  referencia: MARGIN + 272,
  proventos: MARGIN + 342,
  descontos: MARGIN + 412,
  notaFiscal: MARGIN + 478,
  complemento: RIGHT - 4,
} as const;

class StatementBuilder {
  readonly pages: PdfPage[] = [];
  private page!: PdfPage;
  private y = 0;
  private pageNumber = 0;
  private readonly documento: StatementDocument;

  constructor(documento: StatementDocument) {
    this.documento = documento;
    this.newPage();
  }

  /** Espaço restante antes do rodapé da página. */
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

  /** Garante `needed` pontos de espaço; abre página nova quando não há. */
  private ensure(needed: number) {
    if (this.remaining < needed) this.newPage();
  }

  private drawHeader() {
    const { documento } = this;
    this.page.textCenter("EXTRATO ANALÍTICO DE PAGAMENTO PJ", A4.width / 2, this.y, { font: "helvetica-bold", size: 9.5 });
    this.y -= 14;

    // A caixa do cabeçalho, com o mesmo conteúdo em toda página: quem recebe
    // uma folha solta precisa saber de que empresa e competência ela é.
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

    this.page.text(
      "VALORES DA APURAÇÃO DA COMPETÊNCIA. O VALOR EM NOTA FISCAL SOMADO AO COMPLEMENTO É O TOTAL APURADO.",
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
    this.page.text("Rubrica / Descrição", COL.nome, base, opcoes);
    this.page.textRight("Ref.", COL.referencia, base, opcoes);
    this.page.textRight("Proventos", COL.proventos, base, opcoes);
    this.page.textRight("Descontos", COL.descontos, base, opcoes);
    this.page.textRight("Valor NF", COL.notaFiscal, base, opcoes);
    this.page.textRight("Complemento", COL.complemento, base, opcoes);
    this.y = top - height - 3;
  }

  /** Altura que um prestador ocupa inteiro, para não quebrar no meio dele. */
  private heightOf(prestador: StatementProvider) {
    return 24 + prestador.linhas.length * LINE + 12 + 6 * LINE + 20;
  }

  addProvider(prestador: StatementProvider) {
    /* Um prestador cabe inteiro numa página ou começa na próxima. Partir o
       quadro de resumo ao meio deixaria uma folha com números sem fecho, que é
       exatamente o que ninguém consegue conferir. Só quando o prestador é
       maior que uma página é que ele parte — e aí não há escolha. */
    const altura = this.heightOf(prestador);
    if (altura < A4.height - 180) this.ensure(altura);
    else this.ensure(60);

    /* Identificação em duas linhas, e nada dela invade as colunas de valor:
       o valor do contrato não aparece aqui porque ele é a primeira rubrica do
       bloco, e repeti-lo faria a mesma quantia surgir duas vezes na folha. */
    this.page.text(prestador.codigo, COL.codigo, this.y - 8, { font: "helvetica-bold", size: 8 });
    this.page.text(this.fit(prestador.nome, COL.referencia - 20 - COL.nome, 8, "helvetica-bold"),
      COL.nome, this.y - 8, { font: "helvetica-bold", size: 8 });
    this.page.textRight(`Contrato : ${prestador.contrato || "Sem referência"}`, COL.complemento, this.y - 8, { size: 7.4 });
    this.y -= 10.5;
    this.page.text(`CNPJ : ${prestador.cnpj}`, COL.nome, this.y - 8, { size: 7.2 });
    this.page.text(`Função : ${prestador.funcao || "Não informada"}`, COL.nome + 122, this.y - 8, { size: 7.2 });
    this.page.textRight(`Situação : ${prestador.statusFechamento}`, COL.complemento, this.y - 8, { size: 7.2 });
    this.y -= 13;

    // Rubricas
    for (const linha of prestador.linhas) {
      this.ensure(LINE + 8);
      const base = this.y - 8;
      this.page.text(linha.rubrica.slice(0, 14), COL.codigo, base, { size: BODY });
      const descricao = linha.descricao + (linha.cancelado ? "  (cancelado)" : "");
      this.page.text(this.fit(descricao, COL.referencia - 10 - COL.nome, BODY), COL.nome, base, { size: BODY });
      if (linha.referencia) this.page.text(linha.referencia, COL.referencia, base, { size: BODY });
      /* Valor cancelado sai riscado.
         O rótulo "(cancelado)" na descrição não basta: o número fica na mesma
         coluna dos vivos, e quem soma a coluna com o dedo chega a um total que
         não é o do quadro de fecho. O traço tira a dúvida sem tirar o dado,
         que precisa continuar visível para explicar a diferença entre o que
         foi lançado e o que foi apurado. */
      const valor = linha.proventos || linha.descontos;
      const coluna = linha.proventos ? COL.proventos : COL.descontos;
      if (valor) {
        this.page.textRight(money(valor), coluna, base, { size: BODY });
        if (linha.cancelado) {
          const largura = textWidth(money(valor), "helvetica", BODY);
          this.page.line(coluna - largura, base + 2.4, coluna, base + 2.4, 0.5);
        }
      }
      this.y -= LINE;
    }

    /* Régua e totais, como na folha — e é aqui que "Valor NF" e "Complemento"
       recebem valor, no lugar onde a folha CLT põe o líquido. */
    this.ensure(LINE + 8);
    this.page.line(COL.proventos - 62, this.y - 2, COL.complemento, this.y - 2, 0.6);
    this.y -= 2;
    const totais = this.y - 9.5;
    this.page.textRight(money(prestador.totalProventos), COL.proventos, totais, { size: BODY });
    this.page.textRight(money(prestador.totalDescontos), COL.descontos, totais, { size: BODY });
    this.page.textRight(money(prestador.valorNotaFiscal), COL.notaFiscal, totais, { font: "helvetica-bold", size: BODY });
    this.page.textRight(money(prestador.complemento), COL.complemento, totais, { font: "helvetica-bold", size: BODY });
    this.y -= LINE + 5;

    this.addSummary(prestador);
  }

  /** O quadro de fecho. É aqui que o PJ difere da folha: duas saídas em vez de
   *  um líquido, e a soma das duas é o total apurado. */
  private addSummary(prestador: StatementProvider) {
    const altura = 6 * LINE + 10;
    this.ensure(altura + 20);
    const top = this.y;
    const largura = 268;
    const x = RIGHT - largura;
    this.page.labelledBox(x, top - altura, largura, altura, "Resumo do pagamento");

    /* Os três primeiros decompõem a apuração, com a notação da folha. Os dois
       últimos não são mais uma etapa da conta: são os dois caminhos por onde o
       mesmo total sai. Por isso vêm depois de uma régua e sem marcador — um
       segundo "(=)" faria parecer que a conta continua. */
    const decomposicao: Array<[string, number]> = [
      ["(+) Proventos", prestador.totalProventos],
      ["(-) Descontos", prestador.totalDescontos],
      ["(=) Total apurado", prestador.totalApurado],
    ];
    const saidas: Array<[string, number]> = [
      ["Valor a emitir em nota fiscal", prestador.valorNotaFiscal],
      [`Complemento — ${prestador.formaComplemento}`, prestador.complemento],
    ];
    // Os dois-pontos numa coluna só: sem isso o olho procura o valor em cinco
    // alturas diferentes.
    const colunaDoisPontos = x + 172;
    let linha = top - 14;
    for (const [rotulo, valor] of decomposicao) {
      this.leader(rotulo, valor, x + 8, colunaDoisPontos, x + largura - 8, linha, false);
      linha -= LINE;
    }
    this.page.line(x + 8, linha + 7, x + largura - 8, linha + 7, 0.4);
    linha -= 2;
    for (const [rotulo, valor] of saidas) {
      this.leader(rotulo, valor, x + 8, colunaDoisPontos, x + largura - 8, linha, true);
      linha -= LINE;
    }
    this.y = top - altura - 6;

    // Rodapé do prestador: as bases da conferência, no lugar das bases de INSS
    // e FGTS da folha, que não existem em PJ.
    const base = this.y - 8;
    const limite = prestador.limiteNotaFiscal === null ? "Sem limite" : money(prestador.limiteNotaFiscal);
    this.page.text(`Limite da NF   ${limite}`, COL.codigo, base, { size: 7 });
    this.page.text(`Origem   ${prestador.origemLimite}`, COL.nome + 60, base, { size: 7 });
    this.page.text(`Status da NF   ${prestador.statusNotaFiscal}`, COL.nome + 200, base, { size: 7 });
    this.page.textRight(`Apurado ${money(prestador.totalApurado)}`, RIGHT - 4, base, { size: 7 });
    this.y -= 14;
    this.page.line(MARGIN, this.y, RIGHT, this.y, 0.4);
    this.y -= 6;
  }

  /** Fecho da competência: o mesmo par de saídas, somado. */
  addTotals() {
    const { prestadores } = this.documento;
    const soma = (campo: (item: StatementProvider) => number) =>
      prestadores.reduce((total, item) => total + campo(item), 0);
    this.ensure(6 * LINE + 30);
    const top = this.y - 4;
    const altura = 5 * LINE + 12;
    this.page.labelledBox(MARGIN, top - altura, RIGHT - MARGIN, altura,
      `TOTAL DA COMPETÊNCIA — ${prestadores.length} prestador(es)`, { size: 7.6, thickness: 0.9 });
    const linhas: Array<[string, number, boolean]> = [
      ["Proventos", soma((item) => item.totalProventos), false],
      ["Descontos", soma((item) => item.totalDescontos), false],
      ["Total apurado", soma((item) => item.totalApurado), false],
      ["Valor a emitir em nota fiscal", soma((item) => item.valorNotaFiscal), true],
      ["Complemento", soma((item) => item.complemento), true],
    ];
    let linha = top - 16;
    for (const [rotulo, valor, destaque] of linhas) {
      this.page.text(rotulo, MARGIN + 12, linha, { font: destaque ? "helvetica-bold" : "helvetica", size: 7.6 });
      this.page.textRight(destaque ? protectedMoney(valor) : money(valor), RIGHT - 12, linha,
        { font: destaque ? "courier" : "helvetica", size: 7.6 });
      linha -= LINE;
    }
    this.y = top - altura - 8;
  }

  /** Rótulo, condutor de pontos até uma coluna fixa, e valor à direita. */
  private leader(rotulo: string, valor: number, x: number, colon: number, right: number, y: number, destaque: boolean) {
    const fonte = destaque ? "helvetica-bold" : "helvetica";
    const size = 7.2;
    this.page.text(rotulo, x, y, { font: fonte, size });
    const inicio = x + textWidth(rotulo, fonte, size) + 3;
    const pontos = Math.max(0, Math.floor((colon - inicio) / textWidth(".", "helvetica", size)));
    if (pontos > 0) this.page.text(".".repeat(pontos), inicio, y, { size });
    this.page.text(":", colon + 2, y, { size });
    this.page.textRight(destaque ? protectedMoney(valor) : money(valor), right, y,
      { font: destaque ? "courier" : "helvetica", size });
  }

  /** Corta o texto que não cabe na coluna, com reticências. */
  private fit(text: string, width: number, size: number, font: "helvetica" | "helvetica-bold" = "helvetica") {
    if (textWidth(text, font, size) <= width) return text;
    let cut = text;
    while (cut.length > 1 && textWidth(`${cut}...`, font, size) > width) cut = cut.slice(0, -1);
    return `${cut}...`;
  }
}

/** Monta o PDF do extrato analítico. */
export function renderContractorStatement(documento: StatementDocument) {
  const builder = new StatementBuilder(documento);
  for (const prestador of documento.prestadores) builder.addProvider(prestador);
  if (documento.prestadores.length > 0) builder.addTotals();
  return buildPdf(builder.pages, `Extrato analítico PJ ${documento.competencia}`);
}
