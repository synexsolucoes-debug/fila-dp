import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildStatement, competenceLabel, competencePeriod, formatTaxId } from "../lib/contractor-statement.ts";
import { renderContractorStatement } from "../lib/contractor-statement-pdf.ts";
import { A4, buildPdf, PdfPage, textWidth } from "../lib/pdf-document.ts";

/**
 * Extrato analítico de pagamento PJ, em PDF.
 *
 * O documento é entregue para conferência, e um documento de conferência tem
 * uma exigência que nenhum detalhe visual substitui: **os números precisam
 * fechar**. Duas identidades, e são elas que estes testes prendem:
 *
 *     proventos − descontos            = total apurado
 *     valor em nota fiscal + complemento = total apurado
 *
 * A segunda é o que diferencia esta folha da folha CLT que serviu de modelo:
 * lá a última coluna é o líquido, um número só; aqui o mesmo total sai por dois
 * caminhos, e é essa separação que a pessoa precisa enxergar.
 */

const linha = (extra: Record<string, unknown>) => ({
  codigo: "PJ001", prestador: "ALFA SERVICOS LTDA", cnpj: "11222333000181",
  contrato: "CT-1", funcao: "ANALISTA", competencia: "2026-08",
  valor_contrato: 8000, total_apurado: 8560, nf_esperada: 6000, limite_nf: 6000,
  origem_limite: "contract", complemento: 2560, forma_complemento: "caju_saldo_livre",
  status_nf: "pending", status_fechamento: "review", quantidade: 1, origem: "manual",
  documento: "", situacao: "active", ...extra,
});

const linhasDeUmPrestador = [
  linha({ tipo: "PROVENTO", rubrica: "Valor contratual", valor: 8000, origem: "contrato" }),
  linha({ tipo: "PROVENTO", rubrica: "Comissão", valor: 900 }),
  linha({ tipo: "PROVENTO", rubrica: "Reembolso", valor: 300, quantidade: 3 }),
  linha({ tipo: "DESCONTO", rubrica: "Plano de saúde", valor: 480, origem: "fixed_item" }),
  linha({ tipo: "DESCONTO", rubrica: "Equipamento", valor: 160 }),
  linha({ tipo: "DESCONTO", rubrica: "Falta", valor: 300, situacao: "canceled" }),
];

const contexto = { competence: "2026-08", empresa: "PILOTO LTDA", cnpjEmpresa: "11222333000199", emitidoPor: "Fulana" };

test("o extrato fecha nos dois sentidos: pela conta e pelas duas saídas", () => {
  const documento = buildStatement(linhasDeUmPrestador, contexto);
  assert.equal(documento.prestadores.length, 1);
  const [prestador] = documento.prestadores;

  // 1. A conta: proventos menos descontos é o total apurado.
  assert.equal(prestador.totalProventos, 9200);
  assert.equal(prestador.totalDescontos, 640);
  assert.equal(prestador.totalProventos - prestador.totalDescontos, prestador.totalApurado);

  // 2. As saídas: nota fiscal mais complemento é o mesmo total. É esta que
  //    diferencia o extrato PJ da folha CLT que serviu de modelo.
  assert.equal(prestador.valorNotaFiscal + prestador.complemento, prestador.totalApurado);
});

test("o lançamento excluído não aparece e fica fora da soma", () => {
  /* A consulta já descarta o excluído, e a montagem descarta de novo: são duas
     origens diferentes para o mesmo documento — a rota e quem um dia montar o
     extrato a partir de outra lista — e as duas precisam chegar ao mesmo lugar.
     O ensaio contra PostgreSQL prende o lado da consulta. */
  const documento = buildStatement(linhasDeUmPrestador, contexto);
  const [prestador] = documento.prestadores;
  assert.equal(prestador.linhas.length, 5, "somente rubricas válidas aparecem");
  assert.ok(!prestador.linhas.some((item) => item.descricao === "Falta"));
  assert.equal(prestador.totalDescontos, 640, "o total mantém 480 + 160, sem os 300 excluídos");
});

test("prestadores são separados por código e CNPJ, não por nome", () => {
  /* Duas empresas do grupo podem ter prestadores com a mesma razão social.
     Agrupar pelo nome somaria a apuração dos dois num bloco só, e o documento
     afirmaria um valor que nenhum dos dois tem. */
  const documento = buildStatement([
    linha({ tipo: "PROVENTO", rubrica: "Valor contratual", valor: 8000 }),
    linha({ tipo: "PROVENTO", rubrica: "Valor contratual", valor: 5000, codigo: "PJ002", cnpj: "22333444000172", total_apurado: 5000, nf_esperada: 5000, complemento: 0 }),
  ], contexto);
  assert.equal(documento.prestadores.length, 2);
  assert.deepEqual(documento.prestadores.map((item) => item.codigo), ["PJ001", "PJ002"]);
});

test("o documento não vaza identificador de banco para quem confere", () => {
  const documento = buildStatement(linhasDeUmPrestador, contexto);
  const [prestador] = documento.prestadores;
  const rubricas = prestador.linhas.map((item) => item.rubrica);
  assert.ok(!rubricas.includes("FIXED_ITEM"), "`fixed_item` é nome de coluna, não rubrica");
  assert.ok(rubricas.includes("FIXO"));
  assert.ok(rubricas.includes("CONTRATO"));
  // A forma do complemento aparece por extenso: o extrato afirma para onde o
  // dinheiro vai, e `caju_saldo_livre` não é uma frase.
  assert.equal(prestador.formaComplemento, "Caju Saldo Livre");
  assert.equal(prestador.statusFechamento, "Conferência");
});

test("a quantidade só aparece quando diz alguma coisa", () => {
  // "1,00" em toda linha empurra o olho para longe do valor, que é o que
  // interessa.
  const documento = buildStatement(linhasDeUmPrestador, contexto);
  const [prestador] = documento.prestadores;
  assert.equal(prestador.linhas.find((item) => item.descricao === "Comissão")?.referencia, "");
  assert.equal(prestador.linhas.find((item) => item.descricao === "Reembolso")?.referencia, "3,00");
});

test("identificação e competência saem formatadas para leitura humana", () => {
  assert.equal(formatTaxId("11222333000181"), "11.222.333/0001-81");
  assert.equal(formatTaxId("12345678901"), "123.456.789-01");
  assert.equal(formatTaxId(""), "Não informado");
  assert.match(competenceLabel("2026-08"), /agosto de 2026/u);
  // Agosto tem 31 dias; fevereiro de 2028, bissexto, tem 29.
  assert.equal(competencePeriod("2026-08"), "01/08/2026 a 31/08/2026");
  assert.equal(competencePeriod("2028-02"), "01/02/2028 a 29/02/2028");
});

/* -------------------------------------------------------------------------- */
/* O arquivo                                                                  */
/* -------------------------------------------------------------------------- */

test("o PDF gerado é um PDF válido, com as páginas que declara", () => {
  const documento = buildStatement(linhasDeUmPrestador, contexto);
  const pdf = renderContractorStatement(documento);
  const texto = pdf.toString("latin1");

  assert.match(texto, /^%PDF-1\.4\n/u, "sem o cabeçalho nenhum leitor abre");
  assert.match(texto, /%%EOF\n$/u);
  assert.match(texto, /\/Type \/Catalog/u);
  assert.match(texto, /\/Type \/Pages \/Kids \[/u);

  /* A tabela de referências cruzadas aponta cada objeto por deslocamento em
     bytes. Se ela mentir, o leitor abre em branco ou recusa o arquivo — e o
     defeito não aparece em nenhum outro teste. */
  const xrefMatch = texto.match(/startxref\n(\d+)\n%%EOF/u);
  assert.ok(xrefMatch, "o arquivo precisa dizer onde a tabela começa");
  const xrefOffset = Number(xrefMatch[1]);
  assert.equal(texto.slice(xrefOffset, xrefOffset + 4), "xref", "a tabela não está onde o arquivo diz");

  const contagem = texto.match(/\/Count (\d+)/u);
  assert.ok(contagem && Number(contagem[1]) >= 1);
  const paginas = [...texto.matchAll(/\/Type \/Page[^s]/gu)].length;
  assert.equal(paginas, Number(contagem?.[1]), "a contagem de páginas não bate com as páginas");
});

test("o deslocamento de cada objeto é contado em bytes, não em caracteres", () => {
  /* Um nome com acento ocupa mais bytes que caracteres em UTF-8 e exatamente
     um byte em Latin-1. Medir errado desloca a tabela de referências e o
     leitor recusa o arquivo — e a falha só aparece com acento, ou seja, em
     quase todo nome brasileiro e em nenhum teste feito com nomes ASCII. */
  const documento = buildStatement(
    [linha({ tipo: "PROVENTO", rubrica: "Manutenção de instalações", valor: 8000, prestador: "AÇÃO CONSTRUÇÕES LTDA" })],
    { ...contexto, empresa: "ORGANIZAÇÃO IRMÃOS ANDRÉ & CIA" },
  );
  const texto = renderContractorStatement(documento).toString("latin1");
  const xrefOffset = Number(texto.match(/startxref\n(\d+)\n%%EOF/u)?.[1]);
  assert.equal(texto.slice(xrefOffset, xrefOffset + 4), "xref");

  // Cada entrada da tabela precisa cair no início de um objeto.
  const entradas = [...texto.matchAll(/^(\d{10}) 00000 n $/gmu)].map((match) => Number(match[1]));
  assert.ok(entradas.length >= 4, "a tabela precisa listar os objetos");
  for (const offset of entradas) {
    assert.match(texto.slice(offset, offset + 12), /^\d+ 0 obj/u, `objeto ausente no deslocamento ${offset}`);
  }
});

test("o PDF ignora completamente a rubrica cancelada", () => {
  const comCancelado = renderContractorStatement(buildStatement(linhasDeUmPrestador, contexto)).toString("latin1");
  const semCancelado = renderContractorStatement(
    buildStatement(linhasDeUmPrestador.filter((item) => item.situacao !== "canceled"), contexto),
  ).toString("latin1");
  assert.equal(comCancelado, semCancelado, "cancelados não podem alterar nenhuma página do extrato");
});

test("nada escreve por cima de nada, por mais comprido que seja o cadastro", () => {
  /* A linha de identificação tem texto encostado à esquerda (código, nome,
     CNPJ, função) e texto encostado à direita (contrato, situação). Reservar
     uma largura fixa para o lado esquerdo erra dos dois jeitos: corta um nome
     curto que caberia, e deixa uma função comprida escrever por cima da
     situação — que é o defeito que aparece no papel e em nenhum teste, porque
     o PDF continua sendo um PDF válido.

     A conferência mede o desenho: para cada linha do arquivo, o fim de um
     trecho não pode passar do começo do seguinte. É a mesma pergunta que se faz
     olhando a folha impressa, feita em pontos. */
  const gigante = buildStatement([linha({
    tipo: "PROVENTO", rubrica: "Valor contratual", valor: 8000, origem: "contrato",
    prestador: "Construtora Incorporadora Administradora e Participações Santa Terezinha do Vale Verde Grande do Norte Sociedade Empresária Limitada",
    funcao: "Coordenação geral de obras civis, manutenção predial preventiva e corretiva e gestão integral de contratos de fachada e cobertura",
    contrato: "CT-2026-0001-REVISAO-B-ADITIVO-3-PRORROGACAO-2027-ANEXO-IV",
  })], contexto);

  const texto = renderContractorStatement(gigante).toString("latin1");

  /* Cada trecho sai como um `BT … Tf … Td (…) Tj ET` completo, então a fonte, o
     corpo, a posição e o conteúdo estão todos na mesma linha do fluxo. Ler dali
     dá posição e largura sem um leitor de PDF — uma dependência a mais para
     provar uma conta que a própria métrica da fonte já sabe fazer. */
  const fontes = { F1: "helvetica", F2: "helvetica-bold", F3: "courier" } as const;
  const trechos: Array<{ x: number; y: number; fim: number; texto: string }> = [];
  for (const evento of texto.matchAll(/BT \/(F\d) ([\d.]+) Tf ([\d.]+) ([\d.]+) Td \((.*?)\) Tj ET/gu)) {
    const conteudo = evento[5]
      .replace(/\\([()\\])/gu, "$1")
      .replace(/\\(\d{3})/gu, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
    if (!conteudo.trim()) continue;
    const x = Number(evento[3]);
    const fonte = fontes[evento[1] as keyof typeof fontes];
    trechos.push({ x, y: Number(evento[4]), fim: x + textWidth(conteudo, fonte, Number(evento[2])), texto: conteudo });
  }
  assert.ok(trechos.length > 20, `o arquivo precisa ter texto para medir — li ${trechos.length}`);

  const porLinha = new Map<number, typeof trechos>();
  for (const trecho of trechos) {
    const chave = Math.round(trecho.y);
    if (!porLinha.has(chave)) porLinha.set(chave, []);
    porLinha.get(chave)!.push(trecho);
  }
  const colisoes: string[] = [];
  for (const [y, mesmaLinha] of porLinha) {
    mesmaLinha.sort((a, b) => a.x - b.x);
    for (let i = 1; i < mesmaLinha.length; i += 1) {
      const anterior = mesmaLinha[i - 1];
      const atual = mesmaLinha[i];
      // Meio ponto de folga: as métricas são as reais da Helvetica, mas o
      // arredondamento das coordenadas é decimal.
      if (anterior.fim > atual.x + 0.5) {
        colisoes.push(`y=${y}: "${anterior.texto.slice(0, 40)}" invade "${atual.texto.slice(0, 40)}"`);
      }
    }
  }
  assert.deepEqual(colisoes, [], `texto sobreposto no extrato:\n${colisoes.join("\n")}`);

  // E o corte, quando é preciso, é corte — não um nome que escapa da coluna.
  assert.match(texto, /\.\.\./u, "um cadastro deste tamanho precisa ser cortado em algum campo");
});

test("texto fora do Latin-1 vira a letra sem acento, nunca lixo", () => {
  // Um "?" no meio de um nome próprio, num documento de conferência, é pior
  // que a letra sem acento: parece dado corrompido.
  const page = new PdfPage(A4.width, A4.height);
  page.text("Ação — Rocío", 10, 10);
  const texto = buildPdf([page], "t").toString("latin1");
  assert.match(texto, /A\\347\\343o - Roc\\355o/u);
  assert.doesNotMatch(texto, /\?/u);
});

test("a métrica da fonte é real, senão nada alinha", () => {
  // Sem largura correta não há número à direita nem título centrado, que é
  // metade do que faz o documento parecer um documento.
  assert.ok(textWidth("W", "helvetica", 10) > textWidth("i", "helvetica", 10));
  assert.equal(textWidth("iii", "courier", 10), textWidth("WWW", "courier", 10), "Courier é monoespaçada");
  // O acento não muda o avanço em Helvetica: "á" ocupa o mesmo que "a".
  assert.equal(textWidth("á", "helvetica", 10), textWidth("a", "helvetica", 10));
  assert.ok(textWidth("Total", "helvetica-bold", 8) > textWidth("Total", "helvetica", 8));
});

test("o desenho declara as duas saídas e não fala em líquido", async () => {
  /* "Líquido" é a palavra da folha CLT, onde o pagamento é um número só.
     Usá-la aqui faria o documento prometer algo que o PJ não tem. */
  const fonte = await readFile(new URL("../lib/contractor-statement-pdf.ts", import.meta.url), "utf8");
  // Sem os comentários: eles explicam justamente por que a palavra não é usada,
  // e a conferência é sobre o que o documento diz, não sobre o que o código
  // explica.
  const desenho = fonte.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  assert.match(desenho, /Valor a emitir em nota fiscal/u);
  assert.match(desenho, /Complemento/u);
  assert.match(desenho, /"Valor NF"/u);
  assert.doesNotMatch(desenho, /Líquido|líquido/u);
});
