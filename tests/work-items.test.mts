import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { panelPath, parsePanelPath } from "../lib/panel-routes.ts";
import {
  buildWorkItemQuery, sortWorkItems, toWorkItem, workItemHref, workItemSources,
} from "../lib/work-items.ts";

/* A Central de Trabalho é camada de **leitura**. Os testes abaixo protegem as
   três propriedades que a impedem de virar o quinto objeto de trabalho: ela não
   escreve, ela cobre as fontes que já existem, e o escopo de empresa é aplicado
   no SQL — não em memória depois de carregar tudo. */

test("a central cobre os objetos de trabalho que a auditoria encontrou", () => {
  const keys = workItemSources.map((source) => source.key);
  for (const expected of ["card", "movement", "approval", "auxiliary", "pending_item", "triage"]) {
    assert.ok(keys.includes(expected as typeof keys[number]), `fonte ausente: ${expected}`);
  }
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

test("o escopo de empresa entra no SQL, com um parâmetro por empresa", () => {
  const card = workItemSources.find((source) => source.key === "card")!;
  const { sql, parameters } = buildWorkItemQuery({
    source: card, workspaceId: "w1", userId: "u1", scope: "team",
    companyIds: ["c1", "c2"], limit: 10,
  });
  assert.match(sql, /AND c\.company_id IN \(\?, \?\)/u);
  assert.deepEqual(parameters, ["w1", "c1", "c2"]);
});

test("sem nenhuma empresa liberada a fonte não devolve linha", () => {
  const card = workItemSources.find((source) => source.key === "card")!;
  const { sql, parameters } = buildWorkItemQuery({
    source: card, workspaceId: "w1", userId: "u1", scope: "team", companyIds: [], limit: 10,
  });
  assert.match(sql, /AND false/u, "recusar no banco é mais barato e mais seguro que filtrar depois");
  assert.deepEqual(parameters, ["w1"]);
});

test("o recorte pessoal só entra no escopo `mine`", () => {
  const card = workItemSources.find((source) => source.key === "card")!;
  const mine = buildWorkItemQuery({
    source: card, workspaceId: "w1", userId: "u1", scope: "mine", companyIds: null, limit: 10,
  });
  assert.match(mine.sql, /fdp_card_assignees/u);
  assert.deepEqual(mine.parameters, ["w1", "u1"]);

  const team = buildWorkItemQuery({
    source: card, workspaceId: "w1", userId: "u1", scope: "team", companyIds: null, limit: 10,
  });
  assert.ok(!team.sql.includes("{{mine}}"));
  assert.deepEqual(team.parameters, ["w1"]);
});

test("nenhum marcador sobra na consulta final", () => {
  for (const source of workItemSources) {
    for (const scope of ["mine", "team"] as const) {
      const { sql } = buildWorkItemQuery({
        source, workspaceId: "w1", userId: "u1", scope, companyIds: ["c1"], limit: 10,
      });
      assert.ok(!sql.includes("{{"), `${source.key}/${scope} deixou marcador na consulta`);
    }
  }
});

test("o limite é preso à faixa e nunca vem do cliente sem tratamento", () => {
  const card = workItemSources.find((source) => source.key === "card")!;
  const base = { source: card, workspaceId: "w1", userId: "u1", scope: "team" as const, companyIds: null };
  assert.match(buildWorkItemQuery({ ...base, limit: 99999 }).sql, /LIMIT 200$/u);
  assert.match(buildWorkItemQuery({ ...base, limit: -5 }).sql, /LIMIT 1$/u);
  assert.match(buildWorkItemQuery({ ...base, limit: Number.NaN }).sql, /LIMIT 50$/u);
});

test("o item traz um destino real no painel, e não um link para lugar nenhum", () => {
  assert.equal(workItemHref("card", "abc"), "/painel/demandas/abc");
  assert.equal(workItemHref("triage", "a b"), "/painel/integracoes?triagem=a%20b");
  // Todo destino precisa resolver para uma visão que o painel sabe abrir.
  for (const source of ["card", "approval", "movement", "auxiliary", "pending_item", "triage"] as const) {
    const href = workItemHref(source, "x");
    const [path] = href.split("?");
    const location = parsePanelPath(path);
    assert.ok(href.startsWith("/painel"), `${source} aponta fora do painel`);
    assert.equal(panelPath({ view: location.view }).replace(/\?.*$/u, ""),
      location.view === "board" ? "/painel/demandas" : path,
      `${source} leva a um endereço que o painel não reconhece: ${path}`);
  }
});

test("a linha crua vira o contrato comum", () => {
  const item = toWorkItem({
    source_type: "card", source_id: "card-1", title: "Admissão — Maria",
    description: "", priority: "normal", company_id: "c1", company_name: "Empresa",
    employee_id: null, due_at: null, created_at: "2026-08-01T10:00:00Z",
    status: "overdue", process_id: "def-1", process_step: "Task_1", process_version: "4.0",
  });
  assert.equal(item.id, "card:card-1");
  assert.equal(item.sourceType, "card");
  assert.equal(item.statusLabel, "Vencida");
  assert.equal(item.tone, "critical");
  assert.equal(item.href, "/painel/demandas/card-1");
  assert.equal(item.processStep, "Task_1");
});

test("o que trava primeiro aparece primeiro, e o sem prazo não esconde o vencido", () => {
  const rows = [
    { source_type: "card", source_id: "sem-prazo", title: "c", status: "safe", created_at: "2026-01-01" },
    { source_type: "card", source_id: "vencida", title: "a", status: "overdue", created_at: "2026-05-01", due_at: "2026-05-01" },
    { source_type: "card", source_id: "hoje", title: "b", status: "warning", created_at: "2026-06-01", due_at: "2026-06-01" },
  ].map(toWorkItem);
  const ordered = sortWorkItems(rows).map((item) => item.sourceId);
  assert.deepEqual(ordered, ["vencida", "hoje", "sem-prazo"]);
});

test("a triagem não é recortada por empresa — é justamente o que falta identificar", () => {
  const triage = workItemSources.find((source) => source.key === "triage")!;
  assert.equal(triage.companyColumn, "");
  const { sql, parameters } = buildWorkItemQuery({
    source: triage, workspaceId: "w1", userId: "u1", scope: "mine", companyIds: [], limit: 10,
  });
  assert.ok(!sql.includes("AND false"));
  assert.deepEqual(parameters, ["w1"]);
});
