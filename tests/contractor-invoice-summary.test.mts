import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildInvoiceSummary } from "../lib/contractor-invoice-summary.ts";
import { renderInvoiceSummary } from "../lib/contractor-invoice-summary-pdf.ts";
import { reports } from "../lib/payment-reports.ts";

/**
 * Relação de líquidos em nota fiscal, em PDF.
 *
 * O documento responde uma pergunta só — **quanto cada prestador vai emitir em
 * nota nesta competência** — e é com ele na mão que se confere o aviso mandado
 * a cada um e se organiza o pagamento. Duas coisas precisam ser verdade para
 * ele servir, e são elas que estes testes prendem:
 *
 *     total do documento = soma das linhas = soma dos subtotais por empresa
 *     valor da linha     = valor a emitir em nota, sem o complemento
 *
 * A segunda é a que faz o documento existir. No PJ o total apurado sai por
 * dois caminhos, nota fiscal e complemento; somar os dois aqui produziria um
 * número que ninguém vai emitir — e é justamente este número que o prestador
 * copia para dentro da nota dele.
 */

const linha = (extra: Record<string, unknown>) => ({
  codigo: "PJ001", prestador: "ALFA SERVICOS LTDA", cnpj: "11222333000181",
  empresa: "PILOTO LTDA", competencia: "2026-08", nf_esperada: 6000, status_nf: "pending",
  ...extra,
});

const contexto = { competence: "2026-08", empresa: "PILOTO LTDA", cnpjEmpresa: "11222333000199", emitidoPor: "Fulana" };

test("o total é a soma das linhas, e as linhas são só o valor da nota", () => {
  const documento = buildInvoiceSummary([
    linha({}),
    linha({ codigo: "PJ002", prestador: "BETA CONSULTORIA LTDA", cnpj: "22333444000172", nf_esperada: 4500 }),
    linha({ codigo: "PJ003", prestador: "GAMA SERVICOS ME", cnpj: "33444555000163", nf_esperada: 1970.03 }),
  ], contexto);

  assert.equal(documento.quantidade, 3);
  assert.equal(documento.total, 12470.03);
  const somaDasLinhas = documento.grupos
    .flatMap((grupo) => grupo.linhas)
    .reduce((total, item) => total + item.valor, 0);
  assert.equal(documento.total, somaDasLinhas);
});

test("quem não emite nota fica de fora, em vez de entrar zerado", () => {
  /* Quem recebe tudo por complemento não tem nota a emitir. Uma linha de
     "0,00" numa relação de notas a emitir faz procurar uma cobrança que não
     existe — e o total, que é o que importa, não muda com ela.
     A consulta já descarta; este é o segundo cadeado, para quem um dia montar
     o documento a partir de outra lista. */
  const documento = buildInvoiceSummary([
    linha({}),
    linha({ codigo: "PJ009", prestador: "SO COMPLEMENTO LTDA", nf_esperada: 0 }),
  ], contexto);
  assert.equal(documento.quantidade, 1);
  assert.equal(documento.total, 6000);
  assert.ok(!documento.grupos.flatMap((grupo) => grupo.linhas).some((item) => item.prestador.includes("SO COMPLEMENTO")));
});

test("cada empresa fecha o seu subtotal, e o subtotal só aparece quando há mais de uma", () => {
  /* A mesma pessoa presta serviço para mais de uma empresa do grupo, e cada
     uma recebe a sua nota. Somar as duas numa linha só esconderia que são dois
     documentos a emitir — e é por empresa que o financeiro paga. */
  const documento = buildInvoiceSummary([
    linha({}),
    linha({ empresa: "SEGUNDA LTDA", nf_esperada: 2000 }),
    linha({ empresa: "SEGUNDA LTDA", codigo: "PJ002", prestador: "BETA CONSULTORIA LTDA", nf_esperada: 1000 }),
  ], contexto);

  assert.equal(documento.agrupadoPorEmpresa, true);
  assert.deepEqual(documento.grupos.map((grupo) => grupo.empresa), ["PILOTO LTDA", "SEGUNDA LTDA"]);
  assert.deepEqual(documento.grupos.map((grupo) => grupo.total), [6000, 3000]);
  assert.equal(documento.grupos.reduce((total, grupo) => total + grupo.total, 0), documento.total);

  // Com uma empresa só, o subtotal repetiria o total logo abaixo dele.
  const umaEmpresa = buildInvoiceSummary([linha({})], contexto);
  assert.equal(umaEmpresa.agrupadoPorEmpresa, false);
});

test("o documento não vaza identificador de banco nem CNPJ cru", () => {
  const documento = buildInvoiceSummary([
    linha({}),
    linha({ codigo: "PJ002", status_nf: "validated", nf_esperada: 100 }),
    linha({ codigo: "PJ003", status_nf: "divergent", nf_esperada: 100 }),
  ], contexto);
  const situacoes = documento.grupos.flatMap((grupo) => grupo.linhas).map((item) => item.situacao);
  assert.deepEqual(situacoes, ["Pendente", "Conferida", "Divergente"]);
  assert.equal(documento.grupos[0].linhas[0].cnpj, "11.222.333/0001-81");
  assert.equal(documento.cnpjEmpresa, "11.222.333/0001-99");
  assert.match(documento.competenciaLabel, /agosto de 2026/u);
});

/* -------------------------------------------------------------------------- */
/* O arquivo                                                                  */
/* -------------------------------------------------------------------------- */

test("o PDF gerado é um PDF válido, com a tabela de referências no lugar", () => {
  /* Nome com acento ocupa mais bytes que caracteres em UTF-8: medir errado
     desloca a tabela e o leitor recusa o arquivo — falha que só aparece com
     acento, ou seja, em quase todo nome brasileiro. */
  const documento = buildInvoiceSummary(
    [linha({ prestador: "AÇÃO CONSTRUÇÕES LTDA", empresa: "ORGANIZAÇÃO IRMÃOS ANDRÉ & CIA" })],
    { ...contexto, empresa: "ORGANIZAÇÃO IRMÃOS ANDRÉ & CIA" },
  );
  const texto = renderInvoiceSummary(documento).toString("latin1");

  assert.match(texto, /^%PDF-1\.4\n/u);
  assert.match(texto, /%%EOF\n$/u);
  const xrefOffset = Number(texto.match(/startxref\n(\d+)\n%%EOF/u)?.[1]);
  assert.equal(texto.slice(xrefOffset, xrefOffset + 4), "xref", "a tabela não está onde o arquivo diz");
  const contagem = texto.match(/\/Count (\d+)/u);
  const paginas = [...texto.matchAll(/\/Type \/Page[^s]/gu)].length;
  assert.equal(paginas, Number(contagem?.[1]), "a contagem de páginas não bate com as páginas");
});

test("a folha diz que fala só da nota, e diz por que está vazia quando está", () => {
  const cheio = renderInvoiceSummary(buildInvoiceSummary([linha({})], contexto)).toString("latin1");
  /* Sem este aviso a folha é lida como o pagamento inteiro, e o complemento —
     que sai por outro caminho — vira diferença inexplicada na conferência. */
  assert.match(cheio, /SOMENTE O VALOR A EMITIR EM NOTA FISCAL/u);
  assert.match(cheio, /TOTAL DA COMPET/u);

  /* Uma página só com cabeçalho parece documento truncado, e quem recebe volta
     para perguntar se faltou folha. */
  const vazio = renderInvoiceSummary(buildInvoiceSummary([], contexto)).toString("latin1");
  assert.match(vazio, /Nenhum prestador tem valor a emitir/u);
  assert.doesNotMatch(vazio, /TOTAL DA COMPET/u, "não existe total de uma relação sem linhas");
});

test("a relação nasce do mesmo catálogo da rota, e a rota a oferece em PDF", async () => {
  const relatorio = reports["contractor-invoice-summary"];
  assert.equal(relatorio.capability, "contractors.payments.read",
    "quem confere a apuração precisa poder emitir a relação; os números são os mesmos do extrato");
  for (const coluna of ["codigo", "prestador", "cnpj", "empresa", "nf_esperada", "status_nf"]) {
    assert.ok(relatorio.columns.includes(coluna as never), `a relação não traz a coluna ${coluna}`);
  }
  // Só quem tem valor a emitir entra — a mesma regra do aviso de NF, para que
  // a relação sirva de conferência dos avisos mandados.
  assert.match(relatorio.query, /invoice_expected_amount > 0/u);
  // O fechamento excluído não entra em documento de pagamento.
  assert.match(relatorio.query, /c\.excluded_at IS NULL/u);

  const [rota, secoes] = await Promise.all([
    readFile(new URL("../app/api/payments/reports/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/ContractorSections.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(rota, /pdfReports = new Set<PaymentReportKey>\(\["contractor-analytical", "contractor-invoice-summary"\]\)/u);
  assert.match(rota, /renderInvoiceSummary\(buildInvoiceSummary\(rows\.results, contexto\)\)/u);
  // E é alcançável de onde a conferência acontece, ao lado dos avisos de NF.
  assert.match(secoes, /reportUrl\("contractor-invoice-summary", "pdf"\)/u);
  assert.match(secoes, /Líquidos em NF \(PDF\)/u);
});
