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
  /* O rótulo é o nome de produto, e não o mecanismo: quem tria precisa saber
     **quem** trouxe o item, não que o Sankhya é lido por navegador. As duas
     chaves antigas continuam traduzidas porque estão gravadas em propostas que
     já existem. */
  assert.equal(originLabel("sankhya_browser"), "Agente Sankhya");
  assert.equal(originLabel("sankhya"), "Agente Sankhya");
  assert.equal(originLabel("tangerino_browser"), "Agente Tangerino");
  assert.equal(originLabel("teams"), "Agente Teams");
  // Conector aposentado: o rótulo fica porque as propostas dele seguem na fila.
  assert.match(originLabel("solides"), /Sólides/u);
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


/* -------------------------------------------------------------------------- *
 * A resolução, na rota que a governa (§62)
 * -------------------------------------------------------------------------- */

const resolveRoute = async () => readFile(
  new URL("../app/api/agents/proposals/[id]/resolve/route.ts", import.meta.url), "utf8");

test("aceitar, recusar e descartar são as três saídas, e nenhuma outra", async () => {
  const source = await resolveRoute();
  assert.match(source, /\["apply", "reject", "discard"\]\.includes\(action\)/u,
    "uma ação nova entrando por texto livre é a porta que a triagem existe para fechar");
});

test("item já resolvido devolve conflito, e não sobrescreve a decisão anterior", async () => {
  const source = await resolveRoute();
  assert.match(source, /AGENT_PROPOSAL_ALREADY_RESOLVED/u);
  assert.match(source, /409/u);
  // A condição também está no `WHERE` da escrita: duas pessoas resolvendo ao
  // mesmo tempo não podem produzir duas resoluções.
  assert.match(source, /status IN \('pending_triage', 'suggested', 'accepted'\)/u);
});

test("ação sensível é recusada mesmo depois de confirmada por uma pessoa (§18)", async () => {
  const source = await resolveRoute();
  assert.match(source, /isSensitiveAction\(proposedAction\)/u);
  assert.match(source, /AGENT_SENSITIVE_ACTION/u);
  // A recusa vem antes de qualquer escrita: confirmar não abre exceção.
  assert.ok(source.indexOf("isSensitiveAction") < source.indexOf("prepareTransitionStatement"),
    "a checagem de ação sensível precisa vir antes da escrita");
});

test("aplicar passa pelo serviço de domínio, e não por UPDATE direto (§17)", async () => {
  const source = await resolveRoute();
  for (const exigido of ["loadPublishedVersion", "evaluateTransition", "prepareTransitionStatement"]) {
    assert.ok(source.includes(exigido), `a aplicação deixou de reavaliar: ${exigido}`);
  }
  assert.match(source, /CARD_VERSION_CONFLICT/u,
    "a concorrência otimista precisa recusar quem viu um estado antigo");
});

test("toda decisão de triagem entra na auditoria (§51)", async () => {
  const source = await resolveRoute();
  assert.match(source, /action: "agent\.proposal_resolved"/u);
  assert.match(source, /action: "agent\.proposal_applied"/u);

  const assign = await readFile(new URL("../app/api/agents/proposals/[id]/assign/route.ts", import.meta.url), "utf8");
  assert.match(assign, /triage\.assigned/u);
  assert.match(assign, /triage\.unassigned/u);
  assert.match(assign, /AGENT_PROPOSAL_ALREADY_RESOLVED/u,
    "encaminhar item já decidido faria alguém abrir para descobrir que não havia o que fazer");
});
