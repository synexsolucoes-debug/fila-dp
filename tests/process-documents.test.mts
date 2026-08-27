import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DOCUMENT_PROOF, DOCUMENT_PROOFS, attachmentMatchesDocument, describeMissingDocuments,
  documentTokens, missingDocuments, normalizeDocumentText, parseDocumentProof,
} from "../lib/process-documents.ts";
import {
  evaluateStepRequirements, type ProcessStepConfig, type TransitionActor,
} from "../lib/process-instances.ts";

/**
 * §26: documento obrigatório conferido por documento.
 *
 * O que estes testes protegem é o par difícil: a conferência precisa recusar o
 * que falta **sem** recusar arquivo legítimo, e precisa não valer para quem não
 * pediu — porque ligá-la para todo mundo pararia demanda que hoje anda.
 */

const step = (overrides: Partial<ProcessStepConfig> = {}): ProcessStepConfig => ({
  id: "cfg", bpmnElementId: "Task_1", stepType: "USER_TASK", name: "Documentação",
  instructions: "", departmentId: "", responsibleUserId: "", responsibilityMode: "ANY",
  slaValue: 0, slaUnit: "hours", slaBusinessDays: false,
  requesterDepartmentId: "", responsibleDepartmentId: "",
  checklist: [], requiredDocuments: [], evidenceRequired: false,
  requiresApproval: false, approverUserId: "", approverDepartmentId: "",
  demandPriority: "normal", transitions: {}, entryRules: [], exitRules: [],
  blockingIntegrations: [], documentProof: "declared", ...overrides,
});

const actor: TransitionActor = {
  userId: "user-1", email: "analista@empresa.com", role: "member",
  canDecideApprovals: false, areaIds: new Set<string>(),
};

const requirements = (config: ProcessStepConfig, attachmentNames: string[]) =>
  evaluateStepRequirements({
    config, actor, createdByEmail: "outro@empresa.com",
    pendingChecklist: 0, attachmentCount: attachmentNames.length, attachmentNames,
  });

/* ── Normalização ──────────────────────────────────────────────────────── */

test("acento, caixa e pontuação não decidem se o documento foi entregue", () => {
  // A conferência não pode depender de quem digitou ter usado cedilha.
  assert.equal(normalizeDocumentText("Comprovante de Residência"), "comprovante de residencia");
  assert.equal(normalizeDocumentText("CPF/RG — cópia"), "cpf rg copia");
  assert.equal(normalizeDocumentText(""), "");
});

test("as palavras que identificam o documento excluem as partículas", () => {
  // Sem isso, "Comprovante **de** residência" exigiria o "de" no nome do
  // arquivo, e `comprovante-residencia.pdf` seria recusado.
  assert.deepEqual(documentTokens("Comprovante de residência"), ["comprovante", "residencia"]);
  assert.deepEqual(documentTokens("CPF"), ["cpf"]);
});

test("nome só com partícula não vira exigência impossível", () => {
  // Sem a saída, não sobraria palavra significativa e o documento nunca
  // poderia ser atendido — a etapa ficaria travada para sempre.
  assert.deepEqual(documentTokens("de"), ["de"]);
  assert.equal(attachmentMatchesDocument("de.pdf", "de"), true);
});

/* ── Casamento ─────────────────────────────────────────────────────────── */

test("o arquivo atende o documento quando traz todas as palavras dele", () => {
  const doc = "Comprovante de residência";
  assert.equal(attachmentMatchesDocument("comprovante-residencia-joao.pdf", doc), true);
  assert.equal(attachmentMatchesDocument("Comprovante de Residencia.PDF", doc), true);
  assert.equal(attachmentMatchesDocument("comprovanteresidencia.jpg", doc), true,
    "quem nomeia arquivo junta tudo às vezes");
});

test("uma palavra em comum não basta", () => {
  /* Com "alguma palavra", `contrato.pdf` atenderia "Contrato de experiência" e
     "Contrato social" ao mesmo tempo, e a conferência viraria teatro. */
  assert.equal(attachmentMatchesDocument("contrato.pdf", "Contrato de experiência"), false);
  assert.equal(attachmentMatchesDocument("comprovante.pdf", "Comprovante de residência"), false);
});

test("arquivo de outro documento não atende", () => {
  assert.equal(attachmentMatchesDocument("contrato.pdf", "CPF"), false);
  assert.equal(attachmentMatchesDocument("", "CPF"), false);
});

test("um arquivo pode atender mais de um documento", () => {
  // "CPF e RG.pdf" é juntada legítima; recusá-la obrigaria a pessoa a separar
  // páginas para satisfazer o sistema.
  assert.deepEqual(missingDocuments(["CPF", "RG"], ["CPF e RG.pdf"]), []);
});

test("faltando, a lista diz exatamente o que falta", () => {
  const missing = missingDocuments(["CPF", "RG", "ASO"], ["cpf-joao.pdf"]);
  assert.deepEqual(missing, ["RG", "ASO"]);
  assert.match(describeMissingDocuments(missing), /RG, ASO/u);
  assert.match(describeMissingDocuments(["CPF"]), /"CPF"/u);
});

test("documento em branco na configuração não trava a etapa", () => {
  assert.deepEqual(missingDocuments(["", "   "], []), []);
});

/* ── Configuração ──────────────────────────────────────────────────────── */

test("o padrão é o comportamento anterior", () => {
  // Retrocompatibilidade não é promessa de comentário: valor desconhecido,
  // ausente ou corrompido cai em `declared`, que é como o produto sempre foi.
  assert.equal(DEFAULT_DOCUMENT_PROOF, "declared");
  for (const raw of [undefined, null, "", "sim", 42, {}, "ATTACHED_MAYBE"]) {
    assert.equal(parseDocumentProof(raw), "declared", `${String(raw)} não pode virar exigência nova`);
  }
  assert.equal(parseDocumentProof("attached"), "attached");
  assert.equal(parseDocumentProof(" ATTACHED "), "attached");
  assert.deepEqual([...DOCUMENT_PROOFS], ["declared", "attached"]);
});

/* ── Motor ─────────────────────────────────────────────────────────────── */

test("etapa que não pediu a conferência continua avançando como antes (§48)", () => {
  /* Este é o teste que autoriza a mudança a existir: uma demanda em versão
     antiga, com documento obrigatório e nenhum anexo, não pode passar a ser
     recusada por uma regra publicada depois dela. */
  const blockers = requirements(step({ requiredDocuments: ["CPF", "RG"] }), []);
  assert.deepEqual(blockers, []);
});

test("com a conferência ligada, o documento que falta trava o avanço", () => {
  const blockers = requirements(
    step({ requiredDocuments: ["CPF", "Comprovante de residência"], documentProof: "attached" }),
    ["cpf-joao.pdf"]);
  assert.deepEqual(blockers.map((item) => item.code), ["PROCESS_STEP_DOCUMENT_MISSING"]);
  assert.match(blockers[0].message, /Comprovante de residência/u,
    "o motivo precisa nomear o documento; 'documento faltando' não destrava nada");
});

test("com todos os documentos anexados, a etapa anda", () => {
  const blockers = requirements(
    step({ requiredDocuments: ["CPF", "Comprovante de residência"], documentProof: "attached" }),
    ["cpf.pdf", "comprovante_residencia.png"]);
  assert.deepEqual(blockers, []);
});

test("a conferência por documento e a evidência genérica coexistem", () => {
  /* São exigências diferentes: uma pergunta "existe algum anexo", a outra
     "existe o anexo *deste* documento". Uma etapa pode querer as duas, e
     colapsá-las esconderia uma delas de quem configurou. */
  const blockers = requirements(
    step({ requiredDocuments: ["CPF"], documentProof: "attached", evidenceRequired: true }), []);
  assert.deepEqual(blockers.map((item) => item.code).sort(), [
    "PROCESS_STEP_DOCUMENT_MISSING", "PROCESS_STEP_EVIDENCE_REQUIRED",
  ]);
});

test("etapa com a conferência ligada e nenhum documento exigido não inventa bloqueio", () => {
  assert.deepEqual(requirements(step({ documentProof: "attached" }), []), []);
});

/* ── Gravação ──────────────────────────────────────────────────────────── */

test("o saneador grava a escolha, em vez de descartá-la", async () => {
  /* O mesmo alçapão do #100: `sanitizeProcessStepConfigs` monta `settings`
     campo a campo. Sem a linha, a etapa mostraria "exigir anexo" na tela e
     continuaria conferindo nada — configuração que existe e não vale. */
  const { sanitizeProcessStepConfigs } = await import("../lib/process-management.ts");
  const [attached] = sanitizeProcessStepConfigs([{
    bpmnElementId: "Task_1", settings: { documentProof: "attached" },
  }]);
  assert.equal(attached.settings.documentProof, "attached");

  const [padrao] = sanitizeProcessStepConfigs([{ bpmnElementId: "Task_1", settings: {} }]);
  assert.equal(padrao.settings.documentProof, "declared");
});

test("a tela oferece exatamente as opções que o servidor aceita", async () => {
  // Uma opção a mais na tela entregaria uma regra que o servidor descarta em
  // silêncio — parece configurada e não é.
  const { readFile } = await import("node:fs/promises");
  const modeler = await readFile(
    new URL("../app/painel/features/processes/ProcessModeler.tsx", import.meta.url), "utf8");
  const block = modeler.slice(modeler.indexOf("Como conferir os obrigatórios"));
  for (const proof of DOCUMENT_PROOFS) {
    assert.match(block, new RegExp(`value="${proof}"`, "u"), `${proof} sem opção na tela`);
  }
  assert.ok(!/value="verified"|value="strict"/u.test(block),
    "a tela não pode oferecer um modo que o parser não conhece");
});
