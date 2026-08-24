import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("a barra lateral volta a acompanhar a rolagem", async () => {
  const access = await read("app/access.css");
  // A causa era `overflow-x: hidden` no pai imediato da barra. A implementação
  // atual eliminou o overflow do shell; o recorte global do documento não
  // transforma esse shell no contêiner de rolagem do sticky.
  const rules = access.replace(/\/\*[\s\S]*?\*\//gu, "");
  const shellRules = [...rules.matchAll(/\.dashboard-shell[^,{]*\{([^}]*)\}/gu)];
  assert.ok(shellRules.length > 0, "a folha precisa declarar o shell do painel");
  for (const rule of shellRules) {
    assert.doesNotMatch(rule[1], /overflow-x:\s*hidden/u,
      "o shell não pode voltar a ser contêiner de rolagem do sticky");
  }

  const refresh = await read("app/interface-refresh.css");
  // Menu mais alto que a tela precisa rolar dentro da própria barra; sem isso o
  // último módulo fica inalcançável mesmo com o sticky funcionando.
  // A regra vale só a partir de 761px: abaixo disso a barra vira faixa no topo
  // e uma altura global aqui venceria as regras que fazem isso.
  assert.match(refresh, /@media \(min-width: 761px\)/u);
  const sidebar = refresh.split(".dashboard-sidebar {").at(1)?.split("}").at(0) ?? "";
  assert.match(sidebar, /position:\s*sticky/u);
  assert.match(sidebar, /height:\s*100dvh/u);
  assert.match(sidebar, /overflow-y:\s*auto/u);
  assert.match(sidebar, /overscroll-behavior:\s*contain/u);

  // O console global tem a mesma barra e o mesmo problema.
  const console_ = await read("app/plataforma/platform.module.css");
  assert.match(console_, /\.sideNav\s*\{[^}]*overflow-y:\s*auto/u);
});

test("a camada de refinamento é carregada por último", async () => {
  const layout = await read("app/layout.tsx");
  const order = ["./globals.css", "./access.css", "./dashboard-modern.css", "./interface-refresh.css"]
    .map((file) => layout.indexOf(file));
  assert.ok(order.every((position) => position > 0), "alguma folha deixou de ser importada");
  // A camada corrige o que as anteriores acumularam: fora de ordem, ela perde.
  assert.deepEqual([...order].sort((a, b) => a - b), order, "interface-refresh.css precisa ser a última");
});

test("trocar de módulo remonta o bloco, senão a animação não roda", async () => {
  const workspace = await read("app/painel/WorkspaceApp.tsx");
  const motion = await read("app/painel/features/shared/motion.tsx");
  // O shell atual centraliza a remontagem no componente de transição.
  assert.match(workspace, /<PageTransition transitionKey=\{view\}/u);
  assert.match(motion, /<div key=\{transitionKey\}/u);

  const platform = await read("app/plataforma/PlatformApp.tsx");
  assert.match(platform, /className=\{styles\.featureStage\} key=\{area\}/u);
});

test("quem pediu menos movimento continua recebendo a interface inteira", async () => {
  const refresh = await read("app/interface-refresh.css");
  assert.match(refresh, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(refresh, /animation-duration:\s*1ms\s*!important/u);
  const console_ = await read("app/plataforma/platform.module.css");
  assert.match(console_, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("os tons de estado têm um par por tema, não HEX claro fixo", async () => {
  const refresh = await read("app/interface-refresh.css");
  // Um chip #FFF0DF no meio de uma tela escura ofusca e rouba a atenção do
  // conteúdo. Com par nomeado, o tema troca fundo e texto juntos.
  for (const token of ["--tone-safe-surface", "--tone-safe-text", "--tone-warn-surface",
    "--tone-warn-text", "--tone-danger-surface", "--tone-danger-text"]) {
    const declarations = refresh.split(`${token}:`).length - 1;
    assert.equal(declarations, 2, `${token} precisa existir no tema claro e no escuro`);
  }
  // O crachá de contagem era branco sobre #ef5b5b: 3.32:1, reprovado. Sobre
  // #C5342E o mesmo branco dá 5.38:1 e o vermelho continua lendo como alerta.
  assert.match(refresh, /--ui-badge-surface: #C5342E/u);
  assert.match(refresh, /nav button b,[\s\S]{0,40}nav a b \{[^}]*background: var\(--ui-badge-surface\)/u);
});

test("excluir um grupo é encontrável antes de ser possível", async () => {
  const clients = await read("app/plataforma/features/ClientsFeature.tsx");
  // A zona de risco só existia depois que o grupo já estava arquivado. Quem
  // procurava a opção num grupo ativo não achava nada e não descobria o que
  // faltava fazer. A porta continua a mesma; agora ela é visível e explica.
  assert.doesNotMatch(clients, /\{\["archived", "canceled"\]\.includes\(status\) &&/u);
  assert.match(clients, /const DELETABLE = new Set\(\["archived", "canceled"\]\)/u);
  assert.match(clients, /Arquivar agora/u);
  // Listagem e detalhe abrem a mesma confirmação: duas cópias divergiriam na
  // primeira vez que alguém ajustasse o texto de impacto, que é o que segura o
  // clique.
  assert.match(clients, /function deleteWorkspaceAction\(/u);
  assert.match(clients, /typedConfirmation: text\(workspace\.slug\)/u);
  assert.match(clients, /reasonMinLength: 10/u);
});

test("a exclusão relata o que foi apagado, com os números do servidor", async () => {
  const clients = await read("app/plataforma/features/ClientsFeature.tsx");
  // O servidor conta antes de apagar justamente para que a operação possa ser
  // conferida depois; esconder o número na interface joga fora essa prova.
  assert.match(clients, /const \{ rows, tables, orphanUsers \} = payload\.deleted/u);
  assert.match(clients, /registro\(s\) em \$\{tables\} tabela\(s\)/u);

  const route = await read("app/api/platform/workspaces/[id]/delete/route.ts");
  assert.match(route, /rows: totalRows \+ orphanIds\.length/u);
  assert.match(route, /orphanUsers: orphanIds\.length/u);
});
