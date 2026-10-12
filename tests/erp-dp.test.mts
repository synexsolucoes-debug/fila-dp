import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HIGH_DATE, type HistoryRecord, type HistoryRecordType, type HistoryValues } from "../lib/employee-history.ts";
import {
  competenceOf, expectedEsocialEvents, headcountAt, lastDayOfCompetence, processedCycleStatuses, retroactivityKey,
  summarizeHeadcount, type EmployeeHistoryRecord, type HeadcountEmployee,
} from "../lib/erp-dp.ts";
import { movementEmploymentEffect, movementTypes, sanitizeMovementDetails } from "../lib/operations.ts";

/**
 * Modo ERP DP — o Vinculato lido com a gramática do SAP HCM
 * (docs/engenharia-reversa-sap-hcm.md): quadro em data-base, eSocial
 * esperado, retroatividade, retorno de afastamento como medida, mudança ×
 * correção e a troca de modo no canto superior direito.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const migration = await read("drizzle/postgres/0108_erp_dp_return_to_work.sql");
const apply = await read("app/api/operations/movements/[id]/apply/route.ts");
const service = await read("lib/employee-history-service.ts");
const edit = await read("app/api/employees/[id]/route.ts");
const app = await read("app/painel/WorkspaceApp.tsx");
const view = await read("app/painel/features/erp-dp/ErpDpView.tsx");
const drawer = await read("app/painel/features/registrations/RegistrationsView.tsx");
const shellCss = await read("app/dashboard-modern.css");
const accessCss = await read("app/access.css");
const routes = {
  headcount: await read("app/api/erp-dp/headcount/route.ts"),
  esocial: await read("app/api/erp-dp/esocial/route.ts"),
  overview: await read("app/api/erp-dp/overview/route.ts"),
  retro: await read("app/api/erp-dp/retroactivity/route.ts"),
};

const empty: HistoryValues = {
  employmentStatus: null, companyId: null, establishmentId: null, departmentId: null,
  positionId: null, costCenterId: null, workScheduleId: null,
};
let seq = 0;
function record(employeeId: string, type: HistoryRecordType, validFrom: string, validTo: string, values: Partial<HistoryValues>, reason: HistoryRecord["reason"] = "transfer"): EmployeeHistoryRecord {
  return { ...empty, ...values, id: `r${++seq}`, employeeId, recordType: type, validFrom, validTo, reason, movementId: null };
}
function employee(id: string, overrides: Partial<HeadcountEmployee> = {}): HeadcountEmployee {
  return {
    id, fullName: id.toUpperCase(), registrationNumber: id, admissionDate: "2024-01-01", terminationDate: null,
    employmentStatus: "active", companyId: "c1", establishmentId: null, departmentId: "dep-hoje", positionId: null,
    costCenterId: null, workScheduleId: null, ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Quadro em data-base                                                        */
/* -------------------------------------------------------------------------- */

test("o quadro lê o histórico vigente na data, não o cadastro de hoje", () => {
  const records = [
    record("ana", "situation", "2024-01-01", HIGH_DATE, { employmentStatus: "active" }, "baseline"),
    record("ana", "assignment", "2024-01-01", "2025-12-31", { companyId: "c1", departmentId: "dep-antigo" }, "baseline"),
    record("ana", "assignment", "2026-01-01", HIGH_DATE, { companyId: "c1", departmentId: "dep-hoje" }),
  ];
  const [row] = headcountAt([employee("ana")], records, "2025-06-30");
  assert.equal(row.departmentId, "dep-antigo");
  assert.equal(row.source, "history");
});

test("quem não tinha sido admitido não entra; quem foi desligado depois ainda entra", () => {
  const rows = headcountAt([
    employee("futuro", { admissionDate: "2026-09-01" }),
    employee("saiu-depois", { employmentStatus: "terminated", terminationDate: "2026-08-31" }),
    employee("saiu-antes", { employmentStatus: "terminated", terminationDate: "2025-01-31" }),
  ], [], "2026-06-30");
  assert.deepEqual(rows.map((row) => [row.employeeId, row.status]), [["saiu-antes", "terminated"], ["saiu-depois", "active"]]);
  // Sem histórico, a fotografia é aproximação e a tela precisa dizer.
  assert.ok(rows.every((row) => row.source === "current"));
});

test("o resumo conta ativo + afastado como quadro e agrupa por departamento", () => {
  const summary = summarizeHeadcount([
    { ...headcountAt([employee("a")], [], "2026-01-01")[0] },
    { ...headcountAt([employee("b", { employmentStatus: "on_leave" })], [], "2026-01-01")[0] },
    { ...headcountAt([employee("c", { employmentStatus: "terminated" })], [], "2026-01-01")[0] },
  ]);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.byStatus, { active: 1, on_leave: 1, terminated: 1 });
  assert.deepEqual(summary.byDepartment, [{ departmentId: "dep-hoje", active: 1, onLeave: 1 }]);
  assert.equal(summary.approximated, 3);
});

/* -------------------------------------------------------------------------- */
/* eSocial esperado                                                           */
/* -------------------------------------------------------------------------- */

test("cada mudança do mês vira o evento que o sistema de folha precisa transmitir", () => {
  const records = [
    record("ana", "situation", "2024-01-01", "2026-03-09", { employmentStatus: "active" }, "baseline"),
    record("ana", "situation", "2026-03-10", "2026-03-24", { employmentStatus: "on_leave" }, "leave"),
    record("ana", "situation", "2026-03-25", HIGH_DATE, { employmentStatus: "active" }, "return_to_work"),
    record("bia", "situation", "2024-01-01", "2026-03-31", { employmentStatus: "active" }, "baseline"),
    record("bia", "situation", "2026-04-01", HIGH_DATE, { employmentStatus: "terminated" }, "termination"),
    record("caio", "assignment", "2024-01-01", "2026-03-14", { companyId: "c1" }, "baseline"),
    record("caio", "assignment", "2026-03-15", HIGH_DATE, { companyId: "c1", departmentId: "d2" }),
  ];
  const events = expectedEsocialEvents(records, "2026-03");
  assert.deepEqual(events.map((event) => [event.event, event.employeeId, event.date]), [
    ["S-2230", "ana", "2026-03-10"],
    ["S-2206", "caio", "2026-03-15"],
    ["S-2230", "ana", "2026-03-24"],
    // Desligado a partir de 01/04 = último dia 31/03: o S-2299 é de março.
    ["S-2299", "bia", "2026-03-31"],
  ]);
  // A linha de base não é mudança e não gera evento.
  assert.equal(expectedEsocialEvents(records, "2024-01").length, 0);
});

test("o último dia da competência respeita fevereiro bissexto", () => {
  assert.equal(lastDayOfCompetence("2028-02"), "2028-02-29");
  assert.equal(lastDayOfCompetence("2026-02"), "2026-02-28");
  assert.equal(competenceOf("2026-03-15"), "2026-03");
});

/* -------------------------------------------------------------------------- */
/* Retorno de afastamento como medida                                         */
/* -------------------------------------------------------------------------- */

test("retorno de afastamento é medida própria, com efeito inverso ao afastamento", () => {
  assert.ok((movementTypes as readonly string[]).includes("return_to_work"));
  assert.deepEqual(movementEmploymentEffect("return_to_work"), { employmentStatus: "active", requiredCurrentStatus: "on_leave" });
  assert.deepEqual(sanitizeMovementDetails("return_to_work", { returnDate: "2026-03-25", examReference: "ASO 123", lixo: "x" }),
    { returnDate: "2026-03-25", examReference: "ASO 123" });
  assert.match(migration, /'leave', 'return_to_work', 'termination'/u);
  assert.match(migration, /fdp_employee_history_records_reason_check[\s\S]+'return_to_work'/u);
});

test("aplicar o retorno respeita a trava do exame inapto e grava o histórico com o motivo certo", () => {
  assert.match(apply, /movement\.movement_type === "return_to_work"[\s\S]{0,400}blocksReturnToWork/u);
  assert.match(apply, /EMPLOYEE_RETURN_BLOCKED_BY_EXAM/u);
  assert.match(apply, /effect\?\.employmentStatus === "active" \? "return_to_work"/u);
});

/* -------------------------------------------------------------------------- */
/* Retroatividade                                                             */
/* -------------------------------------------------------------------------- */

test("medida com vigência em competência já processada abre pendência idempotente", () => {
  assert.deepEqual([...processedCycleStatuses], ["processing", "post_closing", "closed"]);
  assert.equal(retroactivityKey("m1"), "retro:m1");
  assert.match(apply, /INSERT INTO fdp_operational_pending_items[\s\S]+ON CONFLICT \(workspace_id, idempotency_key\) DO NOTHING/u);
  // No mesmo lote da aplicação: ou aplica e abre, ou nenhum dos dois.
  const insert = apply.indexOf("INSERT INTO fdp_operational_pending_items");
  const batch = apply.indexOf("await d1.batch(statements)");
  assert.ok(insert > 0 && insert < batch);
  assert.match(apply, /retroactive: processedCycle \?/u);
});

/* -------------------------------------------------------------------------- */
/* Mudança × correção                                                         */
/* -------------------------------------------------------------------------- */

test("correção conserta o registro vigente em vez de abrir período", () => {
  assert.match(service, /input\.mode === "correction"[\s\S]{0,200}effectiveDate = covering\.validFrom/u);
  assert.match(edit, /body\.historyMode === "correction"/u);
  assert.match(drawer, /Correção de cadastro \(sem período novo\)/u);
  assert.match(drawer, /if \(employee\) body\.historyMode = historyMode/u);
});

/* -------------------------------------------------------------------------- */
/* Rotas e a troca de modo                                                    */
/* -------------------------------------------------------------------------- */

test("as rotas do ERP DP só leem, e todas aplicam permissão e escopo de empresa", () => {
  for (const [name, source] of Object.entries(routes)) {
    assert.match(source, /requireCapability\(workspace, "(employees|pending_items)\.read"\)/u, name);
    assert.match(source, /companyScopeClause\(/u, name);
    assert.doesNotMatch(source, /export async function (POST|PATCH|PUT|DELETE)/u, name);
  }
});

test("a troca Vinculato ⇄ ERP DP fica no canto superior direito, em todas as telas e no celular", () => {
  // Última porta da faixa de ações do cabeçalho.
  const header = app.slice(app.indexOf('<div className="dashboard-header-actions">'), app.indexOf("</header>", app.indexOf('<div className="dashboard-header-actions">')));
  assert.ok(header.lastIndexOf("erp-mode-toggle") > header.lastIndexOf("new-demand"));
  assert.match(header, /aria-pressed=\{erpMode\}/u);
  assert.match(app, /erpMode \? <ErpDpView /u);
  assert.match(app, /const canUseErp = snapshot \? hasCapability\(snapshot\.workspace\.role, "employees\.read"\)/u);
  // Preferência local protegida: armazenamento indisponível não quebra o painel.
  assert.match(app, /try \{ window\.localStorage\.setItem\(APP_MODE_KEY, next\); \} catch/u);
  assert.match(accessCss, /\.dashboard-header-actions button\.erp-mode-toggle \{ display: inline-flex; \}/u);
  assert.match(shellCss, /\.operational-ui\.erp-mode \.dashboard-sidebar nav \{\s*display: none !important;/u);
});

test("o ERP DP não promete o que o produto decidiu não fazer", () => {
  assert.match(view, /não gera nem envia eventos ao eSocial/u);
  assert.doesNotMatch(view, /calcular folha|gerar folha|transmitir ao eSocial/iu);
});
