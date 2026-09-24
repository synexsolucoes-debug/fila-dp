import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilities, hasCapability } from "../lib/authorization.ts";
import { capabilityCatalog } from "../lib/capability-catalog.ts";
import { moduleWriteCapabilities } from "../lib/modules.ts";
import {
  assertNoClinicalData, examResults, examTypes, parseOccupationalExamInput,
} from "../lib/occupational-exams.ts";

/**
 * Controle de exames ocupacionais (ASO), passo 1.
 *
 * Segue a mesma fronteira já praticada em Psicologia
 * (tests/psychology-clinical-boundary.test.mts): resultado e restrição
 * funcional entram, diagnóstico não. `result` é fechado em apto/inapto/apto
 * com restrição — nunca a doença ou o exame clínico que levou à conclusão.
 *
 * Diferente do Dashboard de Acidente de Trabalho, que anonimiza o
 * colaborador porque é estatístico, o ASO tem FK real para o colaborador —
 * é a razão de o módulo existir: "este colaborador específico está com o
 * exame em dia?".
 */

const migration = await readFile(new URL("../drizzle/postgres/0100_occupational_exams.sql", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const criar = await readFile(new URL("../app/api/occupational-exams/route.ts", import.meta.url), "utf8");
const editar = await readFile(new URL("../app/api/occupational-exams/[id]/route.ts", import.meta.url), "utf8");
const libExams = await readFile(new URL("../lib/occupational-exams.ts", import.meta.url), "utf8");

/* -------------------------------------------------------------------------- */
/* Migration, schema e RLS                                                    */
/* -------------------------------------------------------------------------- */

test("a tabela nasce com isolamento por tenant e FK real para o colaborador", () => {
  assert.match(migration, /CREATE TABLE "fdp_occupational_exams"/u);
  assert.match(migration, /ALTER TABLE "fdp_occupational_exams" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "fdp_occupational_exams" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /CREATE POLICY "fdp_occupational_exams_workspace_isolation"/u);
  assert.match(migration, /fdp_occupational_exams_employee_fk[\s\S]{0,200}"public"\."fdp_employees"/u);
});

test("o vocabulário de tipo e resultado é fechado no banco e no código", () => {
  assert.match(migration, /CHECK \("exam_type" IN \('admission', 'periodic', 'return_to_work', 'role_change', 'termination', 'other'\)\)/u);
  assert.match(migration, /CHECK \("result" IN \('fit', 'unfit', 'fit_with_restriction'\)\)/u);
  assert.deepEqual([...examTypes].sort(), ["admission", "other", "periodic", "return_to_work", "role_change", "termination"]);
  assert.deepEqual([...examResults].sort(), ["fit", "fit_with_restriction", "unfit"]);
});

test("restrição funcional só existe quando o resultado é apto com restrição, no banco e na validação", () => {
  assert.match(migration, /CONSTRAINT "fdp_occupational_exams_restriction_check" CHECK \("result" = 'fit_with_restriction' OR "restriction_notes" = ''\)/u);
  assert.throws(
    () => parseOccupationalExamInput({ companyId: "c1", employeeId: "e1", examType: "periodic", examDate: "2026-01-01", result: "fit", restrictionNotes: "não pode subir escada" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EXAM_RESTRICTION_WITHOUT_RESULT");
      return true;
    },
  );
  assert.doesNotThrow(() => parseOccupationalExamInput({ companyId: "c1", employeeId: "e1", examType: "periodic", examDate: "2026-01-01", result: "fit_with_restriction", restrictionNotes: "não pode subir escada" }));
});

test("o índice de vencimento serve a mesma pergunta do Motor de Prazos", () => {
  assert.match(migration, /CREATE INDEX "fdp_occupational_exams_workspace_due_idx"[\s\S]{0,120}WHERE "next_due_date" IS NOT NULL/u);
});

test("o schema declara as mesmas colunas e o mesmo vocabulário fechado", () => {
  assert.match(schema, /export const occupationalExams = pgTable\("fdp_occupational_exams"/u);
  assert.match(schema, /fdp_occupational_exams_employee_fk/u);
  assert.match(schema, /fdp_occupational_exams_restriction_check/u);
});

/* -------------------------------------------------------------------------- */
/* Validação de entrada                                                       */
/* -------------------------------------------------------------------------- */

function throwsWithCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

test("data do exame é obrigatória e não pode estar no futuro", () => {
  // optionalDate(value, true) já lança antes de chegarmos à checagem
  // EXAM_DATE_REQUIRED — mesmo comportamento de `optionalDate(body.occurredOn, true)`
  // em lib/work-accidents-service.ts, então o código de erro observado é o
  // genérico da validação de data, não o específico do exame.
  assert.throws(() => parseOccupationalExamInput({ companyId: "c1", employeeId: "e1", examType: "periodic", result: "fit" }), throwsWithCode("INVALID_DATE"));
  const futuro = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.throws(() => parseOccupationalExamInput({ companyId: "c1", employeeId: "e1", examType: "periodic", examDate: futuro, result: "fit" }), throwsWithCode("EXAM_DATE_IN_FUTURE"));
});

test("empresa, colaborador, tipo e resultado são obrigatórios e validados", () => {
  assert.throws(() => parseOccupationalExamInput({ employeeId: "e1", examType: "periodic", examDate: "2026-01-01", result: "fit" }), throwsWithCode("EXAM_COMPANY_REQUIRED"));
  assert.throws(() => parseOccupationalExamInput({ companyId: "c1", examType: "periodic", examDate: "2026-01-01", result: "fit" }), throwsWithCode("EXAM_EMPLOYEE_REQUIRED"));
  assert.throws(() => parseOccupationalExamInput({ companyId: "c1", employeeId: "e1", examType: "invalido", examDate: "2026-01-01", result: "fit" }), throwsWithCode("EXAM_INVALID_TYPE"));
  assert.throws(() => parseOccupationalExamInput({ companyId: "c1", employeeId: "e1", examType: "periodic", examDate: "2026-01-01", result: "invalido" }), throwsWithCode("EXAM_INVALID_RESULT"));
});

test("próximo vencimento é opcional e pode estar no futuro", () => {
  const parsed = parseOccupationalExamInput({
    companyId: "c1", employeeId: "e1", examType: "periodic", examDate: "2026-01-01",
    result: "fit", nextDueDate: "2027-01-01",
  });
  assert.equal(parsed.nextDueDate, "2027-01-01");
  const semVencimento = parseOccupationalExamInput({ companyId: "c1", employeeId: "e1", examType: "admission", examDate: "2026-01-01", result: "fit" });
  assert.equal(semVencimento.nextDueDate, null);
});

/* -------------------------------------------------------------------------- */
/* Fronteira clínica                                                          */
/* -------------------------------------------------------------------------- */

test("a guarda clínica aceita restrição funcional e recusa diagnóstico", () => {
  for (const legitimo of ["Não pode carregar peso acima de 10kg", "Restrito a trabalho sem exposição a ruído", "Apto sem restrições"]) {
    assert.doesNotThrow(() => assertNoClinicalData(legitimo), `"${legitimo}" é restrição funcional`);
  }
  for (const clinico of ["Diagnóstico de hérnia de disco", "Paciente relatou sintoma de tontura", "Encaminhado por medicação contínua", "Anexado ao prontuário do paciente"]) {
    assert.throws(() => assertNoClinicalData(clinico), /Dados clínicos/u, `"${clinico}" precisa ser recusado`);
  }
});

test("criar e editar exame passam pela guarda clínica nas notas e na restrição", () => {
  assert.match(libExams, /assertNoClinicalData\(restrictionNotes, notes\)/u);
  // A validação é compartilhada (parseOccupationalExamInput) entre criar e
  // editar — a mesma razão de `parseWorkAccidentInput`: se a correção fosse
  // mais frouxa, bastaria lançar certo e editar depois para burlar a guarda.
  assert.match(criar, /import \{ .*parseOccupationalExamInput.* \} from "@\/lib\/occupational-exams"/u);
  assert.match(editar, /import \{ parseOccupationalExamInput \} from "@\/lib\/occupational-exams"/u);
});

test("a auditoria guarda o fato administrativo, não a restrição funcional em texto livre", () => {
  assert.doesNotMatch(criar.slice(criar.indexOf("prepareAuditEvent({")), /restrictionNotes/u);
  const auditView = editar.slice(editar.indexOf("const auditView"), editar.indexOf("const auditView") + 400);
  assert.doesNotMatch(auditView, /restriction_notes|notes:/u);
});

/* -------------------------------------------------------------------------- */
/* Permissões                                                                 */
/* -------------------------------------------------------------------------- */

test("membro registra e corrige; só admin exclui", () => {
  assert.equal(hasCapability("member", "exams.view"), true);
  assert.equal(hasCapability("member", "exams.manage"), true);
  assert.equal(hasCapability("member", "exams.delete"), false);
  assert.equal(hasCapability("admin", "exams.delete"), true);
  assert.equal(hasCapability("observer", "exams.view"), true);
  assert.equal(hasCapability("observer", "exams.manage"), false);
  assert.equal(hasCapability("guest", "exams.view"), false);
});

test("as três capacidades estão descritas para quem administra o grupo", () => {
  for (const capability of ["exams.view", "exams.manage", "exams.delete"] as const) {
    assert.ok(capabilities.includes(capability), `${capability} fora do catálogo de capacidades`);
    assert.ok(capability in capabilityCatalog, `${capability} sem descrição para o administrador`);
  }
});

test("negar Cadastros fecha também a escrita de exames, porque a tela ainda mora na ficha do colaborador", () => {
  assert.ok(moduleWriteCapabilities.registrations.includes("exams.manage"));
  assert.ok(moduleWriteCapabilities.registrations.includes("exams.delete"));
});

test("as rotas exigem a capacidade certa em cada verbo", () => {
  assert.match(criar, /requireNamedCapability\(workspace, "exams\.view"/u);
  assert.match(criar, /requireNamedCapability\(workspace, "exams\.manage"/u);
  assert.match(editar, /requireNamedCapability\(workspace, "exams\.manage".*corrigir/u);
  assert.match(editar, /requireNamedCapability\(workspace, "exams\.delete"/u);
});

/* -------------------------------------------------------------------------- */
/* A tela                                                                     */
/* -------------------------------------------------------------------------- */

test("a aba de exames aparece na ficha do colaborador", async () => {
  const view = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");
  assert.match(view, /"exams"/u);
  assert.match(view, /Exames \(ASO\)/u);
  assert.match(view, /EmployeeExamsPanel employeeId=\{employee\.id\} companyId=\{employee\.companyId\} canManage=\{canManageExams\}/u);
});
