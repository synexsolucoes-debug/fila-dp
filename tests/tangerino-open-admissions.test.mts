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
  const { assertAllowedTangerinoUrl } = await import("../lib/tangerino/navigation-security.ts");
  const { tangerinoAdmissionsEntryUrls } = await import("../lib/tangerino/hosts.ts");
  for (const entrada of tangerinoAdmissionsEntryUrls) {
    const url = await assertAllowedTangerinoUrl(entrada);
    assert.equal(url.protocol, "https:");
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
