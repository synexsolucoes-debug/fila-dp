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

const emitente = {
  razaoSocial: "ULTRA TELECOMUNICAÇÕES LTDA",
  cnpj: "26016500000105",
  cidade: "Goiânia",
};

test("a mensagem traz tudo que quem recebe precisa para emitir sem perguntar", () => {
  /* Cada campo que faltasse aqui vira uma pergunta no privado, e trinta
     prestadores perguntando a mesma coisa é justamente o trabalho que este
     arquivo existe para não ter. */
  const mensagem = invoiceNoticeMessage({
    prestador: "Alfa Consultoria LTDA", amount: 10187.12, competence: "2026-07", emitente,
  });

  assert.match(mensagem, /^Bom dia, Alfa Consultoria LTDA, tudo bem\?/u);
  assert.match(mensagem, /mês de JULHO deve ser gerada no valor de R\$\s?10\.187,12\./u);
  // O CNPJ sai pontuado: é assim que se digita no emissor, e conferir dígito a
  // dígito num número corrido é onde o erro acontece.
  assert.match(mensagem, /CNPJ: 26\.016\.500\/0001-05/u);
  // Razão social, não nome fantasia — é a razão social que a nota exige.
  assert.match(mensagem, /Razão Social: ULTRA TELECOMUNICAÇÕES LTDA/u);
  assert.match(mensagem, /cidade de prestação do serviço: Goiânia\./u);
  assert.match(mensagem, /"Serviço prestado referente ao mês de JULHO\/2026"/u);
  assert.match(mensagem, /emitir sua NF e enviar/u);
});

test("linha sem dado não sai pela metade", () => {
  /* Um "CNPJ:" seguido de nada, ou um pedido para conferir a cidade sem dizer
     qual, é pior que a ausência: quem recebe entende que o dado existe e que
     alguém errou ao mandar. */
  const semCidade = invoiceNoticeMessage({
    prestador: "Alfa", amount: 6000, competence: "2026-07",
    emitente: { ...emitente, cidade: "" },
  });
  assert.doesNotMatch(semCidade, /cidade de prestação/u);
  assert.match(semCidade, /Razão Social/u, "o resto da mensagem continua inteiro");

  const semNada = invoiceNoticeMessage({ prestador: "", amount: 6000, competence: "2026-07" });
  assert.match(semNada, /^Bom dia, tudo bem\?/u, "sem nome, a saudação não fica com vírgula no vazio");
  assert.doesNotMatch(semNada, /CNPJ:|Razão Social:|Dados para emissão/u);
  assert.match(semNada, /R\$\s?6\.000,00/u, "o valor é o que nunca pode faltar");
});

test("o arquivo traz uma mensagem por prestador, separadas e na ordem da tela", () => {
  const arquivo = buildInvoiceNoticeFile([
    { prestador: "Alfa", nf_esperada: 6000 },
    { prestador: "Beta", nf_esperada: "4750.00" },
    { prestador: "Gama", nf_esperada: 0 },
  ], emitente, "2026-07");
  /* O separador é maior que a quebra interna de propósito: a mensagem tem
     parágrafos agora, e um separador do mesmo tamanho deixaria de separar. */
  const blocos = arquivo.split("\r\n\r\n\r\n");
  assert.equal(blocos.length, 2, "quem não tem valor a emitir não entra");
  assert.match(blocos[0], /Bom dia, Alfa, tudo bem\?/u);
  assert.match(blocos[0], /6\.000,00/u);
  assert.match(blocos[1], /Bom dia, Beta, tudo bem\?/u);
  assert.match(blocos[1], /4\.750,00/u);
  assert.ok(arquivo.includes("\r\n"), "sem CRLF o Bloco de Notas junta tudo");
  assert.equal(buildInvoiceNoticeFile([]), "");

  // A emitente é uma só para o arquivo inteiro: ela é quem recebe a nota de
  // todo mundo, não um recorte da lista.
  assert.equal(arquivo.split("ULTRA TELECOMUNICAÇÕES LTDA").length - 1, 2,
    "a emitente vale para todas as mensagens");
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

test("a tabela de Pagamentos não repete situações disponíveis no detalhamento", async () => {
  /* Status do complemento, conciliação, fechamento, nota fiscal e liberação do
     pagamento saíram da tabela por pedido de quem confere: disputavam largura
     com os números que se olha todo dia. Continuam no extrato analítico.

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
  for (const coluna of ["Status complemento", "Conciliação", "Fechamento", "Nota fiscal", "Pagamento"]) {
    assert.ok(!tabela.includes(`>${coluna}<`), `a coluna ${coluna} voltou`);
  }
  for (const coluna of ["Líquido", "Limite NF", "NF esperada", "Complemento"]) {
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

test("a incidência do desconto é escolhida ao lançar, corrigida no detalhamento e guardada no banco", async () => {
  /* Quem confere precisa poder dizer de onde o desconto saiu — nota ou
     complemento —, tanto no lançamento quanto depois, olhando o pagamento
     apurado. Sem isso o número certo só existia numa correção manual fora do
     sistema. */
  const [janela, detalhe, tela, componentes, patch, migracao, servico] = await Promise.all([
    readFile(new URL("../app/painel/features/payments/ContractorEntryDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/ContractorPaymentDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/components/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/components/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0082_contractor_discount_settlement.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/payment-service.ts", import.meta.url), "utf8"),
  ]);

  // A escolha só aparece para desconto: provento não tem onde incidir.
  assert.match(janela, /Incidência do desconto/u);
  assert.match(janela, /\{isDebit && \(/u);
  assert.match(janela, /settlementTarget: isDebit \? settlementTarget : "auto"/u);
  assert.match(tela, /settlementTarget: entry\.settlementTarget/u);

  // E é corrigível depois, na mesma linha em que se corrige valor e descrição.
  assert.match(detalhe, /Incidência/u);
  assert.match(detalhe, /aria-label="Incidência do desconto"/u);
  assert.match(detalhe, /settlementTarget: item\.direction === "debit" \? editSettlement : "auto"/u);

  // A rota grava a coluna, e omitir a incidência preserva a que já estava.
  assert.match(componentes, /settlementTarget: contractorSettlementTarget\(body\.settlementTarget/u);
  assert.match(patch, /body\.settlementTarget \?\? component\.settlement_target/u);
  assert.match(patch, /settlement_target = \?/u);

  // O valor recorrente carrega a escolha para cada competência que materializa.
  assert.match(servico, /settlement_target = \?, status = 'active'/u);
  assert.match(servico, /item\.settlementTarget \?\? "auto"/u);

  // `auto` é o padrão: nenhuma competência já apurada muda de valor.
  assert.match(migracao, /"settlement_target" text DEFAULT 'auto' NOT NULL/u);
  assert.match(migracao, /"settlement_target" IN \('auto', 'invoice', 'complement'\)/u);
  assert.match(migracao, /"direction" = 'debit' OR "settlement_target" = 'auto'/u);
});

test("o extrato diz de qual lado o desconto saiu", async () => {
  const extrato = await readFile(
    new URL("../app/painel/features/payments/ContractorAnalyticalStatement.tsx", import.meta.url),
    "utf8",
  );
  assert.match(extrato, /dentro da nota/u);
  assert.match(extrato, /no complemento/u);
  // E leva a informação para o CSV, que é o que sai da tela para a conferência.
  assert.match(extrato, /"INCIDÊNCIA"/u);
  assert.match(extrato, /DESCONTOS DENTRO DA NOTA/u);
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
