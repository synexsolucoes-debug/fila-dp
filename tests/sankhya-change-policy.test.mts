import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decideSankhyaChange, proposedActionFor, sensitiveFieldLabel, CHANGE_PROPOSAL_CONFIDENCE } from "../lib/sankhya/change-policy.ts";
import { AUTOMATIC_THRESHOLD } from "../lib/agent-proposals.ts";

/* O agente Sankhya gravava tudo: colaborador novo entrava direto e qualquer
   campo alterado na origem sobrescrevia o do Vinculato. Estes testes protegem a
   linha entre transcrever e decidir. */

test("colaborador novo nunca entra sozinho", () => {
  const decisao = decideSankhyaChange({ classification: "new", changedFields: [] });
  assert.equal(decisao.outcome, "proposal");
  assert.match(decisao.reason, /duplicad|conferir/iu);
});

test("campo descritivo é transcrição, e o agente grava", () => {
  for (const campo of ["email", "phone", "fullName", "departmentName", "scheduleName"]) {
    assert.equal(decideSankhyaChange({ classification: "changed", changedFields: [campo] }).outcome, "direct",
      `${campo} passou a exigir decisão — parar a operação por telefone treina a confirmar sem ler`);
  }
});

test("salário, cargo, situação e desligamento esperam decisão", () => {
  for (const campo of ["salaryCents", "positionCode", "positionName", "employmentStatus", "terminationDate"]) {
    const decisao = decideSankhyaChange({ classification: "changed", changedFields: [campo] });
    assert.equal(decisao.outcome, "proposal", `${campo} voltou a ser gravado sozinho`);
    assert.deepEqual(decisao.sensitiveFields, [campo]);
    assert.ok(decisao.reason.length > 40, `${campo} sem explicação para quem decide`);
  }
});

test("um campo sensível no meio de vários descritivos ainda vira proposta", () => {
  const decisao = decideSankhyaChange({ classification: "changed", changedFields: ["email", "phone", "salaryCents"] });
  assert.equal(decisao.outcome, "proposal");
  assert.deepEqual(decisao.sensitiveFields, ["salaryCents"]);
});

test("nada mudou: nada acontece", () => {
  assert.equal(decideSankhyaChange({ classification: "unchanged", changedFields: [] }).outcome, "none");
});

test("criar e atualizar são ações diferentes para quem decide", () => {
  assert.equal(proposedActionFor("new"), "employee.create");
  assert.equal(proposedActionFor("changed"), "employee.update");
});

test("a confiança fica abaixo da faixa automática, ou a política se anularia", () => {
  // Confiança alta empurraria a proposta para o caminho automático do motor e
  // devolveria exatamente a gravação direta que esta política tira do caminho.
  assert.ok(CHANGE_PROPOSAL_CONFIDENCE < AUTOMATIC_THRESHOLD);
});

test("o rótulo do campo é português, e não o nome da coluna", () => {
  assert.equal(sensitiveFieldLabel("salaryCents"), "Salário");
  assert.equal(sensitiveFieldLabel("terminationDate"), "Data de desligamento");
});

test("o importador não grava o que virou proposta", async () => {
  const source = await readFile(new URL("../lib/sankhya/importer.ts", import.meta.url), "utf8");
  assert.match(source, /decideSankhyaChange/u);
  // A gravação direta acontece nos dois ramos que sobraram, e nunca no de proposta.
  const bloco = source.slice(source.indexOf('if (policy.outcome === "proposal")'), source.indexOf("} else if (!employee)"));
  for (const proibido of [/INSERT INTO fdp_employees/u, /UPDATE fdp_employees/u]) {
    assert.ok(!proibido.test(bloco), `o ramo de proposta voltou a gravar: ${proibido}`);
  }
  assert.match(source, /INSERT INTO fdp_agent_proposals/u, "a proposta precisa ser criada, e não só contada");
  assert.match(source, /pending_triage/u);
});

test("reprocessar a mesma leitura não gera uma segunda proposta", async () => {
  const source = await readFile(new URL("../lib/sankhya/importer.ts", import.meta.url), "utf8");
  assert.match(source, /ON CONFLICT \(workspace_id, idempotency_key\)/u);
  // A chave amarra a proposta ao hash da leitura.
  assert.match(source, /idempotencyKey: `sankhya:\$\{input\.integrationId\}:\$\{normalized\.externalEmployeeId\}:\$\{hash\}`/u);
});
