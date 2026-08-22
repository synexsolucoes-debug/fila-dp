import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTOMATIC_THRESHOLD, SUGGESTION_THRESHOLD, agentActions, decideAgentProposal,
  isSensitiveAction, sanitizeAgentProposal, statusForDecision,
  type AgentProposal,
} from "../lib/agent-proposals.ts";

/* A arquitetura obrigatória é: agente → proposta → motor → serviço de domínio.
   Estes testes protegem o terceiro degrau, que é onde a regra vive: o que um
   agente pode fazer sozinho, o que vira sugestão, e o que nunca sai do humano. */

const proposal = (overrides: Partial<AgentProposal> = {}): AgentProposal => sanitizeAgentProposal({
  eventId: "evt-1",
  agentKey: "tangerino",
  agentVersion: "1.0.0",
  entityType: "admission",
  entityId: "emp-1",
  processInstanceId: "card-1",
  currentStepId: "Task_1",
  proposedAction: "process.advance",
  proposedStepId: "Task_2",
  reason: "Documentos conferidos na origem.",
  evidenceIds: ["consultation:1"],
  confidence: 0.95,
  requiresHumanApproval: false,
  idempotencyKey: "chave",
  ...overrides,
});

const decide = (input: Partial<Parameters<typeof decideAgentProposal>[0]> = {}) => decideAgentProposal({
  proposal: proposal(),
  policy: "trusted",
  agentEnabled: true,
  ...input,
});

test("o módulo do agente não tem nenhuma escrita: ele decide, não executa", async () => {
  const source = await readFile(new URL("../lib/agent-proposals.ts", import.meta.url), "utf8");
  for (const forbidden of [/\bINSERT\b/iu, /\bUPDATE\b/iu, /\bDELETE\b/iu, /\.prepare\(/u, /\.batch\(/u]) {
    assert.ok(!forbidden.test(source), `o motor de propostas ganhou acesso ao banco: ${forbidden}`);
  }
});

test("kill switch: agente pausado tem toda proposta recusada", () => {
  const result = decide({ agentEnabled: false });
  assert.equal(result.decision, "reject");
  assert.equal(result.code, "AGENT_PAUSED");
});

test("proposta sem agente ou sem evento de origem não é rastreável e é recusada", () => {
  assert.equal(decide({ proposal: proposal({ agentKey: "" }) }).code, "AGENT_PROPOSAL_UNTRACEABLE");
  assert.equal(decide({ proposal: proposal({ eventId: "" }) }).code, "AGENT_PROPOSAL_UNTRACEABLE");
});

test("ação fora do catálogo é recusada", () => {
  const result = decide({ proposal: proposal({ proposedAction: "banco.apagar_tudo" }) });
  assert.equal(result.decision, "reject");
  assert.equal(result.code, "AGENT_ACTION_UNKNOWN");
});

test("entidade não identificada vai para triagem — nunca para um palpite", () => {
  const result = decide({
    proposal: proposal({ entityId: "", processInstanceId: "", proposedAction: "triage.open" }),
  });
  assert.equal(result.decision, "triage");
  assert.equal(result.code, "AGENT_ENTITY_UNRESOLVED");
});

test("ação sensível nunca executa sozinha, mesmo com confiança máxima e grupo confiável", () => {
  for (const action of ["movement.request_salary_change", "movement.request_termination",
    "approval.record_decision", "closing.reopen", "erp.write"]) {
    assert.ok(isSensitiveAction(action), `${action} deveria ser sensível`);
    const result = decide({
      proposal: proposal({ proposedAction: action, confidence: 1, entityId: "emp-1" }),
    });
    assert.equal(result.decision, "suggest", `${action} não pode executar sozinho`);
    assert.equal(result.code, "AGENT_SENSITIVE_ACTION");
    assert.equal(result.requiresHuman, true);
  }
});

test("evento sensível no catálogo também impede execução automática", () => {
  const result = decide({ eventName: "salary.change_requested" });
  assert.equal(result.decision, "suggest");
  assert.equal(result.code, "AGENT_SENSITIVE_ACTION");
});

test("o agente pode pedir revisão humana e o motor obedece", () => {
  const result = decide({ proposal: proposal({ requiresHumanApproval: true }) });
  assert.equal(result.decision, "suggest");
  assert.equal(result.code, "AGENT_HUMAN_REQUESTED");
});

test("confiança baixa vai para triagem; média vira sugestão; alta executa", () => {
  const baixa = decide({ proposal: proposal({ confidence: SUGGESTION_THRESHOLD - 0.01 }) });
  assert.equal(baixa.decision, "triage");
  assert.equal(baixa.code, "AGENT_LOW_CONFIDENCE");

  const media = decide({ proposal: proposal({ confidence: AUTOMATIC_THRESHOLD - 0.01 }) });
  assert.equal(media.decision, "suggest");

  const alta = decide({ proposal: proposal({ confidence: AUTOMATIC_THRESHOLD }) });
  assert.equal(alta.decision, "execute");
  assert.equal(alta.requiresHuman, false);
});

test("grupo em `suggest_only` nunca executa, por mais alta que seja a confiança", () => {
  const result = decide({ policy: "suggest_only", proposal: proposal({ confidence: 1 }) });
  assert.equal(result.decision, "suggest");
  assert.equal(result.code, "AGENT_NEEDS_CONFIRMATION");
});

test("grupo com automação desligada manda tudo para triagem", () => {
  const result = decide({ policy: "off", proposal: proposal({ confidence: 1 }) });
  assert.equal(result.decision, "triage");
  assert.equal(result.code, "AGENT_AUTOMATION_OFF");
});

test("sem evidência anexada, a ação automática vira sugestão", () => {
  const result = decide({ proposal: proposal({ evidenceIds: [], confidence: 1 }) });
  assert.equal(result.decision, "suggest");
  assert.equal(result.code, "AGENT_EVIDENCE_REQUIRED");
});

test("avançar etapa exige a instância correspondente", () => {
  const result = decide({ proposal: proposal({ processInstanceId: "" }) });
  assert.equal(result.decision, "reject");
  assert.equal(result.code, "AGENT_INSTANCE_REQUIRED");
});

test("a proposta é sanitizada antes de qualquer decisão", () => {
  const clean = sanitizeAgentProposal({
    agentKey: "  tangerino  ",
    confidence: 7.5,
    evidenceIds: ["a", "a", "b"],
    requiresHumanApproval: "sim",
    proposedAction: "process.advance",
  });
  assert.equal(clean.agentKey, "tangerino");
  assert.equal(clean.confidence, 1, "confiança fora da faixa é presa à faixa");
  assert.deepEqual(clean.evidenceIds, ["a", "b"]);
  assert.equal(clean.requiresHumanApproval, true);

  const negativa = sanitizeAgentProposal({ confidence: -3, agentKey: "x" });
  assert.equal(negativa.confidence, 0);
  assert.equal(sanitizeAgentProposal({ confidence: "abc", agentKey: "x" }).confidence, 0);
});

test("cada decisão tem um estado persistido correspondente", () => {
  assert.equal(statusForDecision("execute"), "accepted");
  assert.equal(statusForDecision("suggest"), "suggested");
  assert.equal(statusForDecision("triage"), "pending_triage");
  assert.equal(statusForDecision("reject"), "rejected");
});

test("toda decisão traz código estável — a tela e a auditoria não leem texto livre", () => {
  const cases = [
    decide({ agentEnabled: false }),
    decide({ policy: "off" }),
    decide({ proposal: proposal({ confidence: 0.1 }) }),
    decide(),
  ];
  for (const result of cases) {
    assert.match(result.code, /^[A-Z_]+$/u, `código instável: ${result.code}`);
    assert.ok(result.reason.length > 10);
  }
});

test("o catálogo separa ação de rotina de ação sensível, sem sobreposição", () => {
  const sensitive = agentActions.filter(isSensitiveAction);
  const routine = agentActions.filter((action) => !isSensitiveAction(action));
  assert.ok(sensitive.length >= 5);
  assert.ok(routine.length >= 5);
  assert.equal(sensitive.length + routine.length, agentActions.length);
});
