import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MockTangerinoSession } from "../worker/tangerino/mock-session.ts";
import { isContractDataStage } from "../lib/tangerino/parser.ts";

/**
 * A descoberta inverte o sentido do agente.
 *
 * O fluxo antigo partia de `fdp_employees` e ia conferir a admissão na origem —
 * e por isso nunca achava quem está sendo admitido, que é justamente quem ainda
 * não existe no ERP. Os testes aqui guardam a inversão e os limites dela.
 */

test("a sessão lista admissões sem precisar de um nome", async () => {
  // Pesquisar exige um nome em mãos. O nome de quem está sendo admitido não
  // está em lugar nenhum do Vinculato — é a informação que falta.
  const session = new MockTangerinoSession("multiple_matches");
  await session.ensureAuthenticated();
  await session.openAdmissions();
  const hits = await session.listAdmissions();

  assert.equal(hits.length, 2);
  assert.deepEqual(session.calls, ["ensureAuthenticated", "openAdmissions", "listAdmissions"]);
  assert.ok(hits.every((hit) => hit.label.length > 0), "cada cartão precisa trazer o nome");
});

test("lista vazia não é erro", async () => {
  // Dia sem admissão nova é o caso comum, não uma falha do agente.
  const session = new MockTangerinoSession("not_found");
  assert.deepEqual(await session.listAdmissions(), []);
});

test("só a etapa de dados contratuais vira demanda", () => {
  // Abrir demanda antes disso colocaria na fila do DP alguém que ainda está
  // enviando documento — trabalho que não dá para fazer.
  assert.equal(isContractDataStage("Dados contratuais"), true);
  assert.equal(isContractDataStage("Preencher dados contratuais"), true);
  assert.equal(isContractDataStage("Aguardando documentação"), false);
  assert.equal(isContractDataStage("Aprovar documentos"), false);
  assert.equal(isContractDataStage("Concluída"), false);
});

test("a descoberta tem teto por execução", async () => {
  /* Cada cartão aberto é uma navegação contra o sistema de outra empresa, e um
     lote sem limite viraria enxurrada. O teto é lido da fonte porque importar
     o módulo traria o acesso ao banco junto, e este arquivo roda sem banco. */
  const fonte = await readFile(new URL("../lib/tangerino/discovery.ts", import.meta.url), "utf8");
  const teto = /export const DISCOVERY_BATCH_LIMIT = (\d+);/u.exec(fonte);
  assert.ok(teto, "o teto precisa existir e ser explícito");
  assert.ok(Number(teto[1]) > 0 && Number(teto[1]) <= 25);
  assert.match(fonte, /Math\.min\(Number\(options\.limit\) \|\| DISCOVERY_BATCH_LIMIT, DISCOVERY_BATCH_LIMIT\)/u);
});

test("a demanda descoberta não inventa colaborador nem empresa", async () => {
  const fonte = await readFile(new URL("../lib/tangerino/open-admissions.ts", import.meta.url), "utf8");
  // A lista de colaboradores é espelho do ERP: criar alguém lá antes do
  // cadastro transformaria toda conferência entre os dois sistemas em
  // divergência falsa.
  assert.doesNotMatch(fonte, /INSERT INTO fdp_employees/u);
  // E o cartão nasce sem employee_id: o campo existe e fica nulo de propósito.
  assert.match(fonte, /`employee_id` e `company_id` ficam nulos de propósito/u);
  // Empresa só quando não há dúvida — configurada ou única do grupo.
  assert.match(fonte, /companies\.length === 1 \? companies\[0\] : null/u);
});

test("descobrir a mesma admissão de novo não abre uma segunda demanda", async () => {
  const fonte = await readFile(new URL("../lib/tangerino/open-admissions.ts", import.meta.url), "utf8");
  // Duas proteções, e as duas importam: o índice único no processo da origem, e
  // o evento de integração com chave derivada. Sem elas, a varredura de hora em
  // hora encheria a fila do DP com a mesma pessoa.
  assert.match(fonte, /ON CONFLICT \("workspace_id", "integration_id", "external_admission_id"\) DO UPDATE/u);
  assert.match(fonte, /open-admission-contract-data:\$\{externalAdmissionId\}:\$\{admissionDate\}/u);
  assert.match(fonte, /status === "processed" && event\.event\.result_id/u);
});

test("identificador instável não vira demanda", async () => {
  // `card:0` serve para clicar nesta leitura e para mais nada. Gravá-lo faria a
  // execução seguinte tratar dois cartões diferentes como a mesma admissão.
  const fonte = await readFile(new URL("../lib/tangerino/discovery.ts", import.meta.url), "utf8");
  assert.match(fonte, /isStableExternalAdmissionId\(candidate\)/u);
  assert.match(fonte, /summary\.skipped \+= 1/u);
});

test("a descoberta roda depois da fila pedida por pessoas", async () => {
  // Abrir o navegador para listar enquanto há consulta esperando atrasaria
  // quem está na frente de uma tela aguardando resposta.
  const runner = await readFile(new URL("../worker/tangerino/runner.ts", import.meta.url), "utf8");
  assert.match(runner, /if \(!shouldStop\(\) && handled === 0\)/u);
  // E uma falha na listagem não derruba a varredura já concluída — exceto o
  // desafio de autenticação, que precisa chegar ao painel.
  assert.match(runner, /if \(code === "AUTHENTICATION_REQUIRED"\) throw error/u);
});

test("a migração explica por que a admissão não vira colaborador", async () => {
  const sql = await readFile(new URL("../drizzle/postgres/0090_tangerino_open_admissions.sql", import.meta.url), "utf8");
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u, "a tabela precisa do isolamento por workspace");
  assert.match(sql, /fdp_tangerino_open_admissions_external_uq/u);
  assert.match(sql, /espelho do ERP/u);
});

test("a descoberta não repete a cada ciclo do worker", async () => {
  /* Em produção a primeira versão rodou a cada cinco segundos: cada execução
     abria o navegador, fazia login e esbarrava no CAPTCHA de novo. Isso enche a
     tela de quem opera e é o padrão de acesso que faz o provedor tratar a conta
     como uso anômalo. */
  const fonte = await readFile(new URL("../lib/tangerino/discovery.ts", import.meta.url), "utf8");
  const intervalo = /export const DISCOVERY_MIN_INTERVAL_MS = (\d+) \* 60_000;/u.exec(fonte);
  assert.ok(intervalo, "o intervalo mínimo precisa ser explícito");
  assert.ok(Number(intervalo[1]) >= 5, "menos de cinco minutos volta a parecer robô");
  assert.match(fonte, /if \(!discoveryIsDue\(workspaceId\)\) return null;/u);
  // E o carimbo vai antes de abrir o navegador: marcar só no sucesso faria a
  // falha voltar no ciclo seguinte, que é exatamente o laço a evitar.
  const marcacao = fonte.indexOf("lastDiscoveryAt.set(workspaceId, Date.now())");
  const sessao = fonte.indexOf("await createSession(");
  assert.ok(marcacao > 0 && sessao > marcacao, "o carimbo precisa vir antes da sessão");
});

test("quando a tela muda, o log diz onde o navegador parou", async () => {
  // "Não achei o iframe" não conserta nada. Host, caminho e os rótulos do menu
  // são o que permite adaptar os seletores sem estar na frente da máquina.
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /pageHost: local\.host, pagePath: local\.path/u);
  assert.match(fonte, /iframeHosts: \[\.\.\.new Set\(iframeHosts\)\], menuLabels/u);
  // Sem query string: parâmetro de URL nesse produto carrega token de sessão.
  assert.doesNotMatch(fonte, /pageSearch|url\.search/u);
});

test("as entradas da tela de Admissão passam pela allowlist de navegação", async () => {
  // Rota nova que não passa na barreira vira falha de navegação em produção, e
  // o sintoma seria idêntico ao que já enfrentamos: tela não encontrada.
  // A resolução DNS pública/privada já tem teste próprio; este teste de catálogo
  // não deve depender de a máquina de CI alcançar o DNS do fornecedor.
  const { isAllowedTangerinoHost } = await import("../lib/tangerino/navigation-security.ts");
  const { tangerinoAdmissionsEntryUrls } = await import("../lib/tangerino/hosts.ts");
  for (const entrada of tangerinoAdmissionsEntryUrls) {
    const url = new URL(entrada);
    assert.equal(url.protocol, "https:");
    assert.equal(isAllowedTangerinoHost(url.hostname), true);
  }
});

test("a rota do shell vem antes do aplicativo autônomo", async () => {
  /* Numa conta real o aplicativo autônomo redirecionava de volta ao painel do
     shell, e o worker ficava parado numa tela sem admissão nenhuma —
     `iframeCount: 0`. A rota que a conta usa é a página do shell. */
  const { tangerinoAdmissionsEntryUrls } = await import("../lib/tangerino/hosts.ts");
  assert.match(tangerinoAdmissionsEntryUrls[0], /app\.tangerino\.com\.br\/Tangerino\/pages\/admissao-demissao/u);
  // E a mesma rota sem o parâmetro logo depois: `funcionalidade` é identificador
  // do item no Wicket e pode variar entre contas e perfis de permissão.
  assert.equal(tangerinoAdmissionsEntryUrls[1], "https://app.tangerino.com.br/Tangerino/pages/admissao-demissao");
  assert.match(tangerinoAdmissionsEntryUrls[2], /admissao-demissao\.tangerino\.com\.br/u);
});

test("a lista é reconhecida mesmo sem iframe", async () => {
  // Exigir o host do aplicativo autônomo fazia o worker olhar para a tela certa
  // e concluir que não era ela. O que identifica a lista é o que ela mostra.
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /tangerinoBrowserHosts\.some\(\(allowed\) => host === allowed \|\| host\.endsWith\(`\.\$\{allowed\}`\)\)/u);
  assert.match(fonte, /for \(const candidate of tangerinoAdmissionsEntryUrls\)/u);
  // E as duas condições continuam obrigatórias: marcador da página E busca.
  assert.match(fonte, /if \(pageMarker && searchField\) return page;/u);
});

test("quando o rótulo do menu falha, o agente tenta achar Admissão por outros três caminhos", async () => {
  /* Uma conta real mostrou o menu sem "Admissão" visível ao lado das outras
     categorias (Empregador, Cadastros gerais, Financeiro, Ponto). Adivinhar um
     seletor novo e torcer teria o mesmo risco do §72 alerta: achar "alguma
     coisa" e ler o campo errado. As três rotas aqui buscam o destino por
     propriedades que sobrevivem a um rótulo de texto ausente — o endereço, o
     estado de "recolhido", e a hipótese de estar dentro de uma categoria — em
     vez de inventar uma classe CSS sem tê-la visto. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /a\[href\*="admissao-demissao" i\], a\[href\*="admissao_demissao" i\]/u, "rota B: buscar pelo endereço");
  assert.match(fonte, /\[aria-expanded="false"\]/u, "rota C: a barra pode estar recolhida");
  assert.match(fonte, /for \(const category of TangerinoSelectors\.admissionsParentCategories\)/u, "rota D: categoria-pai");
});

test("a categoria-pai mais provável é a de quem já é ou vai ser empregado", async () => {
  const { TangerinoSelectors } = await import("../lib/tangerino/selectors.ts");
  assert.equal(TangerinoSelectors.admissionsParentCategories[0], "Empregador");
});

test("o diagnóstico final separa link escondido de link inexistente", async () => {
  // "Não achei" e "não existe" têm conserto diferente: um pede expandir menu ou
  // abrir submenu; o outro pede conferir a permissão da conta usada pelo agente.
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /admissionHrefs: \[\.\.\.new Set\(admissionHrefs\)\], collapsibleCount/u);
  assert.match(fonte, /getAttribute\("title"\)\.catch\(\(\) => null\)\)\s*\n?\s*\|\| \(await candidate\.getAttribute\("aria-label"\)/u);
});

test("a busca por Admissão não depende de tipo de elemento nem de classe fixa", async () => {
  // O rótulo "Admissão" existia na tela real e não apareceu na varredura de
  // `a, [role=link], button` que gerou o diagnóstico — sinal de que o item é
  // outro tipo de elemento, ou que a classe CSS conhecida ficou desatualizada.
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /getByRole\("menuitem", \{ name: text \}\)/u);
  assert.match(fonte, /getByText\(text, \{ exact: true \}\)/u);
  // E uma segunda tentativa depois de uma pausa, para o menu que ainda monta.
  assert.match(fonte, /if \(!entry\) \{\s*\n\s*await page\.waitForTimeout\(2_500\);/u);
});

test("depois de achar Admissão, o clique em Visão geral também aceita texto sem link", async () => {
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /admissionsOverviewLinks\.map\(\(name\) => page\.getByText\(name, \{ exact: true \}\)\)/u);
});

test("a falha final distingue \"nunca foi a tela certa\" de \"faltou só um dos dois\"", async () => {
  /* Uma conta real chegou exatamente na URL pedida com "admissão" no corpo da
     página e mesmo assim a resolução falhou — sem saber qual dos dois
     (marcador de página, campo de busca) faltou, o próximo palpite seria às
     cegas de novo. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /let lastPageDiag = \{ pageIsAdmissionsApp: false, pageMarkerFound: false, searchFieldFound: false \}/u);
  assert.match(fonte, /lastPageDiag = \{ pageIsAdmissionsApp, pageMarkerFound: Boolean\(pageMarker\), searchFieldFound: Boolean\(searchField\) \}/u);
  assert.match(fonte, /\.\.\.lastPageDiag,/u);
});

test("a navegação fria para o módulo ganha o orçamento inteiro, não um teto curto", async () => {
  // Uma conta real chegou exatamente onde pedimos, com "admissão" no corpo da
  // página, e ainda assim não formou marcador+busca dentro de 15s: bootstrap
  // frio de SPA é mais lento que um clique dentro do aplicativo já carregado.
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /frame = await this\.resolveAdmissionsFrame\(tangerinoAgentConfig\(\)\.timeoutMs\);\s*\n\s*\}/u);
  // E as rotas de clique dentro do app continuam com teto curto — não há
  // bootstrap frio ali para esperar.
  assert.match(fonte, /resolveAdmissionsFrame\(Math\.min\(8_000, tangerinoAgentConfig\(\)\.timeoutMs\)\)/u);
});

test("\"Todas admissões\" prova a lista; \"Admissão\" sozinho também bate com o item de menu", async () => {
  // Uma conta real mostrou o marcador batendo com o próprio item de MENU antes
  // de a navegação sair da tela inicial — "Admissão" sozinho não prova que a
  // lista está na tela. "Todas admissões" é uma aba real, com contagem ao
  // lado no print do operador ("Todas admissões 84"), e não aparece em menu
  // nenhum — por isso o marcador aceita o número colado ao rótulo, e não só
  // o rótulo isolado.
  const { TangerinoSelectors } = await import("../lib/tangerino/selectors.ts");
  assert.equal(TangerinoSelectors.admissionsPageMarkers[0].source, /^todas admiss[õo]es(?:\s*\d+)?$/iu.source);
  assert.equal(TangerinoSelectors.admissionsPageMarkers[0].test("Todas admissões"), true);
  assert.equal(TangerinoSelectors.admissionsPageMarkers[0].test("Todas admissões 84"), true);
});

test("a descoberta desconfia de cinco cartões coincidirem com a contagem de Dados contratuais", async () => {
  /* Duas execuções reais seguidas acharam exatamente 5 cartões, sempre
     "Admissão concluída" — e a conta tem 84 admissões, só 5 delas em Dados
     contratuais. A suspeita mais barata de descartar sem chutar mais um
     seletor: a leitura pode estar caindo no resumo "Admissões vencendo" do
     painel Visão Geral (que o print do operador mostrou como "4/4"), e não
     na lista real. O diagnóstico não é PII — nome de aba e contagem são
     rótulo de interface, não dado de admissão. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(fonte.indexOf("let hits = await collectSearchHits(frame);"), fonte.indexOf("return hits;\n  }\n\n  async searchAdmission"));
  assert.match(bloco, /for \(const pattern of TangerinoSelectors\.admissionsTabLabels\)/u);
  assert.match(bloco, /log\("info", "tangerino\.admissions_list_diagnostic", \{\}, \{/u);
  assert.match(bloco, /cardCount: hits\.length, tabLabelsFound: tabLabels,/u);
  // O rótulo da aba (texto de interface) é seguro no log — nunca nome de candidato.
  assert.doesNotMatch(bloco, /displayName|fullName|candidat/iu);

  assert.match(bloco, /contractDataTabClicked,/u);

  const { TangerinoSelectors } = await import("../lib/tangerino/selectors.ts");
  assert.equal(TangerinoSelectors.admissionsTabLabels.length, 8);
  assert.equal(TangerinoSelectors.admissionsTabLabels[4].test("Dados contratuais 5"), true);
});

test("a descoberta clica na aba Dados contratuais em vez de confiar na aba que ficou ativa", async () => {
  /* Com as oito abas confirmadas visíveis (admissions_list_diagnostic real),
     a suspeita da tela errada caiu — e mesmo assim só cinco cartões
     apareciam, sempre "Admissão concluída". A aba ativa por padrão não é
     "Todas admissões": é a que ficou selecionada da vez anterior. Clicar em
     "Dados contratuais" é seguro — é a mesma aba do print do operador, não
     um botão de ação — e só afeta a sessão da descoberta: `searchAdmission`
     (usado pela consulta nomeada) roda numa sessão própria e nunca chama
     `listAdmissions`. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(
    fonte.indexOf("const contractDataTab = frame.getByText"),
    fonte.indexOf("let hits = await collectSearchHits(frame);"),
  );
  assert.match(bloco, /TangerinoSelectors\.admissionsContractDataTab/u);
  assert.match(bloco, /if \(contractDataTabClicked\) \{/u);
  assert.match(bloco, /await contractDataTab\.click\(\)\.catch\(\(\) => undefined\);/u);

  const { TangerinoSelectors } = await import("../lib/tangerino/selectors.ts");
  assert.equal(TangerinoSelectors.admissionsContractDataTab.test("Dados contratuais 5"), true);
  assert.equal(TangerinoSelectors.admissionsContractDataTab.test("Concluídas 63"), false);
});

test("o clique na aba espera a barra renderizar, em vez de decidir em 1.5s que ela não existe", async () => {
  /* Uma execução real devolveu contractDataTabClicked:false no exato momento
     em que a barra de abas ainda não tinha renderizado — o diagnóstico logo
     abaixo, que roda alguns segundos depois (já com os cartões carregados),
     achou "Dados contratuais" visível com o MESMO padrão. `isVisible` sozinho
     usa 1.5s fixos; o cartão já ganha um `waitFor` com o teto configurado, e
     a aba passa a ganhar o mesmo tratamento. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(
    fonte.indexOf("const contractDataTab = frame.getByText"),
    fonte.indexOf("let hits = await collectSearchHits(frame);"),
  );
  assert.match(bloco, /const contractDataTabClicked = await contractDataTab\.waitFor\(\{/u);
  assert.match(bloco, /state: "visible", timeout: Math\.min\(10_000, tangerinoAgentConfig\(\)\.timeoutMs\),/u);
  assert.match(bloco, /\}\)\.then\(\(\) => true\)\.catch\(\(\) => false\);/u);
});

test("depois de chegar na Admissão, o worker ainda precisa clicar em Visão Geral", async () => {
  /* Confirmado por captura de tela: "Admissão" leva a uma tela intermediária
     própria ("Boa noite, OPYT!", com sugestões e atalhos), não à lista. O
     botão "Visão Geral" dessa tela é o que leva às abas de verdade. As rotas
     anteriores só clicavam nele uma vez, cedo demais para essa tela existir. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const indiceRotaE = fonte.indexOf("Rota E:");
  assert.ok(indiceRotaE > 0, "a rota de fechamento precisa existir");
  const corpo = fonte.slice(indiceRotaE);
  assert.match(corpo, /admissionsOverviewLinks\.map\(\(name\) => page\.getByRole\("button", \{ name \}\)\)/u);
  assert.match(corpo, /admissionsOverviewLinks\.map\(\(name\) => page\.getByText\(name, \{ exact: true \}\)\)/u);
});

test("a falha da descoberta loga a mensagem, não só o código", async () => {
  /* "TANGERINO_UI_CHANGED" sozinho é o mesmo código para mais de dez pontos de
     falha diferentes no cliente de navegador (openAdmissions, listAdmissions,
     searchAdmission, downloadAdmissionArtifacts, ...). Sem a mensagem —
     "a etapa X não encontrou Y" —, cada leitura do log é uma reconstrução às
     cegas de qual delas disparou. Foi exatamente essa reconstrução que tomou
     várias rodadas nesta sessão antes de a causa aparecer. */
  const fonte = await readFile(new URL("../worker/tangerino/runner.ts", import.meta.url), "utf8");
  assert.match(fonte, /import \{ safeTangerinoError \} from "\.\.\/\.\.\/lib\/tangerino\/errors\.ts";/u);
  assert.match(fonte, /const safe = safeTangerinoError\(error\);/u);
  assert.match(fonte, /errorMessage: safe\.message,/u);
});

test("a leitura de status/etapa do cartão ganha reforço quando a classe do valor muda", async () => {
  /* Chegamos até a lista de verdade e abrimos um cartão real — a falha final
     desta rodada foi "a etapa 'leitura do processo' não encontrou 'situação
     da admissão'": o rótulo existe (bate com o print real do operador,
     "Status da admissão: Em andamento"), só a classe fixa `p.info-status` não
     achou o valor ao lado dele. O reforço reaproveita a mesma estratégia que
     `readLabeledValue` já usa com sucesso — ler o pai do rótulo e descontar o
     próprio texto do rótulo — em vez de inventar uma classe CSS nova sem tê-la
     visto (§72). */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const corpo = fonte.slice(fonte.indexOf("async function readCardValue"), fonte.indexOf("async function readCardValue") + 1400);
  // A classe conhecida continua sendo a primeira tentativa.
  assert.match(corpo, /marker\.locator\("xpath=\.\."\)\.locator\(TangerinoSelectors\.cardValueCss\)\.first\(\)/u);
  // E só cai para o reforço se ela não achar nada — nunca sobrescreve um valor
  // que já veio certo pela classe conhecida.
  assert.match(corpo, /if \(await isVisible\(value\)\) \{/u);
  assert.match(corpo, /container\.replace\(label, ""\)\.replace\(\/\^\[\\s:–—-\]\+\/u, ""\)\.trim\(\)/u);
});

test("a leitura do cartão aceita o formato real de rótulo e valor em linhas consecutivas", async () => {
  const { hasCardTextLabel, readCardTextValue } = await import("../lib/tangerino/card-text.ts");
  const { TangerinoSelectors } = await import("../lib/tangerino/selectors.ts");
  // Recorte anonimizado do dump local de 22/09/2026. Espaços e linhas vazias
  // são preservados porque foram justamente o que tornou o diagnóstico
  // anterior enganoso; nenhum dado de candidato entra na fixture.
  const cardText = `Função: Assistente

Admissão concluída
 Data limite para envio dos documentos
edit
Vencida
 Status da admissão

 Concluído

 Status da etapa

Admissão concluída

Página do colaborador`;

  assert.equal(readCardTextValue(cardText, TangerinoSelectors.statusLabels), "Concluído");
  assert.equal(readCardTextValue(cardText, TangerinoSelectors.stageLabels), "Admissão concluída");
  assert.equal(hasCardTextLabel(cardText, TangerinoSelectors.statusLabels), true);
  assert.equal(hasCardTextLabel(cardText, TangerinoSelectors.stageLabels), true);
});

test("quando situação ou etapa não são achadas, o cartão vira evidência — sem PII no log", async () => {
  /* Duas rodadas reais devolveram a mesma falha mesmo depois do reforço em
     readCardValue — sinal de que o próprio rótulo não está sendo achado como
     nó de texto isolado, e não dava para saber por quê sem ver o cartão. O
     log estruturado é o que a pessoa que opera cola direto nesta conversa, e
     por isso ele não carrega texto do cartão — só sinais sem identidade
     (achou a palavra solta? quantos caracteres tem o cartão?). O que tem
     nome de pessoa só vai para o disco da própria máquina, e só quando
     FDP_TANGERINO_LOCAL_LOG_PATH está configurado. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(fonte.indexOf("if (!rawStatus || !stage) {"), fonte.indexOf("const externalAdmissionId ="));
  assert.match(bloco, /rawStatusFound: Boolean\(rawStatus\), stageFound: Boolean\(stage\)/u);
  assert.match(bloco, /cardTextLength: cardText\.length/u);
  assert.match(bloco, /statusWordLooselyPresent: hasCardTextLabel\(cardText, TangerinoSelectors\.statusLabels\)/u);
  // O log() da telemetria só recebe cardText.length — nunca cardText inteiro.
  const chamadaDoLog = bloco.slice(bloco.indexOf('log("warn"'), bloco.indexOf("});") + 3);
  assert.doesNotMatch(chamadaDoLog, /:\s*cardText\s*[,}]/u, "o texto do cartão não pode ir para o log estruturado");
  assert.match(chamadaDoLog, /cardText\.length/u);
  assert.match(bloco, /if \(localLogPath\) \{/u);
  assert.match(bloco, /card\.screenshot\(\{ path: join\(directory, "tangerino-card-field-not-found\.png"\) \}\)/u);
  assert.match(bloco, /writeFile\(join\(directory, "tangerino-card-field-not-found\.txt"\), cardText, "utf8"\)/u);
});

test("identificador do cartão tenta o link da ficha antes de desistir, e sem identificador vira evidência sem PII", async () => {
  /* `discovery.ts` recusa gravar um `card:N` sintético (identidade instável),
     e uma conta real devolveu exatamente isso para as cinco admissões lidas:
     nem `data-id` nem `id` no cartão. `ficha-colaborador/{id}` já é a rota
     que `openAdmission` e `downloadAdmissionArtifacts` usam para navegar
     direto — lê-la de um `href` do cartão é reaproveitar essa convenção, não
     inventar seletor novo. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(fonte, /async function extractFichaColaboradorId\(card: Locator\)/u);
  assert.match(fonte, /ficha-colaborador\\\/\(\[1-9\]\[0-9\]\{0,19\}\)/u);
  // Nunca clica no link — só lê o atributo href.
  const extractor = fonte.slice(
    fonte.indexOf("async function extractFichaColaboradorId"),
    fonte.indexOf("/** Lê um cartão real"),
  );
  assert.doesNotMatch(extractor, /\.click\(/u);

  const bloco = fonte.slice(fonte.indexOf("const externalAdmissionId ="), fonte.indexOf("return {\n    externalAdmissionId,"));
  assert.match(bloco, /\?\? await extractFichaColaboradorId\(card\)/u);
  assert.match(bloco, /if \(!externalAdmissionId\) \{/u);
  const chamadaDoLog = bloco.slice(bloco.indexOf('log("warn", "tangerino.card_identifier_not_found"'), bloco.indexOf("});") + 3);
  assert.doesNotMatch(chamadaDoLog, /:\s*cardText\s*[,}]/u, "o texto do cartão não pode ir para o log estruturado");
  assert.match(chamadaDoLog, /externalIdWordLooselyPresent: hasCardTextLabel\(cardText, TangerinoSelectors\.externalIdLabels\)/u);
  assert.match(bloco, /card\.screenshot\(\{ path: join\(directory, "tangerino-card-identifier-not-found\.png"\) \}\)/u);
  assert.match(bloco, /writeFile\(join\(directory, "tangerino-card-identifier-not-found\.txt"\), cardText, "utf8"\)/u);
});

test("sem nenhuma fonte técnica, o nome completo vira identificador — decisão confirmada com o DP", async () => {
  /* Uma execução real provou, nos cinco cartões lidos, que esta conta não
     expõe data-id, id, nem link algum: hrefCount 0 e nenhuma palavra de
     protocolo em lugar nenhum do texto. Perguntado, o DP escolheu nome
     completo como identificador — é o único dado estável que sobra, e o
     prefixo "nome:" deixa registrado, no banco e no log, que ele não veio de
     um protocolo da origem. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(fonte.indexOf("const trimmedDisplayName ="), fonte.indexOf("if (!externalAdmissionId) {"));
  assert.match(bloco, /const trimmedDisplayName = displayName\.trim\(\);/u);
  assert.match(bloco, /\?\? \(trimmedDisplayName \? `nome:\$\{trimmedDisplayName\}` : undefined\);/u);
  // O identificador nasce do que já estava em memória — nenhuma navegação, nenhum clique novo.
  assert.doesNotMatch(bloco, /\.click\(/u);
});

/**
 * Descoberta funcionando em produção (PR #167: recorded:5, demandsCreated:5)
 * expôs o próximo problema: o resto do caminho — autorizar anexos, baixar
 * documentos, montar a ficha — já existe e funciona, mas foi construído
 * assumindo que toda demanda tem employee_id. A demanda da descoberta nasce
 * sem colaborador de propósito (é por isso que ela existe), e isso quebra a
 * cadeia em quatro pontos: a coluna não aceita NULL, a rota de autorização
 * não reconhece o evento novo, o guard do worker recusa antes de tentar
 * buscar por nome, e o termo de busca tentaria digitar o prefixo "nome:"
 * literal no campo da Sólides.
 */

test("a coluna employee_id da autorização de anexos aceita nulo", async () => {
  const fonte = await readFile(new URL("../drizzle/postgres/0091_tangerino_attachment_employee_optional.sql", import.meta.url), "utf8");
  assert.match(fonte, /ALTER TABLE "fdp_tangerino_attachment_authorizations" ALTER COLUMN "employee_id" DROP NOT NULL;/u);
});

test("a rota de autorização reconhece a demanda da descoberta, sem exigir employee_id", async () => {
  const fonte = await readFile(new URL("../app/api/cards/[id]/solides-attachments/authorize/route.ts", import.meta.url), "utf8");
  assert.match(fonte, /employee_id: string \| null;/u);
  assert.match(fonte, /admission\.open_contract_data_ready/u);
  // O filtro final não pode mais exigir employee_id — só quem a origem 1/2 já garante.
  assert.doesNotMatch(fonte, /length\(COALESCE\(employee_id, ''\)\) > 0/u);
  assert.match(fonte, /WHERE length\(COALESCE\(integration_id, ''\)\) > 0/u);
});

test("o worker de anexos aceita nome extraído do título da demanda, não só empregado ou ID numérico", async () => {
  const fonte = await readFile(new URL("../lib/tangerino/attachments-worker.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(fonte.indexOf("const [employee, credential, integration]"), fonte.indexOf("const config = tangerinoAgentConfig();"));
  assert.match(bloco, /const legacyName = employee \? "" : legacyAdmissionNameFromCard\(claimed\.card_title, claimed\.card_description\);/u);
  assert.match(bloco, /if \(!employee && !legacyName && !\/\^\[1-9\]\[0-9\]\{0,119\}\$\/u\.test\(claimed\.external_admission_id\)\) \{/u);
});

test("o termo de busca nunca digita o prefixo nome: no campo da Sólides", async () => {
  /* `nome:Fulano de Tal` é estável o bastante para gravar e desduplicar
     (PR #164) — não para pesquisar: datilografado no campo da Sólides, o
     prefixo por si só já garante zero resultado. */
  const fonte = await readFile(new URL("../lib/tangerino/parser.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(
    fonte.indexOf("export function admissionSearchTerm"),
    fonte.indexOf("export function legacyAdmissionNameFromCard"),
  );
  assert.match(bloco, /!rawExternalId\.startsWith\("nome:"\)/u);

  const { admissionSearchTerm } = await import("../lib/tangerino/parser.ts");
  assert.equal(
    admissionSearchTerm({ externalAdmissionId: "nome:Fulano de Tal", registrationNumber: "", fullName: "Fulano de Tal" }),
    "Fulano de Tal",
  );
  assert.equal(
    admissionSearchTerm({ externalAdmissionId: "ADM-4711", registrationNumber: "", fullName: "Fulano de Tal" }),
    "ADM-4711",
  );
});

test("o download abre o cartão antes de desistir por falta de ID", async () => {
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(
    fonte.indexOf("async downloadAdmissionArtifacts"),
    fonte.indexOf("const formPage = await this.context?.newPage()"),
  );
  assert.match(bloco, /admissionId = await extractFichaColaboradorId\(this\.selectedAdmissionCard\) \?\? "";/u);
  assert.match(bloco, /page\.on\("request", observeAdmissionRequest\)/u);
  assert.match(bloco, /admissionIdFromRequest\(sentArchiveRequest\.url\(\), sentArchiveRequest\.postData\(\)\)/u);
  assert.match(bloco, /exportRegistrationFormFromScope\(scope\)/u);
  const clique = bloco.indexOf("await openDocuments.click()");
  const falha = bloco.indexOf('throw tangerinoErrors.uiChanged("download da ficha cadastral", "identificador numérico após abrir o cartão")');
  assert.ok(clique > 0 && falha > clique, "a falta de ID só pode falhar depois de abrir o cartão");
});

test("o ID da ficha vem apenas de rota ou campo semanticamente identificado", async () => {
  const { admissionIdFromRequest } = await import("../worker/tangerino/playwright-session.ts");
  assert.equal(admissionIdFromRequest("https://admissao-demissao.tangerino.com.br/ficha-colaborador/194851", null), "194851");
  assert.equal(admissionIdFromRequest("https://apis.tangerino.com.br/api/v1/documentos/admissao/download-zip",
    JSON.stringify({ idAdmissao: 194851 })), "194851");
  assert.equal(admissionIdFromRequest("https://apis.tangerino.com.br/api/v1/documentos/admissao/download-zip",
    JSON.stringify({ cpf: 12345678901, documentoId: 77 })), null);
  assert.equal(admissionIdFromRequest("https://apis.tangerino.com.br/qualquer/12345", null), null);
});

test("a coluna authorized_by_user_id da autorização de anexos aceita nulo", async () => {
  const fonte = await readFile(new URL("../drizzle/postgres/0092_tangerino_attachment_auto_authorize.sql", import.meta.url), "utf8");
  assert.match(fonte, /ALTER TABLE "fdp_tangerino_attachment_authorizations" ALTER COLUMN "authorized_by_user_id" DROP NOT NULL;/u);
});

test("a demanda nasce já autorizada — sem exigir o clique em Autorizar anexos da Sólides", async () => {
  /* Pedido direto do DP: a admissão descoberta não tem colaborador nem uma
     pessoa clicando no instante em que a demanda nasce, então
     employee_id e authorized_by_user_id ficam nulos pelo mesmo motivo do
     cartão. A tela (`fila-dp-db.ts`) só lê `state` para decidir o que
     mostrar — nunca quem autorizou — e o worker de anexos já sabe seguir
     sem colaborador desde a PR #168, então a fila do worker processa esta
     autorização exatamente como processaria uma criada por um clique. */
  const fonte = await readFile(new URL("../lib/tangerino/open-admissions.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(fonte.indexOf("await d1.batch(["), fonte.indexOf("return { status: \"created\", cardId };"));
  assert.match(bloco, /INSERT INTO fdp_tangerino_attachment_authorizations/u);
  assert.match(bloco, /VALUES \(\?, \?, \?, NULL, \?, \?, NULL\)/u);
  assert.match(bloco, /\.bind\(authorizationId, input\.workspaceId, cardId, input\.integrationId, externalAdmissionId\)/u);
  assert.match(bloco, /tangerino\.attachments\.authorized/u);
  assert.match(bloco, /auto: true/u);
});

test("a descoberta cura sozinha as demandas antigas que ficaram sem autorização de anexos", async () => {
  /* Pedido do DP: os cinco cartões que a descoberta criou antes da PR #169
     não têm autorização nenhuma — e ninguém quer clicar em "Autorizar
     anexos" um por um. Em vez de um script de migração único, cada ciclo da
     descoberta verifica e completa sozinho: mais barato do que pedir cinco
     cliques, e cobre qualquer lacuna futura pelo mesmo motivo. */
  const fonte = await readFile(new URL("../lib/tangerino/open-admissions.ts", import.meta.url), "utf8");
  const funcao = fonte.slice(
    fonte.indexOf("export async function ensureOpenAdmissionAttachmentAuthorization"),
    fonte.length,
  );
  assert.match(funcao, /WHERE NOT EXISTS \(\s*SELECT 1 FROM fdp_tangerino_attachment_authorizations existing\s*WHERE existing\.workspace_id = \? AND existing\.card_id = \?\s*\)/u);
  // Uma falha automática anterior ganha uma única retomada; attempt 2 encerra o laço.
  assert.match(funcao, /existing\.authorized_by_user_id IS NULL/u);
  assert.match(funcao, /existing\.state = 'FAILED' AND existing\.attempt < 2/u);
  assert.match(funcao, /SET state = 'QUEUED'/u);

  const discoveryFonte = await readFile(new URL("../lib/tangerino/discovery.ts", import.meta.url), "utf8");
  const loop = discoveryFonte.slice(discoveryFonte.indexOf("if (!record) { summary.skipped"), discoveryFonte.indexOf("if (!isContractDataStage(admission.stage)) continue;"));
  assert.match(loop, /if \(record\.cardId\) \{/u);
  assert.match(loop, /await ensureOpenAdmissionAttachmentAuthorization\(d1, \{/u);
  assert.match(loop, /backfill\.status === "created" \|\| backfill\.status === "requeued"/u);
  assert.match(loop, /continue;/u);
});

test("quando nem a busca expõe o identificador numérico da ficha, o cartão vira evidência — sem PII no log", async () => {
  /* Uma execução real falhou exatamente neste ponto — mesmo com o cartão
     vindo da busca por nome, não do resultado sem filtro — e não deixou
     rastro nenhum: este era o único ponto de falha do arquivo sem screenshot
     nem log estruturado, só a mensagem repetida. */
  const fonte = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  const finalLog = fonte.indexOf('log("warn", "tangerino.download_identifier_not_found"');
  const bloco = fonte.slice(fonte.lastIndexOf("if (!admissionId) {", finalLog),
    fonte.indexOf("const formPage = await this.context?.newPage()"));
  assert.match(bloco, /log\("warn", "tangerino\.download_identifier_not_found", \{\}, \{/u);
  assert.match(bloco, /documentArchiveReceived: true/u);
  assert.match(bloco, /exportButtonWordLooselyPresent: hasCardTextLabel\(cardText, TangerinoSelectors\.exportRegistrationFormButtons\)/u);
  // O log() da telemetria não pode receber o texto do cartão — só o comprimento.
  const chamadaDoLog = bloco.slice(bloco.indexOf('log("warn", "tangerino.download_identifier_not_found"'), bloco.indexOf("});") + 3);
  assert.doesNotMatch(chamadaDoLog, /:\s*cardText\s*[,}]/u, "o texto do cartão não pode ir para o log estruturado");
  assert.match(chamadaDoLog, /cardText\.length/u);
  assert.match(bloco, /if \(localLogPath && card\) \{/u);
  assert.match(bloco, /card\.screenshot\(\{ path: join\(directory, "tangerino-download-identifier-not-found\.png"\) \}\)/u);
  assert.match(bloco, /writeFile\(join\(directory, "tangerino-download-identifier-not-found\.txt"\), cardText, "utf8"\)/u);
});
