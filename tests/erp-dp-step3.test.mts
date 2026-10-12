import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EXPERIENCE_MAX_DAYS, completeYears, contractDeadlines, inclusiveDays, noticeDays, noticeEnd, parseContractTermsInput,
} from "../lib/contract-terms.ts";
import { parseReceiptSheet } from "../lib/esocial-receipts.ts";
import { historyReasons } from "../lib/employee-history.ts";
import { workItemSources } from "../lib/work-items.ts";
import { employeeRecordTabs } from "../lib/panel-routes.ts";

/**
 * ERP DP, passo 3 (docs/engenharia-reversa-sap-hcm.md §16, itens 3, 6 e 7):
 * importadores pelo histórico, elementos contratuais com prazos e
 * conferência do eSocial esperado.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const migration = await read("drizzle/postgres/0109_erp_dp_step3.sql");
const importer = await read("lib/sankhya/importer.ts");
const sheetImport = await read("app/api/employees/import/sankhya/route.ts");
const termsRoute = await read("app/api/employees/[id]/contract-terms/route.ts");
const checksRoute = await read("app/api/erp-dp/esocial/checks/route.ts");
const esocialRoute = await read("app/api/erp-dp/esocial/route.ts");
const view = await read("app/painel/features/erp-dp/ErpDpView.tsx");
const contractPanel = await read("app/painel/features/erp-dp/ErpContractPanel.tsx");
const drawer = await read("app/painel/features/registrations/RegistrationsView.tsx");
const panelPage = await read("app/painel/[[...secao]]/page.tsx");

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

/* -------------------------------------------------------------------------- */
/* Item 3 — importadores pelo histórico                                       */
/* -------------------------------------------------------------------------- */

test("a sincronização do Sankhya grava o histórico no mesmo lote da atualização", () => {
  assert.ok((historyReasons as readonly string[]).includes("integration_sync"));
  assert.match(migration, /'registration_edit', 'integration_sync'/u);
  assert.match(importer, /reason: "integration_sync"/u);
  assert.match(importer, /await d1\.batch\(\[\.\.\.history, d1\.prepare\(`UPDATE fdp_employees SET department_id = \?/u);
  // Só o caminho direto grava; a proposta continua sem tocar no colaborador.
  assert.ok(importer.indexOf("prepareHistoryChange(d1") > importer.indexOf('policy.outcome === "direct"'));
  assert.match(sheetImport, /reason: "integration_sync"/u);
  assert.ok(sheetImport.indexOf("prepareHistoryChange(d1") < sheetImport.indexOf("UPDATE fdp_employees SET registration_number"));
});

/* -------------------------------------------------------------------------- */
/* Item 6 — elementos contratuais                                             */
/* -------------------------------------------------------------------------- */

test("aviso prévio: 30 dias + 3 por ano completo, até 90 (Lei 12.506/2011)", () => {
  assert.equal(completeYears("2020-03-10", "2026-03-09"), 5);
  assert.equal(completeYears("2020-03-10", "2026-03-10"), 6);
  assert.equal(noticeDays("2026-01-01", "2026-06-01"), 30);
  assert.equal(noticeDays("2020-03-10", "2026-03-09"), 45);
  assert.equal(noticeDays("2020-03-10", "2026-03-10"), 48);
  assert.equal(noticeDays("1990-01-01", "2026-01-01"), 90);
  // O dia de início conta como o primeiro.
  assert.equal(noticeEnd("2026-03-01", 30), "2026-03-30");
  assert.equal(inclusiveDays("2026-03-01", "2026-03-30"), 30);
});

test("experiência tem no máximo 90 dias, e o 1º período fica dentro dela", () => {
  assert.equal(EXPERIENCE_MAX_DAYS, 90);
  const ok = parseContractTermsInput({ contractKind: "experience", experienceFirstEnd: "2026-02-14", contractEnd: "2026-03-31" }, "2026-01-01");
  assert.equal(ok.contractEnd, "2026-03-31");
  assert.throws(() => parseContractTermsInput({ contractKind: "experience", contractEnd: "2026-04-01" }, "2026-01-01"), code("EXPERIENCE_TOO_LONG"));
  assert.throws(() => parseContractTermsInput({ contractKind: "experience", experienceFirstEnd: "2026-03-31", contractEnd: "2026-03-31" }, "2026-01-01"),
    code("EXPERIENCE_FIRST_END_INVALID"));
  assert.throws(() => parseContractTermsInput({ contractKind: "experience" }, "2026-01-01"), code("CONTRACT_END_REQUIRED"));
});

test("prazo determinado tem no máximo 2 anos; indeterminado não guarda fim", () => {
  assert.doesNotThrow(() => parseContractTermsInput({ contractKind: "fixed_term", contractEnd: "2027-12-31" }, "2026-01-01"));
  assert.throws(() => parseContractTermsInput({ contractKind: "fixed_term", contractEnd: "2028-01-01" }, "2026-01-01"), code("FIXED_TERM_TOO_LONG"));
  const indefinite = parseContractTermsInput({ contractKind: "indefinite", contractEnd: "2027-01-01", experienceFirstEnd: "2026-02-01" }, "2026-01-01");
  assert.equal(indefinite.contractEnd, null);
  assert.equal(indefinite.experienceFirstEnd, null);
});

test("dias e fim do aviso vêm do servidor, nunca da requisição", () => {
  const terms = parseContractTermsInput({ noticeKind: "worked", noticeStart: "2026-03-10", noticeDays: 5, noticeEnd: "2026-03-11" }, "2020-03-10");
  assert.equal(terms.noticeDays, 48);
  assert.equal(terms.noticeEnd, "2026-04-26");
  assert.throws(() => parseContractTermsInput({ noticeKind: "worked" }, "2020-03-10"), code("NOTICE_START_REQUIRED"));
  assert.throws(() => parseContractTermsInput({ noticeKind: "x", noticeStart: "2026-03-10" }, "2020-03-10"), code("NOTICE_KIND_INVALID"));
});

test("os prazos saem em ordem, com a decisão que cada um pede", () => {
  const deadlines = contractDeadlines({ contractKind: "experience", experienceFirstEnd: "2026-02-14", contractEnd: "2026-03-31", noticeEnd: null });
  assert.deepEqual(deadlines.map((item) => [item.kind, item.date]), [["experience_first_end", "2026-02-14"], ["contract_end", "2026-03-31"]]);
  assert.match(deadlines[1].action, /efetivar ou encerrar/u);
});

test("a tabela nasce isolada por tenant e com as guardas da lei", () => {
  for (const table of ["fdp_employee_contract_terms", "fdp_esocial_event_checks"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"));
    assert.match(migration, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`, "u"));
  }
  assert.match(migration, /"notice_days" BETWEEN 30 AND 90/u);
  assert.match(migration, /\("contract_kind" = 'indefinite'\) = \("contract_end" IS NULL\)/u);
  assert.match(migration, /fdp_employee_contract_terms_employee_uq/u);
  // Só datas: nenhum valor de verba.
  assert.doesNotMatch(migration, /"(amount|value|salary)/u);
});

test("os prazos contratuais são do ERP: ficam fora da Central de Trabalho do Vinculato", () => {
  const keys = workItemSources.map((source) => source.key as string);
  assert.ok(!keys.includes("contract_term_due") && !keys.includes("notice_period_due"));
  assert.deepEqual([...employeeRecordTabs], ["exams", "trainings"]);
  assert.match(view, /function ContractsSection\(/u);
  assert.match(view, /onOpen=\{\(employeeId\) => openRecord\(employeeId, "contract"\)\}/u);
  // O servidor descartava `aba` e todo link do Motor de Prazos abria a ficha na primeira aba.
  assert.match(panelPage, /if \(aba\) consulta\.set\("aba", aba\);/u);
});

test("a rota do contrato exige permissão de escrita e audita", () => {
  assert.match(termsRoute, /requireCapability\(workspace, "employees\.read"\)/u);
  assert.match(termsRoute, /requireCapability\(workspace, "employees\.manage"\)/u);
  assert.match(termsRoute, /action: "employee\.contract_terms\.updated"/u);
  // A aba Contrato mora na Ficha funcional do ERP, não na ficha do Vinculato.
  assert.match(view, /<ErpContractPanel employeeId=\{text\(selected\.id\)\} canManage=\{canManage\} \/>/u);
  assert.doesNotMatch(drawer, /ContractPanel|"Contrato"/u);
  // Os editores das abas não podem morar dentro do formulário da ficha: o
  // navegador enviava o de fora, recarregava a página e nada era gravado.
  const formStart = drawer.indexOf("<form id={employeeFormId} onSubmit={submit}>");
  const formEnd = drawer.indexOf("</form>", formStart);
  assert.ok(formStart > 0 && formEnd > formStart);
  const inside = drawer.slice(formStart, formEnd);
  for (const panel of ["EmployeeTrainingsPanel", "EmployeeExamsPanel"]) {
    assert.doesNotMatch(inside, new RegExp(`<${panel}`, "u"), `${panel} dentro do formulário da ficha`);
  }
  assert.match(drawer, /type="submit" form=\{employeeFormId\}/u);
  // A tela não puxa código de servidor.
  assert.match(contractPanel, /from "@\/lib\/contract-terms-rules"/u);
});

/* -------------------------------------------------------------------------- */
/* Item 7 — conferência do eSocial                                            */
/* -------------------------------------------------------------------------- */

test("a planilha de recibos aceita os formatos que os sistemas de folha exportam", () => {
  const lines = parseReceiptSheet("﻿matricula;evento;data;recibo\n001;S-2230;10/08/2026;1.2.0000000001\n002,s2299,2026-08-31,1.2.0000000002\n003;S-2206;2026-08-15;\n");
  assert.deepEqual(lines, [
    { registration: "001", event: "S-2230", date: "2026-08-10", receipt: "1.2.0000000001" },
    { registration: "002", event: "S-2299", date: "2026-08-31", receipt: "1.2.0000000002" },
  ]);
});

test("conferir exige prova: recibo para transmitido, motivo para não se aplica", () => {
  assert.match(migration, /"status" <> 'transmitted' OR length\(trim\("receipt"\)\) > 0/u);
  assert.match(migration, /"status" <> 'not_applicable' OR length\(trim\("notes"\)\) > 0/u);
  assert.match(checksRoute, /ESOCIAL_RECEIPT_REQUIRED/u);
  assert.match(checksRoute, /ESOCIAL_REASON_REQUIRED/u);
});

test("só se confere evento que o histórico exige, com escopo de empresa e auditoria", () => {
  assert.match(checksRoute, /requireCapability\(workspace, "obligations\.manage"\)/u);
  assert.match(checksRoute, /requireCompanyAccess\(/u);
  assert.match(checksRoute, /ESOCIAL_EVENT_NOT_EXPECTED/u);
  assert.match(checksRoute, /ON CONFLICT \(workspace_id, history_record_id, event_code, event_date\) DO UPDATE/u);
  assert.match(checksRoute, /action: "esocial\.events\.checked"/u);
  assert.match(checksRoute, /action: "esocial\.event\.unchecked"/u);
  assert.match(esocialRoute, /summary/u);
  assert.match(view, /Importar recibos \(CSV\)/u);
  assert.match(view, /from "@\/lib\/esocial-receipts"/u);
});
