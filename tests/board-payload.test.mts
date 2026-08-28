import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * O painel entregava o quadro inteiro numa resposta só, incluindo tudo que
 * pendurava nas demandas arquivadas.
 *
 * Medido contra PostgreSQL com um ano de operação de uma empresa — 2.400
 * demandas, sendo 500 ativas e 1.900 arquivadas:
 *
 *   antes:  4,01 MB · 0,686 s   (arquivadas = 3,49 MB, 87% do payload)
 *   depois: 2,30 MB · 0,334 s   (redução de 43%, metade do tempo)
 *
 * O que saiu foram 7.600 itens de checklist e 3.800 comentários de demandas
 * arquivadas — conteúdo que a gaveta de arquivados não mostra. Ela renderiza
 * processo, título, empresa e data, e é isso que continua vindo.
 *
 * Estes testes protegem o filtro. Uma consulta por cartão que volte a varrer o
 * quadro inteiro traz o arquivo junto, e o payload cresce sem ninguém notar até
 * o cliente com histórico reclamar de lentidão.
 */

const source = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");

/** Trecho do snapshot: da montagem das consultas até o mapeamento dos cartões. */
const snapshot = source.slice(source.indexOf("const [boardsResult"), source.indexOf("const cards = cardRows.map"));

test("as coleções por cartão não carregam o que pende de demanda arquivada", () => {
  // Cada uma destas junta em fdp_cards para varrer o quadro. Sem o filtro, elas
  // trazem o arquivo inteiro.
  const perCard = [
    { nome: "checklist", marca: "FROM fdp_checklist_items" },
    { nome: "comentários", marca: "FROM fdp_card_comments" },
    { nome: "responsáveis", marca: "FROM fdp_card_assignees" },
    { nome: "anexos", marca: "FROM fdp_card_attachments" },
  ];

  for (const { nome, marca } of perCard) {
    const inicio = snapshot.indexOf(marca);
    assert.notEqual(inicio, -1, `consulta de ${nome} não encontrada no snapshot`);
    const consulta = snapshot.slice(inicio, snapshot.indexOf(".bind(", inicio));
    assert.match(consulta, /c\.archived = 0/u, `a consulta de ${nome} precisa excluir demandas arquivadas`);
  }
});

test("o cartão arquivado continua trazendo o que a gaveta mostra", async () => {
  // A gaveta renderiza processo, título, empresa e data de arquivamento. Se o
  // mapeamento parar de montar esses campos, ela fica em branco.
  const mapping = source.slice(source.indexOf("const cards = cardRows.map"));
  const body = mapping.slice(0, mapping.indexOf("  }));"));
  for (const campo of ["processType:", "title:", "company:", "updatedAt:", "archived:", "listId:"]) {
    assert.match(body, new RegExp(campo.replace(":", "\\s*:"), "u"), `a gaveta depende de ${campo}`);
  }

  const painel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(painel, /snapshot\.archivedCards\.map/u, "a gaveta continua listando os arquivados");
});

test("o arquivo continua completo: o filtro corta o conteúdo, não as demandas", () => {
  // `archivedCards` sai do mesmo conjunto de cartões. Trocar isso por uma
  // consulta com LIMIT esconderia demandas arquivadas sem avisar.
  assert.match(source, /archivedCards: cards\.filter\(\(card\) => card\.archived\)/u);
});

test("as consultas com teto continuam com teto", () => {
  // Atividades, planner e notificações já eram limitadas. Um filtro novo não
  // pode ter afrouxado nenhuma delas.
  //
  // O teto de atividades deixou de ser o literal `150` e passou a ser a
  // constante `SNAPSHOT_ACTIVITY_LIMIT` (§37) — a asserção acompanha a mudança
  // deliberada e continua exigindo que o teto exista e valha 150.
  assert.match(source, /ORDER BY ae\.created_at DESC LIMIT \?/u);
  assert.match(source, /SNAPSHOT_ACTIVITY_LIMIT = 150/u);
  assert.match(source, /fdp_planner_blocks[\s\S]{0,200}LIMIT 300/u);
  assert.match(source, /fdp_notifications[\s\S]{0,200}LIMIT 50/u);
});

test("o histórico sem teto ganhou janela — e a janela é declarada", () => {
  // Comentário e caixa de entrada vinham inteiros e crescem para sempre (§37).
  assert.match(source, /SNAPSHOT_HISTORY_DAYS = 90/u);
  assert.match(source, /fdp_card_comments[\s\S]{0,400}make_interval\(days => \?\)/u,
    "os comentários precisam de janela temporal");
  assert.match(source, /fdp_workspace_inbox_items[\s\S]{0,300}make_interval\(days => \?\)/u,
    "a caixa de entrada precisa de janela temporal");
  assert.match(source, /SNAPSHOT_COMMENT_LIMIT/u);
  assert.match(source, /SNAPSHOT_INBOX_LIMIT/u);
});

test("a janela nunca esconde que existe registro mais antigo", () => {
  // §39 é explícito: pode haver janela, não pode haver omissão silenciosa.
  assert.match(source, /history:\s*\{/u, "o snapshot precisa declarar a janela");
  assert.match(source, /comments_total/u);
  assert.match(source, /inbox_total/u);
  assert.match(source, /activity_total/u);
});

test("o filtro usa a coluna, não uma comparação frágil", () => {
  // `archived` é integer 0/1 no schema. Comparar com `false` ou com string
  // passaria no TypeScript e falharia no PostgreSQL.
  const ocorrencias = source.match(/c\.archived\s*=\s*[^\s]+/gu) ?? [];
  assert.ok(ocorrencias.length >= 4, `esperava ao menos 4 filtros, encontrei ${ocorrencias.length}`);
  for (const ocorrencia of ocorrencias) {
    assert.match(ocorrencia, /c\.archived = 0/u, `filtro inesperado: ${ocorrencia}`);
  }
});

test("o cartão do quadro mostra processo, etapa e progresso (spec: Demandas)", async () => {
  /* A especificação pede ID, processo, etapa, responsável, prazo, progresso e
     status no cartão. Etapa e progresso já vinham calculados no servidor em
     `ProcessFlowSummary` — `stepLabel`, `tasksDone`, `tasksTotal` — e não
     chegavam à tela. Isto cobra o caminho até o cartão, não o cálculo. */
  const tela = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");

  assert.match(tela, /function CardProcessLine\(\{ flow \}: \{ flow: ProcessFlowSummary \}\)/u);
  assert.match(tela, /\{flow\.tasksDone\} de \{flow\.tasksTotal\} tarefas/u);

  /* Sem tarefa nenhuma o percentual não aparece: 0% num cartão recém-criado
     parece atraso, quando é só ausência de item. */
  assert.match(tela, /flow\.tasksTotal > 0 \? Math\.round\(\(flow\.tasksDone \/ flow\.tasksTotal\) \* 100\) : null/u);
  assert.match(tela, /pct !== null && <span className="dashboard-card-progress"/u);

  /* Processo e etapa são coisas diferentes (§38): a etapa é o rótulo visível, o
     processo e a versão ficam no title, para não competir com ela na varredura. */
  assert.match(tela, /title=\{`Processo: \$\{flow\.definitionName\} • versão \$\{flow\.versionNumber\}`\}/u);
});

test("o progresso da demanda tem denominador fixo, vindo do desenho", async () => {
  /* "7 de 18": o 18 é o que a versão prevê no processo inteiro, não o que as
     etapas percorridas já materializaram. A versão é imutável, então o
     denominador não se move enquanto a demanda anda — fração cujo fundo muda
     não se lê como avanço. */
  const db = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.match(db, /const plannedTasksByVersion = new Map<string, number>\(\)/u);
  assert.match(db, /const tasksTotal = Math\.max\(previstas, materializadas\)/u,
    "versão sem configuração de etapa precisa recair no materializado; '7 de 0' seria pior");
});

test("o total previsto usa a mesma stepChecklist da execução", async () => {
  /* Quem decide o que vira tarefa é `stepChecklist`: ela une checklist e
     documentos da etapa e deduplica. Somar em SQL daria um número próximo e
     errado — e um progresso de "20 de 18". */
  const db = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.match(db, /import \{ stepChecklist \} from "\.\/process-instances"/u);
  assert.match(db, /const previstas = stepChecklist\(\{/u);
  assert.ok(!/SUM\(jsonb_array_length/u.test(db),
    "somar o checklist em SQL divergiria da regra que a execução aplica");
});
