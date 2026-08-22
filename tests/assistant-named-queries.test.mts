import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FORBIDDEN_RESULT_COLUMNS, buildNamedQuery, findNamedQuery, formatNamedQueryContext,
  matchNamedQueries, namedQueries, toNamedQueryResult,
} from "../lib/assistant/named-queries.ts";
import { buildSystemPrompt } from "../lib/assistant/provider.ts";

/* A postura segura da IA não muda: sem SQL, sem tabela, sem dado pessoal. O que
   muda é a utilidade. Estes testes protegem exatamente essa fronteira. */

test("o catálogo responde as perguntas operacionais que o produto promete", () => {
  const keys = namedQueries.map((query) => query.key);
  for (const expected of [
    "work.overdue", "admissions.stalled", "pj.missing_invoice", "integrations.failed",
    "closing.blockers", "epi.pending_returns", "approvals.mine", "processes.late",
  ]) {
    assert.ok(keys.includes(expected), `consulta ausente: ${expected}`);
  }
});

test("cada consulta declara capacidade, recorte de workspace e pergunta em português", () => {
  for (const query of namedQueries) {
    assert.ok(query.capability.length > 0, `${query.key} sem capability`);
    assert.match(query.sql, /workspace_id = \?/u, `${query.key} sem recorte de workspace`);
    assert.match(query.question, /\?$/u, `${query.key} sem pergunta`);
    assert.ok(query.triggers.length > 0, `${query.key} sem termos de casamento`);
  }
});

test("nenhuma consulta seleciona coluna de identificação pessoal", () => {
  for (const query of namedQueries) {
    const select = query.sql.slice(0, query.sql.toUpperCase().indexOf("FROM"));
    for (const forbidden of FORBIDDEN_RESULT_COLUMNS) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`, "iu").test(select),
        `${query.key} traria a coluna proibida ${forbidden}`);
    }
  }
});

test("toda consulta é agregada: nenhuma devolve linha por pessoa", () => {
  for (const query of namedQueries) {
    assert.match(query.sql, /\b(count|sum|min|max|avg)\s*\(/iu,
      `${query.key} precisa agregar — linha individual é dado pessoal por outro nome`);
  }
});

test("a consulta pessoal recebe o usuário; as demais, não", () => {
  const mine = findNamedQuery("approvals.mine")!;
  assert.equal(mine.personal, true);
  const built = buildNamedQuery({ query: mine, workspaceId: "w1", userId: "u1", companyIds: null });
  assert.deepEqual(built.parameters, ["w1", "u1"]);

  const overdue = findNamedQuery("work.overdue")!;
  assert.equal(overdue.personal, false);
  assert.deepEqual(buildNamedQuery({ query: overdue, workspaceId: "w1", userId: "u1", companyIds: null }).parameters, ["w1"]);
});

test("o escopo de empresa entra como parâmetro, nunca interpolado", () => {
  const overdue = findNamedQuery("work.overdue")!;
  const built = buildNamedQuery({ query: overdue, workspaceId: "w1", userId: "u1", companyIds: ["c1", "c2"] });
  assert.match(built.sql, /IN \(\?, \?\)/u);
  assert.deepEqual(built.parameters, ["w1", "c1", "c2"]);
  assert.ok(!built.sql.includes("c1"), "identificador de empresa não pode entrar no texto da consulta");
});

test("sem nenhuma empresa liberada a consulta não devolve linha", () => {
  const overdue = findNamedQuery("work.overdue")!;
  const built = buildNamedQuery({ query: overdue, workspaceId: "w1", userId: "u1", companyIds: [] });
  assert.match(built.sql, /AND false/u);
});

test("nenhum marcador sobra na consulta final", () => {
  for (const query of namedQueries) {
    for (const companyIds of [null, [], ["c1"]]) {
      const built = buildNamedQuery({ query, workspaceId: "w1", userId: "u1", companyIds });
      assert.ok(!built.sql.includes("{{"), `${query.key} deixou marcador`);
    }
  }
});

test("as perguntas que o produto promete responder realmente casam", () => {
  // São as perguntas do §62, na forma em que uma pessoa as escreve.
  const esperado: Array<[string, string]> = [
    ["Quais admissões estão paradas?", "admissions.stalled"],
    ["Quais demandas estão vencidas?", "work.overdue"],
    ["O que está bloqueando o fechamento?", "closing.blockers"],
    ["Quais PJs ainda precisam enviar nota?", "pj.missing_invoice"],
    ["Quais integrações falharam?", "integrations.failed"],
    ["Quais aprovações estão comigo?", "approvals.mine"],
    ["O que mudou hoje?", "work.changed_today"],
    ["Quais processos estão atrasados?", "processes.late"],
    ["Quais EPIs estão pendentes de devolução?", "epi.pending_returns"],
    ["O que está em triagem?", "triage.pending"],
  ];
  for (const [pergunta, chave] of esperado) {
    const keys = matchNamedQueries(pergunta).map((query) => query.key);
    assert.ok(keys.includes(chave), `"${pergunta}" não casou com ${chave} (casou com ${keys.join(", ") || "nada"})`);
  }
});

test("o casamento sobrevive a plural, conjugação, acento e caixa", () => {
  // "integração falhou" e "integrações falharam" são a mesma pergunta; responder
  // só a uma delas faz o usuário concluir que o assistente não sabe.
  for (const pergunta of ["QUAIS INTEGRACOES FALHARAM", "a integração falhou?", "erro de integração"]) {
    assert.deepEqual(matchNamedQueries(pergunta).map((query) => query.key), ["integrations.failed"], pergunta);
  }
});

test("sem termo reconhecido, nenhuma consulta roda", () => {
  // O assistente responde sem dado em vez de varrer o banco por precaução.
  for (const pergunta of ["bom dia, tudo bem?", "oi", "obrigado!", ""]) {
    assert.deepEqual(matchNamedQueries(pergunta), [], pergunta);
  }
});

test("um gatilho só casa quando todos os seus termos aparecem", () => {
  // "nota" sozinho não é pergunta sobre prestador.
  assert.ok(!matchNamedQueries("onde vejo a nota de rodapé?").some((query) => query.key === "pj.missing_invoice"));
});

test("o resultado entregue ao modelo só carrega número e data", () => {
  const query = findNamedQuery("work.overdue")!;
  const result = toNamedQueryResult(query, {
    total: 12,
    mais_antiga: "2026-05-01T10:00:00.000Z",
    empresas: "3",
    // Uma coluna de texto que escapasse para a consulta aparece como omitida,
    // e não vai para o provedor.
    responsavel: "Maria Silva",
    vazio: null,
  });
  assert.deepEqual(result.values, { total: 12, mais_antiga: "2026-05-01", empresas: 3, vazio: null });
  assert.deepEqual(result.omitted, ["responsavel"]);
});

test("o contexto entregue ao modelo diz para não estimar", () => {
  const query = findNamedQuery("work.overdue")!;
  const context = formatNamedQueryContext([toNamedQueryResult(query, { total: 4 })]);
  assert.match(context, /total=4/u);
  assert.match(context, /não estime/iu);
});

test("sem consulta casada, o contexto é vazio e o prompt não muda", () => {
  assert.equal(formatNamedQueryContext([]), "");
  const prompt = buildSystemPrompt({
    workspaceName: "Synex", userName: "Ana", role: "member", screen: "Painel",
    allowedModules: [], blockedModules: [], operationalFacts: "",
  });
  assert.ok(!prompt.includes("já vieram apurados"));
});

test("com fatos, o prompt os inclui e reforça que não se inventa número", () => {
  const prompt = buildSystemPrompt({
    workspaceName: "Synex", userName: "Ana", role: "member", screen: "Painel",
    allowedModules: [], blockedModules: [],
    operationalFacts: "- Quais demandas estão vencidas? → total=4",
  });
  assert.match(prompt, /total=4/u);
  assert.match(prompt, /já vieram apurados/u);
  // A regra original continua valendo: sem dado pessoal.
  assert.match(prompt, /NÃO tem acesso a dados de colaboradores/u);
});

test("a rota nomeada não aceita SQL do cliente", async () => {
  const source = await readFile(new URL("../app/api/assistant/query/route.ts", import.meta.url), "utf8");
  assert.ok(!/body\.sql|body\.query\b\s*as\s*string/u.test(source),
    "a rota passou a aceitar consulta escrita por quem chama");
  assert.match(source, /findNamedQuery/u, "a rota resolve a consulta pelo catálogo");
  assert.match(source, /hasCapability/u, "a rota valida a capacidade antes de executar");
});

test("o assistente continua sem receber SQL nem nome de tabela", async () => {
  const provider = await readFile(new URL("../lib/assistant/provider.ts", import.meta.url), "utf8");
  assert.ok(!/\bSELECT\b|\bfdp_/u.test(provider),
    "o provedor do modelo não pode conhecer consulta nem tabela");
});
