import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AUTOMATIC_THRESHOLD, SUGGESTION_THRESHOLD } from "../lib/agent-proposals.ts";
import {
  confidenceBand, originLabel, proposalLabel, redactPersonalData, summarizePayload,
  triageResolveHref, uncertaintyExplanation,
} from "../lib/triage.ts";

/* A triagem é onde o produto admite não ter certeza. O jeito de errar aqui é
   silencioso: a tela mostra o suficiente para a pessoa confirmar por eliminação
   e o vínculo errado entra na folha. Estes testes protegem a apresentação — que
   é a única coisa entre a dúvida do sistema e a decisão de alguém. */

/* -------------------------------------------------------------------------- *
 * Confiança
 * -------------------------------------------------------------------------- */

test("confiança vira palavra, com o número junto (§19)", () => {
  const band = confidenceBand(0.84);
  assert.equal(band.label, "Média");
  assert.equal(band.percent, 84);
  assert.ok(band.detail.length > 20, "faixa sem explicação é o mesmo que só mostrar 0,84");
});

test("as faixas são exatamente os limiares do motor, não uma segunda régua", () => {
  // Duas réguas divergem, e a tela passaria a dizer "alta" sobre uma nota que o
  // motor mandou para triagem.
  assert.equal(confidenceBand(AUTOMATIC_THRESHOLD).level, "alta");
  assert.equal(confidenceBand(AUTOMATIC_THRESHOLD - 0.01).level, "media");
  assert.equal(confidenceBand(SUGGESTION_THRESHOLD).level, "media");
  assert.equal(confidenceBand(SUGGESTION_THRESHOLD - 0.01).level, "baixa");
});

test("confiança inválida não vira NaN na tela", () => {
  assert.equal(confidenceBand(Number.NaN).percent, 0);
  assert.equal(confidenceBand(-1).level, "baixa");
  assert.equal(confidenceBand(9).level, "alta");
});

/* -------------------------------------------------------------------------- *
 * Motivo da incerteza
 * -------------------------------------------------------------------------- */

test("todo código do motor determinístico tem tradução com saída (§14, §56)", async () => {
  const engine = await readFile(new URL("../lib/agent-proposals.ts", import.meta.url), "utf8");
  const codes = [...engine.matchAll(/decision\("(?:execute|suggest|triage|reject)",\s*"([A-Z_]+)"/gu)]
    .map((match) => match[1])
    .filter((code) => code !== "AGENT_AUTOMATIC");
  assert.ok(codes.length >= 8, "o motor deixou de ter códigos — a leitura acima quebrou");
  for (const code of codes) {
    const explanation = uncertaintyExplanation(code);
    assert.notEqual(explanation.title, "A entrada precisa de conferência humana.",
      `${code} chegou à tela sem explicar o que ficou em dúvida`);
    assert.ok(explanation.action.length > 20, `${code} não diz o que resolve`);
  }
});

test("código desconhecido cai na razão gravada, e nunca no enum cru", () => {
  const explanation = uncertaintyExplanation("CODIGO_NOVO", "O conector mudou de formato.");
  assert.equal(explanation.title, "O conector mudou de formato.");
  assert.ok(explanation.action.length > 20);
});

/* -------------------------------------------------------------------------- *
 * Dado pessoal
 * -------------------------------------------------------------------------- */

test("documento é redigido, mas ainda dá para conferir de quem é (§15)", () => {
  const redacted = redactPersonalData("CPF 123.456.789-09 de Maria");
  assert.ok(!redacted.includes("123.456"), "o CPF inteiro chegou à tela");
  assert.ok(redacted.includes("789-09"), "esconder tudo torna a conferência impossível");
});

test("CPF sem pontuação também é redigido", () => {
  assert.ok(!redactPersonalData("documento 12345678909").includes("12345678"));
});

test("e-mail e telefone perdem o miolo, não a identidade", () => {
  const email = redactPersonalData("maria.silva@empresa.com.br");
  assert.ok(email.startsWith("m•••@"), `e-mail exposto: ${email}`);
  assert.ok(email.includes("empresa.com.br"), "sem o domínio ninguém reconhece a origem");
  const phone = redactPersonalData("(11) 98765-4321");
  assert.ok(!phone.includes("98765"), `telefone exposto: ${phone}`);
  assert.ok(phone.includes("4321"));
});

test("CNPJ é redigido", () => {
  const redacted = redactPersonalData("12.345.678/0001-99");
  assert.ok(!redacted.includes("345.678"));
  assert.ok(redacted.includes("0001-99"));
});

test("texto sem dado pessoal atravessa intacto", () => {
  const original = "Admissão concluída na origem em 2026-01-05, etapa Conferência.";
  assert.equal(redactPersonalData(original), original);
});

/* -------------------------------------------------------------------------- *
 * Payload legível
 * -------------------------------------------------------------------------- */

test("o payload vira frases rotuladas, não JSON despejado (§15)", () => {
  const fields = summarizePayload({
    employeeName: "Maria Silva", admissionDate: "2026-01-05",
    documentsMissing: ["CTPS", "comprovante"], externalId: "SD-9081",
  });
  assert.deepEqual(fields.map((field) => field.label),
    ["Colaborador", "Data de admissão", "Documentos faltantes", "Identificador na origem"]);
  assert.equal(fields[2].value, "CTPS, comprovante");
});

test("campo desconhecido aparece humanizado, e não some", () => {
  // Esconder o desconhecido faria a triagem mentir por omissão justamente
  // quando o conector muda de formato — que é quando alguém precisa ver.
  const [field] = summarizePayload({ centro_de_custo: "Matriz" });
  assert.equal(field.label, "Centro de custo");
  assert.equal(field.value, "Matriz");
});

test("objeto aninhado e valor vazio não viram linha muda", () => {
  const fields = summarizePayload({ nested: { a: 1 }, vazio: "", nulo: null, ok: "sim" });
  assert.deepEqual(fields.map((field) => field.value), ["sim"]);
});

test("o payload é redigido por padrão", () => {
  const [field] = summarizePayload({ cpf: "123.456.789-09" });
  assert.ok(!field.value.includes("123.456"), "o padrão precisa ser redigir");
  const [raw] = summarizePayload({ cpf: "123.456.789-09" }, { redact: false });
  assert.ok(raw.value.includes("123.456"), "o detalhe administrativo precisa poder mostrar o valor");
});

test("payload gigante não vira parede de texto", () => {
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`campo${index}`, `valor ${index}`]));
  assert.ok(summarizePayload(wide).length <= 12);
  const [long] = summarizePayload({ observacao: "x".repeat(1000) });
  assert.ok(long.value.length <= 160);
});

test("payload que não é objeto devolve lista vazia em vez de quebrar", () => {
  assert.deepEqual(summarizePayload(null), []);
  assert.deepEqual(summarizePayload("texto"), []);
  assert.deepEqual(summarizePayload([1, 2]), []);
});

/* -------------------------------------------------------------------------- *
 * Vocabulário e destino
 * -------------------------------------------------------------------------- */

test("origem e ação aparecem em português", () => {
  assert.equal(originLabel("sankhya_browser"), "Sankhya (navegador)");
  assert.equal(originLabel("teams"), "Microsoft Teams");
  assert.equal(proposalLabel("process.advance"), "Avançar a etapa da demanda");
  // O que não está no catálogo aparece como veio: inventar tradução seria pior.
  assert.equal(proposalLabel("algo.novo"), "algo.novo");
  assert.equal(originLabel("erp"), "erp");
});

test("cada item de triagem tem endereço próprio, e as duas origens não colidem", () => {
  const agent = triageResolveHref({ source: "agent_proposal", sourceId: "p-1" });
  const movement = triageResolveHref({ source: "movement_suggestion", sourceId: "p-1" });
  assert.notEqual(agent, movement, "o mesmo identificador em duas filas abriria a mesma tela");
  assert.ok(agent.startsWith("/painel/triagem/"));
  assert.ok(movement.startsWith("/painel/triagem/"));
});

/* -------------------------------------------------------------------------- *
 * Fronteira
 * -------------------------------------------------------------------------- */

test("a triagem não escreve: a resolução é da rota de domínio (§17)", async () => {
  const source = await readFile(new URL("../lib/triage.ts", import.meta.url), "utf8");
  for (const forbidden of [/UPDATE /u, /INSERT /u, /DELETE /u, /getD1/u, /prepare\(/u]) {
    assert.ok(!forbidden.test(source),
      `a camada de leitura da triagem passou a escrever: ${forbidden}`);
  }
});

test("a rota de triagem também é só leitura", async () => {
  const source = await readFile(new URL("../app/api/triage/route.ts", import.meta.url), "utf8");
  assert.ok(!/\bexport async function (POST|PATCH|PUT|DELETE)\b/u.test(source),
    "a central de triagem ganhou porta de escrita própria, contornando o módulo dono");
  assert.match(source, /getCompanyAccessScope/u, "o escopo por empresa precisa ser resolvido no servidor (§50)");
});
