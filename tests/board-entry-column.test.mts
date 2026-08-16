import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §39: a escrita operacional, medida de ponta a ponta.
 *
 * As sessenta conferências de navegador cobriam navegação, permissão, recorte,
 * relatório e SEO — nenhuma escrevia. Criar demanda é a ação central do produto
 * e nenhuma prova a exercitava: se o formulário quebrasse, tudo continuaria
 * verde.
 *
 * O ensaio de ponta a ponta encontrou um defeito real no primeiro dia.
 * `POST /api/cards` sem `listId` caía em `kind = 'new'` e devolvia 404 se essa
 * coluna não existisse. O quadro nasce com ela, mas o administrador pode
 * apagá-la: a exclusão de coluna só exige que sobre uma. Reproduzido contra o
 * produto de pé — apagada a "Novas demandas", o botão da barra superior passava
 * a devolver "Coluna não encontrada", com o quadro ainda tendo duas colunas e
 * aparência normal.
 */

const rota = await readFile(new URL("../app/api/cards/route.ts", import.meta.url), "utf8");

test("qualquer quadro com uma coluna recebe demanda", () => {
  // A coluna de entrada primeiro; na falta dela, a primeira do quadro.
  assert.match(rota, /ORDER BY \(kind = 'new'\) DESC, position, id/u);
  assert.doesNotMatch(rota, /WHERE board_id = \? AND kind = 'new'"/u,
    "voltou a depender de uma coluna que o administrador pode apagar");
});

test("quadro sem coluna nenhuma diz o que fazer", () => {
  // "Coluna não encontrada" nomeia algo que a pessoa não pediu. A mensagem
  // precisa dizer o que aconteceu e qual é o próximo passo.
  assert.match(rota, /Este quadro não tem nenhuma coluna\. Crie uma coluna antes de abrir demandas\./u);
});

test("a exclusão de coluna continua exigindo que sobre uma", async () => {
  // A correção é do lado da criação, de propósito: restringir o que o
  // administrador pode apagar seria tirar liberdade para contornar um defeito
  // que já não existe.
  const lists = await readFile(new URL("../app/api/lists/[id]/route.ts", import.meta.url), "utf8");
  assert.match(lists, /O quadro precisa manter pelo menos uma coluna\./u);
});

test("a semente usa os mesmos formatos de coluna que o produto cria", async () => {
  // Ela usava `todo`/`doing`/`done`, que o produto nunca gera. O ensaio criava
  // demanda num formato de quadro que nenhum cliente tem, e o defeito real
  // ficava escondido atrás do artificial.
  const boards = await readFile(new URL("../app/api/boards/route.ts", import.meta.url), "utf8");
  assert.match(boards, /\["Novas demandas", "new", "running"\]/u);
  const seed = await readFile(new URL("../scripts/seed-ui-fixture.mjs", import.meta.url), "utf8");
  assert.match(seed, /\["l-ui-1", "Novas demandas", "new"\]/u);
  assert.doesNotMatch(seed, /"todo"|"doing"/u);
});

test("a verificação de navegador escreve, recarrega e confere a trilha", async () => {
  const check = await readFile(new URL("../scripts/browser-check.mjs", import.meta.url), "utf8");
  assert.match(check, /a demanda criada aparece no quadro/u);
  // A recarga é o que separa "ficou no estado do React" de "persistiu".
  assert.match(check, /a demanda sobrevive à recarga da página/u);
  assert.match(check, /await page\.reload\(/u);
  // E depois da recarga o painel reabre na Visão geral: sem voltar a Demandas,
  // a conferência mediria "o título aparece na primeira tela que carregar".
  assert.match(check, /painel reabre na Visão geral/u);
  assert.match(check, /a criação entra na atividade recente/u);
});
