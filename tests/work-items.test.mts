import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { panelPath, parsePanelPath } from "../lib/panel-routes.ts";
import {
  buildWorkCenterQuery, buildWorkCountsQuery, buildWorkGroupQuery, buildWorkItemQuery,
  cursorForRow, decodeWorkCursor, emptyWorkItemFilters, encodeWorkCursor, sortWorkItems,
  toWorkItem, WORK_ITEM_COLUMNS, WORK_ITEM_MAX_PAGE, workItemGroupKey, workItemHref,
  workItemSources, type WorkItemFilters, type WorkItemSort,
} from "../lib/work-items.ts";

/* A Central de Trabalho é camada de **leitura**. Os testes abaixo protegem as
   propriedades que a impedem de virar o quinto objeto de trabalho: ela não
   escreve, ela cobre as fontes que já existem, o escopo de empresa é aplicado
   no SQL — não em memória depois de carregar tudo — e a página é uma página, e
   não a fila inteira disfarçada. */

const base = {
  sources: workItemSources, workspaceId: "w1", userId: "u1",
  companyIds: null as readonly string[] | null,
};

const filters = (overrides: Partial<WorkItemFilters> = {}): WorkItemFilters =>
  ({ ...emptyWorkItemFilters, scope: "team", ...overrides });

const centerQuery = (overrides: {
  filters?: Partial<WorkItemFilters>; sort?: WorkItemSort; cursor?: string[]; limit?: number;
} = {}) => buildWorkCenterQuery({
  ...base,
  filters: filters(overrides.filters),
  sort: overrides.sort ?? "urgency",
  cursor: overrides.cursor ?? [],
  limit: overrides.limit ?? 25,
})!;

/* -------------------------------------------------------------------------- *
 * Fontes
 * -------------------------------------------------------------------------- */

test("a central cobre os objetos de trabalho que a auditoria encontrou", () => {
  const keys = workItemSources.map((source) => source.key);
  for (const expected of ["card", "movement", "approval", "auxiliary", "pending_item", "triage"]) {
    assert.ok(keys.includes(expected as typeof keys[number]), `fonte ausente: ${expected}`);
  }
});

test("falha operacional que exige ação humana também é trabalho (§4)", () => {
  // Execução que esgotou as tentativas não segue sozinha. Se ela só existisse na
  // tela de integrações, ficaria esperando alguém abrir aquela tela por acaso.
  const failure = workItemSources.find((source) => source.key === "integration_failure");
  assert.ok(failure, "as falhas de execução ficaram de fora da Central");
  assert.match(failure!.sql, /dead_letter/u);
  assert.equal(workItemHref("integration_failure", "j1"), "/painel/agentes?execucao=j1");
});

test("nenhuma fonte escreve: a central agrega, ela não opera", async () => {
  const source = await readFile(new URL("../lib/work-items.ts", import.meta.url), "utf8");
  for (const forbidden of [/\bINSERT\s+INTO\b/iu, /\bUPDATE\s+\w/iu, /\bDELETE\s+FROM\b/iu]) {
    assert.ok(!forbidden.test(source), `a camada de leitura ganhou escrita: ${forbidden}`);
  }
});

test("cada fonte declara a capacidade que a libera", () => {
  for (const source of workItemSources) {
    assert.ok(source.capability.length > 0, `${source.key} sem capability`);
    assert.match(source.sql, /workspace_id = \?/u, `${source.key} sem recorte de workspace`);
  }
});

test("toda fonte devolve as mesmas colunas, na mesma ordem — é o que permite a união", () => {
  // Uma coluna a mais em uma fonte só quebraria o `UNION ALL` inteiro, e o erro
  // apareceria em produção como "a Central não abre", sem dizer qual fonte.
  for (const source of workItemSources) {
    const selected = [...source.sql.matchAll(/AS ([a-z_]+)/gu)].map((match) => match[1]);
    for (const column of WORK_ITEM_COLUMNS) {
      const present = selected.includes(column) || new RegExp(`\\b\\w+\\.${column}\\b`, "u").test(source.sql);
      assert.ok(present, `${source.key} não devolve a coluna ${column}`);
    }
  }
});

/* -------------------------------------------------------------------------- *
 * Escopo
 * -------------------------------------------------------------------------- */

test("o escopo de empresa entra no SQL, com um parâmetro por empresa", () => {
  const card = workItemSources.find((source) => source.key === "card")!;
  const { sql, parameters } = buildWorkItemQuery({
    source: card, workspaceId: "w1", userId: "u1", scope: "team", companyIds: ["c1", "c2"],
  });
  assert.match(sql, /AND c\.company_id IN \(\?, \?\)/u);
  assert.deepEqual(parameters, ["w1", "c1", "c2"]);
});

test("sem nenhuma empresa liberada a fonte não devolve linha", () => {
  const card = workItemSources.find((source) => source.key === "card")!;
  const { sql, parameters } = buildWorkItemQuery({
    source: card, workspaceId: "w1", userId: "u1", scope: "team", companyIds: [],
  });
  assert.match(sql, /AND false/u, "recusar no banco é mais barato e mais seguro que filtrar depois");
  assert.deepEqual(parameters, ["w1"]);
});

test("o recorte pessoal só entra no escopo `mine`", () => {
  const card = workItemSources.find((source) => source.key === "card")!;
  const mine = buildWorkItemQuery({
    source: card, workspaceId: "w1", userId: "u1", scope: "mine", companyIds: null,
  });
  assert.match(mine.sql, /fdp_card_assignees/u);
  assert.deepEqual(mine.parameters, ["w1", "u1"]);

  const team = buildWorkItemQuery({
    source: card, workspaceId: "w1", userId: "u1", scope: "team", companyIds: null,
  });
  assert.ok(!team.sql.includes("{{mine}}"));
  assert.deepEqual(team.parameters, ["w1"]);
});

test("nenhum marcador sobra na consulta final", () => {
  for (const source of workItemSources) {
    for (const scope of ["mine", "team"] as const) {
      const { sql } = buildWorkItemQuery({
        source, workspaceId: "w1", userId: "u1", scope, companyIds: ["c1"],
      });
      assert.ok(!sql.includes("{{"), `${source.key}/${scope} deixou marcador na consulta`);
    }
  }
  assert.ok(!centerQuery().sql.includes("{{"), "a união deixou marcador");
});

test("a triagem não é recortada por empresa — é justamente o que falta identificar", () => {
  const triage = workItemSources.find((source) => source.key === "triage")!;
  assert.equal(triage.companyColumn, "");
  const { sql, parameters } = buildWorkItemQuery({
    source: triage, workspaceId: "w1", userId: "u1", scope: "mine", companyIds: [],
  });
  assert.ok(!sql.includes("AND false"));
  assert.deepEqual(parameters, ["w1"]);
});

/* -------------------------------------------------------------------------- *
 * Uma consulta, e não uma por fonte
 * -------------------------------------------------------------------------- */

test("as fontes permitidas viram uma união só (§12)", () => {
  const { sql } = centerQuery();
  assert.equal(sql.split("UNION ALL").length - 1, workItemSources.length - 1,
    "cada fonte precisa entrar na mesma consulta — uma consulta por fonte é o N+1 disfarçado");
});

test("a fonte pedida pelo filtro recorta a união antes de consultar", () => {
  const { sql } = centerQuery({ filters: { sources: ["card"] } });
  assert.ok(!sql.includes("UNION ALL"), "filtrar por tipo precisa reduzir o que o banco lê, não o que a tela mostra");
  assert.match(sql, /fdp_cards/u);
});

test("sem nenhuma fonte permitida não se pergunta nada ao banco", () => {
  assert.equal(buildWorkCenterQuery({
    ...base, sources: [], filters: filters(), sort: "urgency", cursor: [], limit: 10,
  }), null);
  assert.equal(buildWorkCountsQuery({ ...base, sources: [], scope: "team" }), null);
});

test("o limite é preso à faixa e nunca vem do cliente sem tratamento", () => {
  assert.match(centerQuery({ limit: 99_999 }).sql, new RegExp(`LIMIT ${WORK_ITEM_MAX_PAGE + 1}$`, "u"));
  assert.match(centerQuery({ limit: -5 }).sql, /LIMIT 2$/u);
  assert.match(centerQuery({ limit: Number.NaN }).sql, /LIMIT 26$/u);
});

/* -------------------------------------------------------------------------- *
 * Filtros
 * -------------------------------------------------------------------------- */

test("cada filtro vira condição com parâmetro, nunca texto interpolado (§6)", () => {
  const query = centerQuery({ filters: {
    companyId: "c1", processId: "p1", priority: "urgent", status: "open", origin: "teams",
  } });
  for (const clause of ["company_id = ?", "process_id = ?", "priority = ?", "status = ?", "origin = ?"]) {
    assert.ok(query.sql.includes(clause), `filtro ausente: ${clause}`);
  }
  for (const value of ["c1", "p1", "urgent", "open", "teams"]) {
    assert.ok(query.parameters.includes(value), `valor não parametrizado: ${value}`);
  }
  // A garantia real: cada `?` da consulta tem exatamente um valor ligado a ele.
  // Um valor a mais ou a menos é o sintoma de literal colado no SQL.
  assert.equal((query.sql.match(/\?/gu) ?? []).length, query.parameters.length,
    "sobrou ou faltou parâmetro — é por aí que um filtro vira injeção");
});

test("as janelas de prazo são calculadas no banco, com a data do banco", () => {
  // Comparar com a data do navegador colocaria quem está em outro fuso vendo
  // "vencidos" que não venceram.
  assert.match(centerQuery({ filters: { due: "overdue" } }).sql, /due_at::date < CURRENT_DATE/u);
  assert.match(centerQuery({ filters: { due: "today" } }).sql, /due_at::date = CURRENT_DATE/u);
  assert.match(centerQuery({ filters: { due: "week" } }).sql, /BETWEEN CURRENT_DATE AND CURRENT_DATE \+ 7/u);
  assert.ok(!centerQuery().sql.includes("CURRENT_DATE + 7"));
});

/* -------------------------------------------------------------------------- *
 * Ordenação e cursor
 * -------------------------------------------------------------------------- */

test("toda ordenação termina em um desempate estável", () => {
  // Sem critério final único, dois itens iguais trocam de lugar entre consultas
  // e a paginação pula um e repete o outro — sem erro nenhum aparecer.
  for (const sort of ["urgency", "due", "priority", "created", "updated"] as const) {
    const { sql } = centerQuery({ sort });
    const order = sql.slice(sql.lastIndexOf("ORDER BY"));
    assert.match(order, /source_id/u, `a ordenação ${sort} não desempata`);
  }
});

test("a ordenação padrão é a do que precisa de ação primeiro (§7)", () => {
  const { sql } = centerQuery();
  const order = sql.slice(sql.lastIndexOf("ORDER BY"));
  assert.match(order, /CASE\s+WHEN status IN \('overdue', 'blocked', 'dead_letter'\)/u);
});

test("o cursor sobrevive à ida e à volta", () => {
  const values = ["0", "2026-01-05T12:00:00.000Z", "2026-01-01T00:00:00.000Z", "card-1"];
  assert.deepEqual(decodeWorkCursor(encodeWorkCursor(values)), values);
  assert.deepEqual(decodeWorkCursor(""), []);
  assert.deepEqual(decodeWorkCursor("não é base64 !!!"), []);
});

test("o cursor compara a tupla inteira da ordenação", () => {
  const query = centerQuery({ cursor: ["0", "2026-01-05T12:00:00.000Z", "2026-01-01T00:00:00.000Z", "card-1"] });
  assert.match(query.sql, /created_at, source_id\)\s*>\s*\(\?::integer, \?::timestamptz, \?::timestamptz, \?\)/u);
  assert.ok(query.parameters.includes("card-1"));
});

test("cursor truncado é ignorado em vez de devolver página errada", () => {
  const query = centerQuery({ cursor: ["0"] });
  assert.ok(!query.sql.includes(") > ("), "um cursor pela metade não pode virar condição");
});

test("o cursor da linha respeita a ordenação pedida", () => {
  const row = {
    urgency: 1, due_sort: "2026-02-01T00:00:00.000Z", priority_rank: 2,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-09T00:00:00.000Z", source_id: "x",
  };
  assert.deepEqual(decodeWorkCursor(cursorForRow("urgency", row))[0], "1");
  assert.deepEqual(decodeWorkCursor(cursorForRow("due", row))[0], "2026-02-01T00:00:00.000Z");
  assert.deepEqual(decodeWorkCursor(cursorForRow("priority", row))[0], "2");
  assert.deepEqual(decodeWorkCursor(cursorForRow("created", row)), ["2026-01-01T00:00:00.000Z", "x"]);
  assert.deepEqual(decodeWorkCursor(cursorForRow("updated", row)), ["2026-01-09T00:00:00.000Z", "x"]);
});

test("prazo ausente não some da ordenação — vai para o fim", () => {
  // `NULL` em comparação de tupla devolve `NULL`, e a página seguinte viria
  // vazia sem erro nenhum: o modo de falhar mais difícil de perceber.
  assert.match(centerQuery({ sort: "due" }).sql, /COALESCE\(due_at, 'infinity'::timestamptz\)/u);
});

/* -------------------------------------------------------------------------- *
 * Contadores e agrupamento
 * -------------------------------------------------------------------------- */

test("os contadores cobrem o conjunto, e não a página (§11)", () => {
  const query = buildWorkCountsQuery({ ...base, scope: "mine" })!;
  for (const counter of ["overdue", "today", "blocked", "awaiting_approval", "triage", "failures"]) {
    assert.ok(query.sql.includes(counter), `contador ausente: ${counter}`);
  }
  assert.ok(!query.sql.includes("LIMIT"), "contador que pagina não conta nada");
});

test("o agrupamento é contado no banco, senão ele mente fora da página (§8)", () => {
  for (const group of ["source", "process", "company", "status", "origin", "due"] as const) {
    const query = buildWorkGroupQuery({ ...base, scope: "team", group })!;
    assert.match(query.sql, /GROUP BY 1/u, `${group} não agrupa no banco`);
    assert.match(query.sql, /LIMIT 30/u, `${group} sem teto — a tela viraria BI (§8)`);
  }
});

test("a chave de grupo do item é a mesma que o banco conta", () => {
  const item = toWorkItem({
    source_type: "card", source_id: "c1", title: "t", status: "safe",
    created_at: "2026-01-01T00:00:00Z", due_at: "2026-01-01T00:00:00Z",
    company_name: "Empresa", origin: "teams",
  }, "2026-01-05");
  assert.equal(workItemGroupKey(item, "company", "2026-01-05"), "Empresa");
  assert.equal(workItemGroupKey(item, "due", "2026-01-05"), "Vencidos");
  assert.equal(workItemGroupKey(item, "origin", "2026-01-05"), "Microsoft Teams");
  assert.equal(workItemGroupKey(item, "source", "2026-01-05"), "Demandas");
  assert.equal(workItemGroupKey(item, "", "2026-01-05"), "");
});

/* -------------------------------------------------------------------------- *
 * Contrato
 * -------------------------------------------------------------------------- */

test("o item traz um destino real no painel, e não um link para lugar nenhum", () => {
  assert.equal(workItemHref("card", "abc"), "/painel/demandas/abc");
  for (const source of ["card", "approval", "movement", "auxiliary", "pending_item", "triage", "integration_failure"] as const) {
    const href = workItemHref(source, "x");
    const [path] = href.split("?");
    const location = parsePanelPath(path);
    assert.ok(href.startsWith("/painel"), `${source} aponta fora do painel`);
    assert.notEqual(location.view, "overview",
      `${source} leva a um endereço que o painel não reconhece: ${path}`);
    assert.ok(panelPath({ view: location.view }).length > 0);
  }
});

test("a linha crua vira o contrato comum, com o que fazer em seguida (§5)", () => {
  const item = toWorkItem({
    source_type: "card", source_id: "card-1", title: "Admissão — Maria",
    description: "", priority: "normal", company_id: "c1", company_name: "Empresa",
    employee_id: null, due_at: null, created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-02T10:00:00Z", status: "overdue", process_id: "def-1",
    process_step: "Task_1", process_version: "4.0", origin: "integracao:tangerino",
  }, "2026-08-10");
  assert.equal(item.id, "card:card-1");
  assert.equal(item.statusLabel, "Vencida");
  assert.equal(item.priorityLabel, "Normal");
  assert.equal(item.originLabel, "Tangerino");
  assert.equal(item.tone, "critical");
  assert.equal(item.href, "/painel/demandas/card-1");
  assert.equal(item.processStep, "Task_1");
  assert.equal(item.nextAction, "Abrir a demanda e avançar a etapa");
  assert.equal(item.updatedAt, "2026-08-02T10:00:00Z");
});

test("o item diz o que o trava, quando algo o trava (§5, §44)", () => {
  const blocked = toWorkItem({
    source_type: "movement", source_id: "m1", title: "Alteração salarial",
    status: "pending_approval", created_at: "2026-01-01T00:00:00Z",
  }, "2026-01-05");
  assert.equal(blocked.blockedReason, "Aguardando decisão de quem aprova.");
  const failure = toWorkItem({
    source_type: "integration_failure", source_id: "j1", title: "Execução",
    status: "dead_letter", created_at: "2026-01-01T00:00:00Z",
  }, "2026-01-05");
  assert.equal(failure.tone, "critical");
  assert.match(failure.blockedReason ?? "", /esgotou as tentativas/u);
  const calm = toWorkItem({
    source_type: "card", source_id: "c2", title: "t", status: "safe", created_at: "2026-01-01T00:00:00Z",
  }, "2026-01-05");
  assert.equal(calm.blockedReason, undefined, "item sem bloqueio não pode inventar um");
});

test("o que trava primeiro aparece primeiro, e o sem prazo não esconde o vencido", () => {
  const rows = [
    { source_type: "card", source_id: "sem-prazo", title: "c", status: "safe", created_at: "2026-01-01" },
    { source_type: "card", source_id: "vencida", title: "a", status: "overdue", created_at: "2026-05-01", due_at: "2026-05-01" },
    { source_type: "card", source_id: "hoje", title: "b", status: "warning", created_at: "2026-06-01", due_at: "2026-06-01" },
  ].map((row) => toWorkItem(row, "2026-08-01"));
  const ordered = sortWorkItems(rows).map((item) => item.sourceId);
  assert.deepEqual(ordered, ["vencida", "hoje", "sem-prazo"]);
});

test("a urgência do SQL e a do TypeScript classificam a mesma coisa", async () => {
  // As duas existem por necessidade: uma pagina, a outra ordena lista já
  // carregada. Divergir faria a segunda página começar antes do fim da primeira.
  const source = await readFile(new URL("../lib/work-items.ts", import.meta.url), "utf8");
  const sql = source.slice(source.indexOf("const URGENCY_SQL"), source.indexOf("const DUE_SORT_SQL"));
  for (const status of ["overdue", "blocked", "dead_letter"]) {
    assert.ok(sql.includes(`'${status}'`), `${status} é crítico no TypeScript e não no SQL`);
    assert.equal(toWorkItem({
      source_type: "card", source_id: "x", title: "t", status, created_at: "2026-01-01",
    }, "2026-01-05").tone, "critical");
  }
});
