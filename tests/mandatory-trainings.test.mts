import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilities, hasCapability } from "../lib/authorization.ts";
import { capabilityCatalog } from "../lib/capability-catalog.ts";
import { moduleWriteCapabilities } from "../lib/modules.ts";
import { parseTrainingInput, trainingStatus } from "../lib/trainings.ts";

/**
 * Treinamentos obrigatórios (NR), passo 1.
 *
 * Mesmo passivo do ASO (tests/occupational-exams.test.mts), com a mesma
 * causa: "quando vence o próximo treinamento?" mora em planilha ou memória.
 * Diferente do ASO, o produto não fecha o vocabulário do treinamento —
 * `training_name` é texto livre, pelo mesmo motivo de
 * `positions.specialActivities` (0098): não cabe ao Vinculato decidir quais
 * NRs existem.
 */

const migration = await readFile(new URL("../drizzle/postgres/0102_mandatory_trainings.sql", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const criar = await readFile(new URL("../app/api/trainings/route.ts", import.meta.url), "utf8");
const editar = await readFile(new URL("../app/api/trainings/[id]/route.ts", import.meta.url), "utf8");

function throwsWithCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

/* -------------------------------------------------------------------------- */
/* Migration, schema e RLS                                                    */
/* -------------------------------------------------------------------------- */

test("a tabela nasce com isolamento por tenant e FK real para o colaborador", () => {
  assert.match(migration, /CREATE TABLE "fdp_trainings"/u);
  assert.match(migration, /ALTER TABLE "fdp_trainings" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "fdp_trainings" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /CREATE POLICY "fdp_trainings_workspace_isolation"/u);
  assert.match(migration, /fdp_trainings_employee_fk[\s\S]{0,200}"public"\."fdp_employees"/u);
});

test("o nome do treinamento é texto livre, mas não pode ser vazio", () => {
  assert.match(migration, /CONSTRAINT "fdp_trainings_name_check" CHECK \(length\(trim\("training_name"\)\) > 0\)/u);
  assert.throws(() => parseTrainingInput({ companyId: "c1", employeeId: "e1", trainingName: "   ", completedOn: "2026-01-01" }),
    throwsWithCode("TRAINING_NAME_REQUIRED"));
});

test("a validade não pode terminar antes da conclusão, no banco e na validação", () => {
  assert.match(migration, /CONSTRAINT "fdp_trainings_validity_check" CHECK \("valid_until" IS NULL OR "valid_until" >= "completed_on"\)/u);
  assert.throws(
    () => parseTrainingInput({ companyId: "c1", employeeId: "e1", trainingName: "NR-35", completedOn: "2026-06-01", validUntil: "2026-01-01" }),
    throwsWithCode("TRAINING_VALIDITY_BEFORE_COMPLETION"),
  );
  assert.doesNotThrow(() => parseTrainingInput({ companyId: "c1", employeeId: "e1", trainingName: "NR-35", completedOn: "2026-01-01", validUntil: "2028-01-01" }));
});

test("o índice de validade serve a mesma pergunta do Motor de Prazos", () => {
  assert.match(migration, /CREATE INDEX "fdp_trainings_workspace_due_idx"[\s\S]{0,120}WHERE "valid_until" IS NOT NULL/u);
});

test("o schema declara as mesmas colunas e as mesmas guardas", () => {
  assert.match(schema, /export const trainings = pgTable\("fdp_trainings"/u);
  assert.match(schema, /fdp_trainings_employee_fk/u);
  assert.match(schema, /fdp_trainings_validity_check/u);
});

/* -------------------------------------------------------------------------- */
/* Validação de entrada                                                       */
/* -------------------------------------------------------------------------- */

test("conclusão é obrigatória e não pode estar no futuro", () => {
  assert.throws(() => parseTrainingInput({ companyId: "c1", employeeId: "e1", trainingName: "NR-35" }), throwsWithCode("INVALID_DATE"));
  const futuro = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.throws(() => parseTrainingInput({ companyId: "c1", employeeId: "e1", trainingName: "NR-35", completedOn: futuro }), throwsWithCode("TRAINING_DATE_IN_FUTURE"));
});

test("empresa, colaborador e nome são obrigatórios", () => {
  assert.throws(() => parseTrainingInput({ employeeId: "e1", trainingName: "NR-35", completedOn: "2026-01-01" }), throwsWithCode("TRAINING_COMPANY_REQUIRED"));
  assert.throws(() => parseTrainingInput({ companyId: "c1", trainingName: "NR-35", completedOn: "2026-01-01" }), throwsWithCode("TRAINING_EMPLOYEE_REQUIRED"));
  assert.throws(() => parseTrainingInput({ companyId: "c1", employeeId: "e1", completedOn: "2026-01-01" }), throwsWithCode("TRAINING_NAME_REQUIRED"));
});

test("validade é opcional — treinamento sem vencimento não é um erro", () => {
  const parsed = parseTrainingInput({ companyId: "c1", employeeId: "e1", trainingName: "Integração", completedOn: "2026-01-01" });
  assert.equal(parsed.validUntil, null);
  const comVencimento = parseTrainingInput({ companyId: "c1", employeeId: "e1", trainingName: "NR-35", completedOn: "2026-01-01", validUntil: "2028-01-01" });
  assert.equal(comVencimento.validUntil, "2028-01-01");
});

/* -------------------------------------------------------------------------- */
/* Situação da validade                                                       */
/* -------------------------------------------------------------------------- */

test("a régua de situação segue o mesmo vocabulário do CA de EPI: vencido, vencendo, no prazo, sem vencimento", () => {
  assert.equal(trainingStatus(null, "2026-06-01"), "no_expiry");
  assert.equal(trainingStatus("2026-05-01", "2026-06-01"), "expired");
  assert.equal(trainingStatus("2026-06-15", "2026-06-01"), "expiring");
  assert.equal(trainingStatus("2027-06-01", "2026-06-01"), "valid");
});

/* -------------------------------------------------------------------------- */
/* Permissões                                                                 */
/* -------------------------------------------------------------------------- */

test("membro registra e corrige; só admin exclui", () => {
  assert.equal(hasCapability("member", "trainings.view"), true);
  assert.equal(hasCapability("member", "trainings.manage"), true);
  assert.equal(hasCapability("member", "trainings.delete"), false);
  assert.equal(hasCapability("admin", "trainings.delete"), true);
  assert.equal(hasCapability("observer", "trainings.view"), true);
  assert.equal(hasCapability("observer", "trainings.manage"), false);
  assert.equal(hasCapability("guest", "trainings.view"), false);
});

test("as três capacidades estão descritas para quem administra o grupo", () => {
  for (const capability of ["trainings.view", "trainings.manage", "trainings.delete"] as const) {
    assert.ok(capabilities.includes(capability), `${capability} fora do catálogo de capacidades`);
    assert.ok(capability in capabilityCatalog, `${capability} sem descrição para o administrador`);
  }
});

test("negar Cadastros fecha também a escrita de treinamentos, porque a tela ainda mora na ficha do colaborador", () => {
  assert.ok(moduleWriteCapabilities.registrations.includes("trainings.manage"));
  assert.ok(moduleWriteCapabilities.registrations.includes("trainings.delete"));
});

test("as rotas exigem a capacidade certa em cada verbo", () => {
  assert.match(criar, /requireNamedCapability\(workspace, "trainings\.view"/u);
  assert.match(criar, /requireNamedCapability\(workspace, "trainings\.manage"/u);
  assert.match(editar, /requireNamedCapability\(workspace, "trainings\.manage".*corrigir/u);
  assert.match(editar, /requireNamedCapability\(workspace, "trainings\.delete"/u);
});

/* -------------------------------------------------------------------------- */
/* A tela                                                                     */
/* -------------------------------------------------------------------------- */

test("a aba de treinamentos aparece na ficha do colaborador", async () => {
  const view = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");
  assert.match(view, /"trainings"/u);
  assert.match(view, /Treinamentos \(NR\)/u);
  assert.match(view, /EmployeeTrainingsPanel employeeId=\{employee\.id\} companyId=\{employee\.companyId\} canManage=\{canManageTrainings\}/u);
});
