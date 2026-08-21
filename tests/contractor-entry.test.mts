import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readBatchEntries } from "../lib/contractor-input.ts";
import { buildInvoiceNoticeFile, invoiceNoticeMessage } from "../lib/contractor-invoice-notice.ts";

/**
 * Lançamento PJ nas duas formas, e o aviso de nota fiscal.
 *
 * Duas mudanças de operação que o banco já sustentava e a tela não oferecia:
 * lançar a mesma rubrica para vários prestadores de uma vez, e escolher na
 * hora se o lançamento vale só naquele mês, repete sempre ou repete até uma
 * data. As três naturezas são as mesmas de antes — mensal é componente da
 * competência, fixo é recorrente sem término, determinado é recorrente com.
 */

test("o lote recusa o que estragaria a apuração em silêncio", () => {
  // Prestador repetido quase sempre é engano de preenchimento, e lançar os dois
  // valores sem avisar fecha a competência com um número que ninguém digitou
  // de propósito.
  assert.throws(() => readBatchEntries([
    { providerId: "pj-1", amount: 100 },
    { providerId: "pj-1", amount: 200 },
  ]), /duas vezes/u);

  assert.throws(() => readBatchEntries([{ amount: 100 }]), /sem prestador/u);
  assert.throws(() => readBatchEntries([]), /ao menos um/u);
  // Teto: sem ele, um corpo com dez mil linhas viraria dez mil idas ao banco
  // dentro de uma requisição só.
  assert.throws(
    () => readBatchEntries(Array.from({ length: 201 }, (_, index) => ({ providerId: `pj-${index}`, amount: 1 }))),
    /máximo 200/u,
  );
});

test("linha em branco não vira lançamento", () => {
  /* Quem percorre a lista deixa vazia a de quem não recebe aquela rubrica.
     Obrigar a apagar o campo seria trabalho sem motivo, e lançar zero criaria
     um componente que não existe. */
  const entries = readBatchEntries([
    { providerId: "pj-1", amount: 480 },
    { providerId: "pj-2", amount: "" },
    { providerId: "pj-3", amount: 0 },
    { providerId: "pj-4", amount: 160.5 },
  ]);
  assert.deepEqual(entries, [
    { providerId: "pj-1", amount: 480 },
    { providerId: "pj-4", amount: 160.5 },
  ]);
  // E um lote inteiro em branco é recusado: seria uma confirmação que não faz
  // nada, e quem clicou concluiria que lançou.
  assert.throws(() => readBatchEntries([{ providerId: "pj-1", amount: "" }]), /Nenhuma linha/u);
});

test("sem lote no corpo, a rota segue pelo caminho de sempre", () => {
  // `null` é o que faz a rota distinguir as duas formas sem um sinalizador à
  // parte, que um cliente poderia mandar errado.
  assert.equal(readBatchEntries(undefined), null);
  assert.equal(readBatchEntries({ providerId: "pj-1" }), null);
  assert.equal(readBatchEntries("pj-1"), null);
});

test("a mensagem de aviso diz o valor e para quem emitir", () => {
  const mensagem = invoiceNoticeMessage(6000, "Alfa Serviços");
  assert.match(mensagem, /Segue o valor a ser emitido referente a sua NF/u);
  assert.match(mensagem, /R\$\s?6\.000,00/u);
  // A emitente entra no texto: é o dado que quem recebe precisa para emitir, e
  // o único que ela não tem como conferir sozinha — o valor está na tela dela,
  // a empresa não.
  assert.match(mensagem, /para Alfa Serviços/u);
  // Sem saudação de horário: o arquivo é gerado uma vez e colado ao longo do
  // dia, e "Bom dia" colado às 15h desmente o próprio remetente.
  assert.doesNotMatch(mensagem, /Bom dia|Boa tarde|Boa noite/u);
  // Sem empresa informada a frase volta a ser só o valor, sem um "para "
  // pendurado no vazio.
  assert.doesNotMatch(invoiceNoticeMessage(6000), /para\s*:/u);
});

test("o arquivo traz uma mensagem por prestador, separadas e na ordem da tela", () => {
  const arquivo = buildInvoiceNoticeFile([
    { prestador: "Alfa", nf_esperada: 6000 },
    { prestador: "Beta", nf_esperada: "4750.00" },
    { prestador: "Gama", nf_esperada: 0 },
  ]);
  const blocos = arquivo.split("\r\n\r\n");
  assert.equal(blocos.length, 2, "quem não tem valor a emitir não entra");
  assert.match(blocos[0], /6\.000,00/u);
  assert.match(blocos[1], /4\.750,00/u);
  // Quebra de linha do Windows: o arquivo é aberto no Bloco de Notas na maior
  // parte das vezes, e com "\n" sozinho ele mostra tudo numa linha só.
  assert.ok(arquivo.includes("\r\n"), "sem CRLF o Bloco de Notas junta tudo");
  assert.equal(buildInvoiceNoticeFile([]), "");

  // A emitente é uma só para o arquivo inteiro: ela é quem recebe a nota de
  // todo mundo, não um recorte da lista.
  const comEmpresa = buildInvoiceNoticeFile([
    { prestador: "Alfa", nf_esperada: 6000 },
    { prestador: "Beta", nf_esperada: 4750 },
  ], "Vinculato Serviços");
  assert.equal(comEmpresa.split("Vinculato Serviços").length - 1, 2, "a emitente vale para todas as mensagens");
});

test("a empresa do aviso é emitente, e por isso não entra no WHERE", async () => {
  /* O prestador é do grupo: é ele quem presta serviço para as empresas, e não
     uma empresa que possui o prestador. Se a empresa escolhida recortasse a
     lista, o arquivo deixaria de fora justamente quem atende mais de uma — e
     quem gerasse não teria como perceber, porque um arquivo com menos gente
     parece igualmente correto. */
  const relatorios = await readFile(new URL("../lib/payment-reports.ts", import.meta.url), "utf8");
  const inicio = relatorios.indexOf(`"contractor-invoice-notice"`);
  const trecho = relatorios.slice(inicio, relatorios.indexOf("},", inicio));
  assert.match(trecho, /companyMeaning: "issuer"/u, "o aviso precisa declarar a empresa como emitente");

  const rota = await readFile(new URL("../app/api/payments/reports/route.ts", import.meta.url), "utf8");
  assert.match(rota, /companyMeaning" in report && report\.companyMeaning === "issuer"/u);
  // E o recorte por acesso continua: quem enxerga parte das empresas continua
  // enxergando só a parte dela, mesmo sem o filtro da emitente.
  assert.match(rota, /companyIsIssuer[\s\S]{0,400}!access\.unrestricted[\s\S]{0,200}IN \(/u);
});

test("a tabela de Pagamentos não mostra mais as três situações retiradas", async () => {
  /* Status do complemento, conciliação e fechamento saíram da tabela por
     pedido de quem confere: eram três colunas disputando largura com os
     números que se olha todo dia. Continuam no banco e no extrato analítico.

     O status do fechamento segue governando os botões da linha — ele decide o
     que se pode fazer com aquele prestador; só não ocupa mais uma coluna para
     dizer o que os próprios botões já dizem. */
  const secoes = await readFile(new URL("../app/painel/features/payments/ContractorSections.tsx", import.meta.url), "utf8");
  /* Da declaração até a próxima função de topo. Um `match` até o primeiro
     "\n}" pararia no fecho da desestruturação do parâmetro, que também começa
     linha — e a conferência passaria a olhar meia dúzia de linhas em vez da
     tabela. */
  const inicio = secoes.indexOf("function ClosingsTable");
  const seguinte = secoes.indexOf("\nfunction ", inicio + 1);
  const tabela = inicio < 0 ? "" : secoes.slice(inicio, seguinte < 0 ? undefined : seguinte);
  assert.ok(tabela, "a tabela de apuração precisa existir");
  for (const coluna of ["Status complemento", "Conciliação", "Fechamento"]) {
    assert.ok(!tabela.includes(`>${coluna}<`), `a coluna ${coluna} voltou`);
  }
  for (const coluna of ["Líquido", "Limite NF", "NF esperada", "Complemento", "Status NF"]) {
    assert.ok(tabela.includes(`>${coluna}<`), `a coluna ${coluna} sumiu junto`);
  }
  // As ações continuam decidindo pelo status, mesmo sem a coluna.
  assert.match(tabela, /row\.status !== "closed" && row\.status !== "paid"/u);
});

test("a janela de lançamento oferece as duas formas e as três naturezas", async () => {
  const janela = await readFile(new URL("../app/painel/features/payments/ContractorEntryDialog.tsx", import.meta.url), "utf8");
  assert.match(janela, /Por prestador/u);
  assert.match(janela, /Por rubrica/u);
  assert.match(janela, /"mensal", "fixo", "determinado"/u);
  // A competência final só é pedida onde ela significa alguma coisa.
  assert.match(janela, /nature === "determinado" && \(/u);
  // E o formulário reinicia a cada abertura: a janela fica montada, e sem isso
  // os valores da vez anterior reapareceriam prontos para lançar em dobro.
  assert.match(janela, /if \(open !== wasOpen\)/u);
});

test("a natureza escolhe a rota, e não um parâmetro dentro de uma rota só", async () => {
  /* Mensal é um componente da competência; fixo e determinado são o mesmo
     lançamento recorrente, com e sem competência final. São tabelas diferentes
     porque são coisas diferentes: uma pertence a um mês, a outra ao contrato. */
  const modulo = await readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8");
  assert.match(modulo, /entry\.nature === "mensal"[\s\S]{0,120}contractors\/components/u);
  assert.match(modulo, /contractors\/fixed-items/u);
  assert.match(modulo, /effectiveTo: entry\.nature === "determinado" \? entry\.effectiveTo : ""/u);
});

test("os tokens do módulo acompanham o diálogo portado", async () => {
  /* O `AnimatedModal` porta o conteúdo para a casca do painel, e ali fora
     `--pay-border` não existe: a declaração vira inválida e a borda some sem
     erro nenhum. Campos sem caixa e lista sem fundo, e nada no console. */
  const css = await readFile(new URL("../app/painel/features/payments/payments.module.css", import.meta.url), "utf8");
  assert.match(css, /\.paymentTokens,\s*\n\.workspace \{/u);
  for (const arquivo of ["ContractorEntryDialog.tsx", "PaymentsView.tsx"]) {
    const fonte = await readFile(new URL(`../app/painel/features/payments/${arquivo}`, import.meta.url), "utf8");
    /* A abertura da tag vai até o `>` que fecha o elemento — e não até o
       primeiro `>` do texto, que costuma ser o de uma seta `=>` num manipulador
       e faria a conferência olhar meia linha. */
    for (const modal of fonte.matchAll(/<AnimatedModal\b/gu)) {
      const trecho = fonte.slice(modal.index ?? 0, (modal.index ?? 0) + 400);
      assert.match(trecho, /className=\{styles\.paymentTokens\}/u,
        `${arquivo}: diálogo portado sem os tokens do módulo`);
    }
  }
});
