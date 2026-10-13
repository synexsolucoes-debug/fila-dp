import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HIGH_DATE, divergencesAt, planHistoryChange, previousDay, snapshotAt, terminatedFrom, timelineGaps,
  type HistoryPlan, type HistoryRecord, type HistoryRecordType, type HistoryValues,
} from "../lib/employee-history.ts";

/**
 * Histórico funcional (§4.27) — a ficha do colaborador com data de validade,
 * no desenho dos infotipos do SAP HCM (docs/engenharia-reversa-sap-hcm.md).
 *
 * O que estes testes protegem é a restrição temporal 1: em qualquer dia, um
 * e só um registro vigente por tipo, sem buraco e sem sobreposição — e uma
 * mudança nunca apaga o que veio antes.
 */

const migration = await readFile(new URL("../drizzle/postgres/0107_employee_functional_history.sql", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const service = await readFile(new URL("../lib/employee-history-service.ts", import.meta.url), "utf8");
const apply = await readFile(new URL("../app/api/operations/movements/[id]/apply/route.ts", import.meta.url), "utf8");
const terminate = await readFile(new URL("../app/api/employees/[id]/terminate/route.ts", import.meta.url), "utf8");
const edit = await readFile(new URL("../app/api/employees/[id]/route.ts", import.meta.url), "utf8");
const read = await readFile(new URL("../app/api/employees/[id]/functional-history/route.ts", import.meta.url), "utf8");
const erpView = await readFile(new URL("../app/painel/features/erp-dp/ErpDpView.tsx", import.meta.url), "utf8");
const drawer = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");

const empty: HistoryValues = {
  employmentStatus: null, companyId: null, establishmentId: null, departmentId: null,
  positionId: null, costCenterId: null, workScheduleId: null,
};
const current: HistoryValues = {
  employmentStatus: "active", companyId: "emp-1", establishmentId: "un-1", departmentId: "dep-a",
  positionId: "cargo-1", costCenterId: "cc-1", workScheduleId: "jornada-44h",
};

let seq = 0;
function record(type: HistoryRecordType, validFrom: string, validTo: string, values: Partial<HistoryValues>): HistoryRecord {
  return { ...empty, ...values, id: `r${++seq}`, recordType: type, validFrom, validTo, reason: "transfer", movementId: null };
}

/** Executa o plano em memória, como o lote faria no banco. */
function applyPlan(records: HistoryRecord[], type: HistoryRecordType, plan: HistoryPlan): HistoryRecord[] {
  if (plan.kind === "noop") return records;
  let next = records.map((item) => ({ ...item }));
  if (plan.baseline) next.push(record(type, plan.baseline.validFrom, plan.baseline.validTo, plan.baseline.values));
  if (plan.replace) next = next.map((item) => item.id === plan.replace!.id ? { ...item, ...plan.replace!.values } : item);
  if (plan.delimit) next = next.map((item) => item.id === plan.delimit!.id ? { ...item, validTo: plan.delimit!.validTo } : item);
  if (plan.insert) next.push(record(type, plan.insert.validFrom, plan.insert.validTo, plan.insert.values));
  return next;
}

/* -------------------------------------------------------------------------- */
/* Delimitação — o coração do desenho                                         */
/* -------------------------------------------------------------------------- */

test("a primeira mudança fotografa o cadastro de antes e abre o registro novo", () => {
  const plan = planHistoryChange({
    records: [], type: "assignment", effectiveDate: "2026-03-01",
    changes: { departmentId: "dep-b" }, current, admissionDate: "2024-02-10",
  });
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.deepEqual(plan.baseline, {
    validFrom: "2024-02-10", validTo: "2026-02-28",
    values: { ...empty, companyId: "emp-1", establishmentId: "un-1", departmentId: "dep-a", positionId: "cargo-1", costCenterId: "cc-1" },
  });
  // Transferência parcial herda o resto da lotação.
  assert.equal(plan.insert?.values.departmentId, "dep-b");
  assert.equal(plan.insert?.values.positionId, "cargo-1");
  assert.equal(plan.insert?.validTo, HIGH_DATE);
  // A situação e a jornada não vazam para o registro de lotação.
  assert.equal(plan.insert?.values.employmentStatus, null);
  assert.equal(plan.insert?.values.workScheduleId, null);
});

test("mudança na própria admissão não inventa um 'antes'", () => {
  const plan = planHistoryChange({
    records: [], type: "schedule", effectiveDate: "2024-02-10",
    changes: { workScheduleId: "jornada-36h" }, current, admissionDate: "2024-02-10",
  });
  assert.equal(plan.kind === "write" && plan.baseline, null);
});

test("um registro novo delimita o vigente na véspera — nada é apagado", () => {
  const records = [
    record("assignment", "2024-02-10", "2025-12-31", { companyId: "emp-1", departmentId: "dep-a" }),
    record("assignment", "2026-01-01", HIGH_DATE, { companyId: "emp-1", departmentId: "dep-b" }),
  ];
  const plan = planHistoryChange({
    records, type: "assignment", effectiveDate: "2026-06-15",
    changes: { departmentId: "dep-c" }, current, admissionDate: "2024-02-10",
  });
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.deepEqual(plan.delimit, { id: records[1].id, validTo: "2026-06-14", expectedValidTo: HIGH_DATE });
  const after = applyPlan(records, "assignment", plan);
  assert.equal(after.length, 3);
  assert.deepEqual(timelineGaps(after), []);
  assert.equal(snapshotAt(after, "2025-05-01").assignment?.departmentId, "dep-a");
  assert.equal(snapshotAt(after, "2026-03-01").assignment?.departmentId, "dep-b");
  assert.equal(snapshotAt(after, "2026-06-15").assignment?.departmentId, "dep-c");
});

test("mudança retroativa ocupa só o intervalo do registro que delimitou", () => {
  const records = [
    record("assignment", "2024-02-10", "2025-12-31", { companyId: "emp-1", departmentId: "dep-a" }),
    record("assignment", "2026-01-01", HIGH_DATE, { companyId: "emp-1", departmentId: "dep-b" }),
  ];
  const plan = planHistoryChange({
    records, type: "assignment", effectiveDate: "2025-07-01",
    changes: { positionId: "cargo-2" }, current, admissionDate: "2024-02-10",
  });
  const after = applyPlan(records, "assignment", plan);
  assert.deepEqual(timelineGaps(after), []);
  // O registro retroativo termina onde o delimitado terminava, e a mudança
  // de 2026 continua de pé.
  const inserted = after.find((item) => item.validFrom === "2025-07-01");
  assert.equal(inserted?.validTo, "2025-12-31");
  assert.equal(snapshotAt(after, "2026-02-01").assignment?.departmentId, "dep-b");
});

test("mesma data de início substitui os valores, como dois BEGDA iguais no SAP", () => {
  const records = [record("situation", "2026-03-01", HIGH_DATE, { employmentStatus: "on_leave" })];
  const plan = planHistoryChange({
    records, type: "situation", effectiveDate: "2026-03-01",
    changes: { employmentStatus: "terminated" }, current, admissionDate: "2024-02-10",
  });
  assert.equal(plan.kind === "write" && plan.replace?.id, records[0].id);
  assert.equal(plan.kind === "write" && plan.insert, null);
});

test("mudança que não muda nada não grava nada", () => {
  const records = [record("schedule", "2024-02-10", HIGH_DATE, { workScheduleId: "jornada-44h" })];
  assert.equal(planHistoryChange({
    records, type: "schedule", effectiveDate: "2026-01-01",
    changes: { workScheduleId: "jornada-44h" }, current, admissionDate: "2024-02-10",
  }).kind, "noop");
  assert.equal(planHistoryChange({
    records: [], type: "assignment", effectiveDate: "2026-01-01", changes: {}, current, admissionDate: "2024-02-10",
  }).kind, "noop");
});

test("data anterior ao início do histórico é recusada com motivo, não gravada", () => {
  const records = [record("situation", "2025-01-01", HIGH_DATE, { employmentStatus: "active" })];
  assert.throws(() => planHistoryChange({
    records, type: "situation", effectiveDate: "2024-06-01",
    changes: { employmentStatus: "on_leave" }, current, admissionDate: "2024-02-10",
  }), (error: unknown) => (error as { code?: string }).code === "HISTORY_BEFORE_START");
});

test("desligado começa no dia seguinte ao último dia do vínculo", () => {
  assert.equal(terminatedFrom("2026-02-28"), "2026-03-01");
  assert.equal(terminatedFrom("2024-12-31"), "2025-01-01");
  assert.equal(previousDay("2024-03-01"), "2024-02-29");
});

test("a verificação de linha do tempo acusa buraco e sobreposição", () => {
  assert.deepEqual(timelineGaps([
    record("situation", "2024-01-01", "2024-05-31", { employmentStatus: "active" }),
    record("situation", "2024-06-10", HIGH_DATE, { employmentStatus: "on_leave" }),
  ]).length, 1);
  assert.deepEqual(timelineGaps([record("situation", "2024-01-01", "2024-05-31", { employmentStatus: "active" })]).length, 1);
});

test("divergência compara o cadastro de hoje com o registro vigente hoje", () => {
  const records = [
    record("assignment", "2024-02-10", "2026-12-31", { companyId: "emp-1", departmentId: "dep-a" }),
    record("assignment", "2027-01-01", HIGH_DATE, { companyId: "emp-1", departmentId: "dep-b" }),
  ];
  // Transferência aplicada com data futura: o cadastro já diz dep-b.
  const divergences = divergencesAt(records, { ...current, departmentId: "dep-b", establishmentId: null, positionId: null, costCenterId: null }, "2026-10-12");
  assert.deepEqual(divergences.map((item) => item.field), ["departmentId"]);
});

/* -------------------------------------------------------------------------- */
/* Banco, RLS e costura com as rotas                                          */
/* -------------------------------------------------------------------------- */

test("a tabela nasce com isolamento por tenant e as guardas de cada tipo", () => {
  assert.match(migration, /CREATE TABLE "fdp_employee_history_records"/u);
  assert.match(migration, /ALTER TABLE "fdp_employee_history_records" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /CREATE POLICY "fdp_employee_history_records_workspace_isolation"/u);
  assert.match(migration, /"valid_to" date DEFAULT '9999-12-31' NOT NULL/u);
  assert.match(migration, /CHECK \("valid_to" >= "valid_from"\)/u);
  assert.match(migration, /fdp_employee_history_records_employee_type_start_uq/u);
  // Pelo id do colaborador: o histórico sobrevive à troca de empresa.
  assert.match(migration, /FOREIGN KEY \("workspace_id", "employee_id"\) REFERENCES "public"\."fdp_employees"\("workspace_id", "id"\)/u);
  assert.match(schema, /export const employeeHistoryRecords = pgTable\("fdp_employee_history_records"/u);
});

test("salário não mora no histórico funcional: tem tabela própria com vigência (0111)", () => {
  assert.doesNotMatch(migration, /"salary|"wage|"amount/u);
});

test("as três rotas que mudam o vínculo gravam histórico no mesmo lote", () => {
  for (const source of [apply, terminate, edit]) {
    assert.match(source, /prepareHistoryChange\(d1,/u);
  }
  assert.match(apply, /statements\.push\(\.\.\.await prepareHistoryChange/u);
  assert.match(terminate, /\.\.\.history,\s*d1\.prepare\("UPDATE fdp_employees/u);
  assert.match(edit, /\.\.\.history,\s*d1\.prepare\(`UPDATE fdp_employees/u);
  // O serviço só prepara: quem grava é o lote de quem chamou.
  assert.doesNotMatch(service, /\.run\(\)|\.batch\(/u);
});

test("concorrência: o registro novo só nasce se a delimitação aconteceu", () => {
  assert.match(service, /WHERE workspace_id = \? AND id = \? AND valid_to = \?::date`\)/u);
  assert.match(service, /WHERE EXISTS \(SELECT 1 FROM fdp_employee_history_records WHERE workspace_id = \? AND id = \? AND valid_to = \?::date\)/u);
});

test("a leitura exige acesso à empresa, e a Vida funcional mora no ERP DP, não na ficha do Vinculato", () => {
  assert.match(read, /requireCapability\(workspace, "employees\.read"\)/u);
  assert.match(read, /requireCompanyAccess\(/u);
  assert.doesNotMatch(read, /export async function (POST|PATCH|DELETE)/u);
  // O que é ERP fica no ERP (§4.30).
  assert.match(erpView, /<ErpFunctionalHistoryPanel key=\{version\} employeeId=/u);
  assert.doesNotMatch(drawer, /Vida funcional|FunctionalHistoryPanel/u);
});
