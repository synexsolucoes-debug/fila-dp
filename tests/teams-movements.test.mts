import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_THRESHOLD, extractEffectiveDate, interpretTeamsMessage, movementTaskDraft,
  parseBrazilianMoney, plainTextFromTeams, REVIEW_THRESHOLD,
} from "../lib/teams-movements.ts";

/**
 * O requisito que estes testes protegem: mensagem publicada no canal do Teams
 * só pode virar demanda quando o sistema realmente entendeu a movimentação.
 * Qualquer mensagem contendo "salário" ou "cargo" virando demanda geraria
 * trabalho falso no DP — e trabalho falso é pior do que automação nenhuma,
 * porque alguém precisa conferir e fechar cada cartão inventado.
 */

test("a mensagem de alteração salarial do enunciado vira demanda completa", () => {
  const reading = interpretTeamsMessage("João da Silva terá alteração salarial para R$ 5.500,00 a partir de 01/09/2026.");
  assert.equal(reading.kind, "salary_change");
  assert.equal(reading.decision, "create");
  assert.equal(reading.employeeName, "João da Silva");
  assert.equal(reading.newSalary, 5500);
  assert.equal(reading.effectiveDate, "2026-09-01");
  assert.deepEqual(reading.missing, []);
  assert.ok(reading.confidence >= CREATE_THRESHOLD);
});

test("a mensagem de mudança de função do enunciado traz cargo atual e novo", () => {
  const reading = interpretTeamsMessage("Maria Souza passará de Assistente Administrativo para Analista Administrativo em 01/09/2026.");
  assert.equal(reading.kind, "role_change");
  assert.equal(reading.decision, "create");
  assert.equal(reading.employeeName, "Maria Souza");
  assert.equal(reading.previousRole, "Assistente Administrativo");
  assert.equal(reading.newRole, "Analista Administrativo");
  assert.equal(reading.effectiveDate, "2026-09-01");
});

test("card de aprovação admissional do Teams vira demanda mesmo para candidato ainda não cadastrado", () => {
  const card = "Rejeitado VALMIR JUNIOR - VENDAS PAP - GOIÂNIA Nome completo: Valdemir dos Santos Paes de Andrade CPF: 987.654.321-00 CNH: Validade: Categoria: E-mail: candidato@example.com Telefone: (62) 99999-0000 Solicitado por: Gabriella de Paula 1: Rejeitada por Vanessa";
  const reading = interpretTeamsMessage(card);
  assert.equal(reading.kind, "admission");
  assert.equal(reading.decision, "create");
  assert.equal(reading.employeeName, "Valdemir dos Santos Paes de Andrade");
  const draft = movementTaskDraft(reading, { senderName: "Power Automate", teamName: "RH", channelName: "Admissões", messageId: "card-1", messageUrl: "", originalText: card });
  assert.equal(draft.processType, "ADMISSÃO");
  assert.match(draft.title, /Valdemir dos Santos/u);
  assert.ok(draft.checklist.some((item) => /decisão|aprovação/iu.test(item)));
});

test("desligamento e advertência assertivos no canal viram demandas", () => {
  const known = ["João da Silva", "Maria Souza"];
  const termination = interpretTeamsMessage("João da Silva será desligado em 30/09/2026. Último dia de trabalho confirmado.", known);
  assert.equal(termination.kind, "termination");
  assert.equal(termination.decision, "create");
  assert.equal(movementTaskDraft(termination, { senderName: "Gestora", teamName: "RH", channelName: "Desligamentos", messageId: "2", messageUrl: "", originalText: "desligamento" }).processType, "DESLIGAMENTO");

  const warning = interpretTeamsMessage("Aplicar advertência disciplinar para Maria Souza por ocorrência registrada hoje.", known);
  assert.equal(warning.kind, "warning");
  assert.equal(warning.decision, "create");
  assert.equal(movementTaskDraft(warning, { senderName: "Gestor", teamName: "RH", channelName: "Advertências", messageId: "3", messageUrl: "", originalText: "advertência" }).processType, "ADVERTÊNCIA");
});

test("de X para Y com dois valores identifica salário anterior e novo", () => {
  const reading = interpretTeamsMessage("Reajuste salarial de Pedro Alves de R$ 4.000,00 para R$ 4.800,00 com vigência em 01/12/2026.");
  assert.equal(reading.previousSalary, 4000);
  assert.equal(reading.newSalary, 4800);
  assert.equal(reading.decision, "create");
});

test("pergunta sobre salário não vira movimentação", () => {
  // O caso citado no requisito: a palavra aparece, a intenção não existe.
  for (const message of [
    "Pessoal, qual o prazo para alteração salarial este mês?",
    "Bom dia! Alguém sabe como funciona a mudança de cargo?",
    "Como funciona o reajuste salarial na convenção?",
  ]) {
    const reading = interpretTeamsMessage(message);
    assert.equal(reading.decision, "ignore", message);
  }
});

test("hipótese e cancelamento não viram demanda", () => {
  for (const message of [
    "Estamos avaliando um aumento salarial para o time comercial.",
    "A alteração salarial de Carlos Pereira foi cancelada.",
    "Proposta de mudança de cargo em análise pela diretoria.",
  ]) {
    const reading = interpretTeamsMessage(message);
    assert.equal(reading.decision, "ignore", message);
  }
});

test("conversa sem relação com DP não é sequer classificada", () => {
  const reading = interpretTeamsMessage("Vamos almoçar hoje? Marquei mesa para as 12h.");
  assert.equal(reading.kind, null);
  assert.equal(reading.decision, "ignore");
});

test("movimentação reconhecida sem dado obrigatório vira sugestão, não demanda", () => {
  // É a regra central do requisito 6: em vez de abrir uma demanda errada, abre
  // uma sugestão dizendo exatamente o que falta.
  const reading = interpretTeamsMessage("João da Silva terá alteração salarial a partir de 01/09/2026.");
  assert.equal(reading.kind, "salary_change");
  assert.equal(reading.decision, "review");
  assert.deepEqual(reading.missing, ["novoSalario"]);
  assert.ok(reading.confidence >= REVIEW_THRESHOLD);
  // A nota alta sozinha não basta: faltando dado obrigatório a decisão é
  // sempre `review`, mesmo com confiança no patamar de criação. Um cartão
  // incompleto no fluxo do DP custa mais do que uma sugestão a confirmar.
  assert.ok(reading.confidence >= CREATE_THRESHOLD, "a leitura em si é confiável");
  assert.equal(reading.decision, "review", "o dado que falta é o que decide, não a nota");
});

test("sem data de vigência a movimentação também fica para validação", () => {
  const reading = interpretTeamsMessage("Maria Souza passará de Assistente Administrativo para Analista Administrativo.");
  assert.equal(reading.decision, "review");
  assert.ok(reading.missing.includes("dataVigencia"));
});

test("colaborador conhecido no cadastro eleva a confiança da leitura", () => {
  const message = "João da Silva terá alteração salarial para R$ 5.500,00.";
  const anonymous = interpretTeamsMessage(message);
  const known = interpretTeamsMessage(message, ["João da Silva", "Maria Souza"]);
  assert.ok(known.confidence > anonymous.confidence, "casar com o cadastro é evidência de que a pessoa é real");
  assert.ok(known.signals.includes("colaborador_encontrado_no_cadastro"));
});

test("nome do colaborador é quem antecede o verbo, não quem aparece primeiro", () => {
  const reading = interpretTeamsMessage(
    "Conforme alinhado com o RH, Ana Paula Ferreira passará de Analista Júnior para Analista Pleno a partir de 15/10/2026.",
  );
  assert.equal(reading.employeeName, "Ana Paula Ferreira");
});

test("palavra de gatilho nunca é gravada como nome de colaborador", () => {
  // Gravar "Estamos" ou "Alteração" como colaborador é pior do que deixar vazio:
  // parece dado conferido e engana quem revisa a sugestão.
  for (const message of ["Estamos avaliando um aumento salarial.", "Alteração salarial aprovada."]) {
    assert.equal(interpretTeamsMessage(message).employeeName, "", message);
  }
});

test("dinheiro em português é lido pela regra pt-BR, não pela do JavaScript", () => {
  // `5.500` é cinco mil e quinhentos. Ler como 5,5 gravaria um salário mil
  // vezes menor na demanda.
  assert.equal(parseBrazilianMoney("5.500,00"), 5500);
  assert.equal(parseBrazilianMoney("5.500"), 5500);
  assert.equal(parseBrazilianMoney("4800,50"), 4800.5);
  assert.equal(parseBrazilianMoney("1.234.567,89"), 1234567.89);
  assert.equal(parseBrazilianMoney(""), null);
  assert.equal(parseBrazilianMoney("0"), null);
});

test("vigência aceita os formatos que o cliente escreve de verdade", () => {
  assert.equal(extractEffectiveDate("a partir de 01/09/2026"), "2026-09-01");
  assert.equal(extractEffectiveDate("com vigência 2026-09-01"), "2026-09-01");
  assert.equal(extractEffectiveDate("a partir de 1º de setembro de 2026"), "2026-09-01");
  assert.equal(extractEffectiveDate("data inválida 32/13/2026"), "");
  assert.equal(extractEffectiveDate("sem data nenhuma"), "");
});

test("o corpo HTML do Teams vira texto limpo antes de ser interpretado", () => {
  const html = "<div><p>João da Silva terá <b>alteração salarial</b> para R$ 5.500,00 a partir de 01/09/2026.</p></div>";
  assert.equal(
    plainTextFromTeams(html),
    "João da Silva terá alteração salarial para R$ 5.500,00 a partir de 01/09/2026.",
  );
  assert.equal(interpretTeamsMessage(html).decision, "create");
});

test("a demanda gerada preserva a mensagem original e a origem", () => {
  const original = "João da Silva terá alteração salarial para R$ 5.500,00 a partir de 01/09/2026.";
  const reading = interpretTeamsMessage(original);
  const draft = movementTaskDraft(reading, {
    senderName: "Renata Gestora", teamName: "Departamento Pessoal", channelName: "Movimentações",
    messageId: "1699999999999", messageUrl: "https://teams.microsoft.com/l/message/x/y", originalText: original,
  });
  assert.equal(draft.processType, "ALTERAÇÃO SALARIAL");
  assert.match(draft.title, /Alteração salarial — João da Silva/u);
  // Quem abrir o cartão precisa conseguir conferir contra o que foi publicado,
  // sem voltar ao Teams.
  assert.ok(draft.description.includes(original), "a mensagem original fica na demanda");
  assert.match(draft.description, /Renata Gestora/u);
  assert.match(draft.description, /Departamento Pessoal/u);
  assert.match(draft.description, /Movimentações/u);
  assert.match(draft.description, /R\$\s?5\.500,00/u);
  assert.ok(draft.checklist.length >= 5, "a demanda nasce com o checklist do processo");
});

test("a demanda de cargo descreve a transição e verifica reflexo salarial", () => {
  const original = "Maria Souza passará de Assistente Administrativo para Analista Administrativo em 01/09/2026.";
  const draft = movementTaskDraft(interpretTeamsMessage(original), {
    senderName: "RH", teamName: "DP", channelName: "Movimentações",
    messageId: "2", messageUrl: "", originalText: original,
  });
  assert.equal(draft.processType, "ALTERAÇÃO DE CARGO/FUNÇÃO");
  assert.match(draft.description, /Assistente Administrativo/u);
  assert.match(draft.description, /Analista Administrativo/u);
  assert.ok(
    draft.checklist.some((item) => /altera[çc][ãa]o salarial/iu.test(item)),
    "mudança de cargo costuma vir com reflexo salarial e o checklist precisa lembrar disso",
  );
});
