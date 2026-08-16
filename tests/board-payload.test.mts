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
  assert.match(source, /ORDER BY ae\.created_at DESC LIMIT 150/u);
  assert.match(source, /fdp_planner_blocks[\s\S]{0,200}LIMIT 300/u);
  assert.match(source, /fdp_notifications[\s\S]{0,200}LIMIT 50/u);
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
