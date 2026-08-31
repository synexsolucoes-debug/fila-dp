import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A demanda nasce do processo (§10).
 *
 * PROCESSO é o modelo; DEMANDA é uma execução real dele (§4). Antes, o botão
 * "+ Nova demanda" abria um formulário que não conhecia o catálogo: o campo
 * "Tipo de processo" era uma lista de textos fixos — CONCILIAÇÃO CADASTRAL,
 * RESCISÃO, FÉRIAS — escrita no componente, sem relação nenhuma com os
 * processos publicados. Dava para criar uma "Admissão" que não executava o
 * processo de admissão publicado, e ninguém notaria até a demanda chegar sem
 * etapa nenhuma na mão de quem ia executá-la.
 *
 * Estes testes protegem as três decisões que sustentam a ligação: a origem é a
 * versão publicada, a criação passa pelo motor que já instancia, e o formulário
 * não reimplementa nada do que a versão decide.
 */

const painel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");

test("a criação a partir de processo passa pelo motor que instancia a versão", async () => {
  /* Reimplementar aqui a montagem de etapas e tarefas faria a demanda criada
     pela tela divergir da criada por integração ou automação — que passam por
     este mesmo endpoint. Uma segunda implementação da mesma regra sempre acaba
     sendo a que ninguém lembra de atualizar. */
  assert.match(painel, /\/api\/processes\/versions\/\$\{encodeURIComponent\(cardForm\.processVersionId\)\}\/instantiate/u);
  assert.match(painel, /trigger: "manual"/u);
  // E o motor continua sendo o mesmo que a API usa.
  const rota = await readFile(
    new URL("../app/api/processes/versions/[id]/instantiate/route.ts", import.meta.url), "utf8");
  assert.match(rota, /prepareProcessInstance\(d1, \{/u);
});

test("só processo publicado e de início manual pode originar demanda", () => {
  /* Rascunho não vira demanda (§8.3): oferecer um na lista seria um caminho que
     o servidor recusa depois do clique — o pior tipo de botão, o que promete e
     não cumpre. */
  assert.match(painel, /String\(versao\.status\) !== "published"\) return \[\]/u);
  assert.match(painel, /processo\.allowManualStart === false\) return \[\]/u);
  assert.match(painel, /processo\.active === false\) return \[\]/u);
});

test("o catálogo é lido da API de processos, e não escrito no componente", () => {
  /* §12: a demanda usa os processos publicados do workspace; ela não mantém uma
     segunda lista. A lista fixa que existia antes é justamente o defeito. */
  assert.match(painel, /fetch\("\/api\/processes", \{ cache: "no-store" \}\)/u);
  assert.match(painel, /const \[startableProcesses, setStartableProcesses\] = useState<StartableProcess\[\] \| null>\(null\)/u);
});

test("o catálogo não entra no snapshot de abertura", () => {
  /* Ele cresce com a operação, e quase toda visita ao painel não abre a modal
     de criação. Trazê-lo na abertura faria todo mundo pagar por uma tela que
     poucos abrem — o mesmo motivo do histórico. */
  assert.match(painel, /if \(!cardModalOpen \|\| startableProcesses !== null\) return;/u);
});

test("escolher um processo esconde os campos que ele passa a decidir", () => {
  /* Oferecer "Coluna" e "Tipo de processo" numa demanda que vem de processo
     seria pedir uma escolha que o servidor ignora ao instanciar a versão.
     Controle que não controla é pior que controle nenhum: ensina a desconfiar
     dos outros. */
  assert.match(painel, /\{!cardForm\.processVersionId &&\s*\n?\s*<label>Tipo de processo/u);
  assert.match(painel, /\{!cardForm\.processVersionId && <label>Coluna/u);
  assert.match(painel, /\{!selectedCard && !cardForm\.processVersionId && <label className="full">Começar com um template/u);
});

test("a lista é agrupada por área, que é quem responde pelo trabalho", () => {
  /* §4: ÁREA → PROCESSO. Sem o agrupamento, duas áreas com um processo de mesmo
     nome apareceriam como a mesma linha repetida, e não haveria como escolher
     a certa. */
  assert.match(painel, /<optgroup label=\{area\} key=\{area\}>/u);
  assert.match(painel, /\[\.\.\.new Set\(startableProcesses\.map\(\(item\) => item\.areaName\)\)\]\.sort\(\)/u);
});

test("demanda avulsa continua possível", () => {
  /* Nem todo trabalho tem processo modelado, e exigir um transformaria a
     modelagem em pedágio para registrar o que chegou. O caminho antigo fica. */
  assert.match(painel, /<option value="">Demanda avulsa — sem processo<\/option>/u);
  assert.match(painel, /const next = await mutate\("\/api\/cards", \{ method: "POST", body: JSON\.stringify\(cardForm\) \}/u);
});

test("abrir demanda existente não oferece troca de processo", () => {
  /* Trocar a versão de uma demanda em andamento reescreveria as etapas por
     baixo de quem está executando. A versão instanciada é imutável (§8.3). */
  assert.match(painel, /\{!selectedCard && startableProcesses !== null && startableProcesses\.length > 0 &&/u);
  assert.match(painel, /processVersionId: "",\s*\n\s*assigneeIds: card\.assignees/u);
});

test("falha ao carregar o catálogo não impede criar demanda", () => {
  /* Perder o atalho é bem menos grave que travar a criação: quem precisa
     registrar o que chegou registra, e o processo entra depois. */
  assert.match(painel, /\} catch \{\s*\n\s*if \(!cancelado\) setStartableProcesses\(\[\]\);/u);
});
