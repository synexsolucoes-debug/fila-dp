import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  addDays, businessDaysBetween, lastDayOfMonth, monthDay, nextCompetence, previousBusinessDay, previousCompetence, weekStart,
  type BusinessCalendar,
} from "../lib/dp-calendar.ts";
import { calendarMatrix, occurrenceWindow, periodsToEnsure, planOccurrences, validateTemplateInput, weekMovementsText, type RecurringCompany, type RecurringTemplate } from "../lib/dp-recurring.ts";
import { areaReport, evaluateCutoff, normalizeProcessType, ruleFor, type CutoffRule } from "../lib/dp-cutoff.ts";
import { addYears, computeAlerts, experienceMilestones, summarizeAlerts, vacationDeadline, type AlertEmployee } from "../lib/dp-alerts.ts";
import { buildWorkItemQuery, workItemHref, workItemSources } from "../lib/work-items.ts";

/**
 * DP Operacional, Fases 2 a 5: rotinas recorrentes, regra de corte, alertas e
 * relatório. A especificação pede teste para a geração de tarefas com dia não
 * útil e mês de 28/30 dias, e para o cálculo de `dentroDoCorte` — estão aqui
 * com as datas reais de 2026.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
// Feriados de 2026 usados nos casos: Carnaval (16 e 17/02), Tiradentes (21/04).
const calendar: BusinessCalendar = { businessDays: [1, 2, 3, 4, 5], holidays: new Set(["2026-02-16", "2026-02-17", "2026-04-21"]) };

const company = (id: string, code: string, taxId: string, dpStatus = "interno"): RecurringCompany => {
  const digits = taxId.replace(/\D/gu, "");
  return { id, name: `Empresa ${code}`, code, dpStatus, status: "active", cnpjRoot: digits.slice(0, 8), isHeadquarters: digits.slice(8, 12) === "0001" };
};
const companies = [
  company("c10", "10", "10.299.958/0001-89"),
  company("c33", "33", "43.944.672/0003-20"),
  company("c40", "40", "43.944.672/0001-68", "sem_funcionarios"),
  company("c30", "30", "26.016.500/0001-05"),
  company("c46", "46", "17.104.489/0001-44", "a_internalizar"),
];
const template = (overrides: Partial<RecurringTemplate>): RecurringTemplate => ({
  id: "t", code: "t", name: "Rotina", description: "", frequency: "monthly", dayStart: 1, dayEnd: 15, weekday: null,
  scope: "company", companyIds: null, processType: "ROTINA DP", listWeekMovements: false, active: true, ...overrides,
});

/* ------------------------------------------------------------------ */
/* Calendário                                                          */
/* ------------------------------------------------------------------ */

test("dia útil: fim de semana e feriado antecipam para o dia útil anterior", () => {
  assert.equal(previousBusinessDay("2026-11-15", calendar), "2026-11-13"); // domingo → sexta
  assert.equal(previousBusinessDay("2026-02-17", calendar), "2026-02-13"); // terça de Carnaval → sexta anterior
  assert.equal(previousBusinessDay("2026-10-21", calendar), "2026-10-21"); // quarta útil fica
});

test("mês de 28, 29, 30 e 31 dias: dia 31 vira o último dia", () => {
  assert.equal(lastDayOfMonth("2026-02"), 28);
  assert.equal(lastDayOfMonth("2028-02"), 29);
  assert.equal(monthDay("2026-02", 31), "2026-02-28");
  assert.equal(monthDay("2026-02", 30), "2026-02-28");
  assert.equal(monthDay("2026-04", 31), "2026-04-30");
  assert.equal(monthDay("2026-10", 31), "2026-10-31");
  assert.equal(nextCompetence("2026-12"), "2027-01");
  assert.equal(previousCompetence("2026-01"), "2025-12");
});

test("dias úteis entre duas datas e semana", () => {
  assert.equal(businessDaysBetween("2026-10-19", "2026-10-20", calendar), 1); // seg → ter
  assert.equal(businessDaysBetween("2026-10-16", "2026-10-19", calendar), 1); // sex → seg
  assert.equal(businessDaysBetween("2026-02-13", "2026-02-19", calendar), 2); // atravessa o Carnaval
  assert.equal(businessDaysBetween("2026-10-20", "2026-10-19", calendar), -1);
  assert.equal(weekStart("2026-10-21"), "2026-10-19");
  assert.equal(weekStart("2026-10-25"), "2026-10-19"); // domingo pertence à semana de segunda
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

/* ------------------------------------------------------------------ */
/* Fase 2 — rotinas recorrentes                                        */
/* ------------------------------------------------------------------ */

test("prazo da rotina: dia final da janela, antecipado quando não é útil", () => {
  // Fechamento de ponto 26–28: 28/02/2026 é sábado → 27/02 (sexta).
  assert.deepEqual(occurrenceWindow(template({ dayStart: 26, dayEnd: 28 }), { frequency: "monthly", competence: "2026-02" }, calendar),
    { startDate: "2026-02-26", dueDate: "2026-02-27", competence: "2026-02" });
  // Caju no dia 30: fevereiro não tem 30 → 28 (sábado) → 27.
  assert.equal(occurrenceWindow(template({ dayStart: 30, dayEnd: 30 }), { frequency: "monthly", competence: "2026-02" }, calendar).dueDate, "2026-02-27");
  // Eventos à parte 26–30 em novembro: 30/11/2026 é segunda — fica.
  assert.equal(occurrenceWindow(template({ dayStart: 26, dayEnd: 30 }), { frequency: "monthly", competence: "2026-11" }, calendar).dueDate, "2026-11-30");
  // Abril, 30 dias, com o 31 pedido.
  assert.equal(occurrenceWindow(template({ dayStart: 26, dayEnd: 31 }), { frequency: "monthly", competence: "2026-04" }, calendar).dueDate, "2026-04-30");
  // Janela de um dia só no domingo 15/11: prazo e abertura antecipam juntos para sexta.
  assert.deepEqual(occurrenceWindow(template({ dayStart: 15, dayEnd: 15 }), { frequency: "monthly", competence: "2026-11" }, calendar),
    { startDate: "2026-11-13", dueDate: "2026-11-13", competence: "2026-11" });
});

test("escopo por empresa: só as internas, ou a lista do modelo", () => {
  const all = planOccurrences({ template: template({}), period: { frequency: "monthly", competence: "2026-11" }, companies, calendar });
  assert.deepEqual(all.map((item) => item.companyId).sort(), ["c10", "c30", "c33"]);
  assert.ok(all.every((item) => item.periodKey === "2026-11" && item.competence === "2026-11"));
  const caju = planOccurrences({ template: template({ companyIds: ["c30", "c33"] }), period: { frequency: "monthly", competence: "2026-11" }, companies, calendar });
  assert.deepEqual(caju.map((item) => item.scopeKey).sort(), ["c30", "c33"]);
});

test("escopo por raiz de CNPJ: Goiânia e Goianésia são uma tarefa só, da carteira da matriz", () => {
  const plan = planOccurrences({ template: template({ scope: "cnpj_root" }), period: { frequency: "monthly", competence: "2026-11" }, companies, calendar });
  const root = plan.find((item) => item.scopeKey === "raiz:43944672");
  assert.ok(root);
  // A 40 é a matriz (0001) mesmo sem funcionários: é a carteira dela que responde.
  assert.equal(root.companyId, "c40");
  assert.deepEqual(root.companyIds, ["c33"]);
  assert.equal(plan.length, 3); // raízes 10299958, 43944672 e 26016500
});

test("escopo do grupo: uma demanda, sem empresa", () => {
  const plan = planOccurrences({ template: template({ scope: "tenant" }), period: { frequency: "monthly", competence: "2026-11" }, companies, calendar });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].scopeKey, "grupo");
  assert.equal(plan[0].companyId, null);
});

test("rotina semanal (Wellhub, sexta): uma por empresa por semana, sexta feriado antecipa", () => {
  const wellhub = template({ frequency: "weekly", weekday: 5, dayStart: 1, dayEnd: 1, listWeekMovements: true });
  const plan = planOccurrences({ template: wellhub, period: { frequency: "weekly", monday: "2026-10-19" }, companies, calendar });
  assert.equal(plan.length, 3);
  assert.ok(plan.every((item) => item.periodKey === "2026-10-19" && item.dueDate === "2026-10-23"));
  const holiday: BusinessCalendar = { ...calendar, holidays: new Set(["2026-10-23"]) };
  assert.equal(planOccurrences({ template: wellhub, period: { frequency: "weekly", monday: "2026-10-19" }, companies, calendar: holiday })[0].dueDate, "2026-10-22");
  // A rotina mensal não responde a período semanal, e vice-versa.
  assert.equal(planOccurrences({ template: wellhub, period: { frequency: "monthly", competence: "2026-10" }, companies, calendar }).length, 0);
  assert.equal(planOccurrences({ template: template({ active: false }), period: { frequency: "monthly", competence: "2026-10" }, companies, calendar }).length, 0);
  assert.match(weekMovementsText({ admissions: [{ name: "Ana", date: "2026-10-20" }], terminations: [] }), /Inclusões[\s\S]*Ana \(20\/10\/2026\)[\s\S]*Exclusões[^:]*: nenhuma/u);
});

test("o job garante a competência atual, a seguinte a partir do dia 25 e a semana", () => {
  assert.deepEqual(periodsToEnsure("2026-10-21"), [{ frequency: "monthly", competence: "2026-10" }, { frequency: "weekly", monday: "2026-10-19" }]);
  assert.deepEqual(periodsToEnsure("2026-12-25"), [
    { frequency: "monthly", competence: "2026-12" }, { frequency: "monthly", competence: "2027-01" }, { frequency: "weekly", monday: "2026-12-21" },
  ]);
});

test("calendário do mês conta as frentes por dia e marca o pico", () => {
  const templates = [
    template({ id: "a", dayStart: 1, dayEnd: 15 }), template({ id: "b", dayStart: 1, dayEnd: 15 }), template({ id: "c", dayStart: 1, dayEnd: 19 }),
    template({ id: "d", dayStart: 10, dayEnd: 12 }), template({ id: "e", dayStart: 12, dayEnd: 12 }),
    template({ id: "w", frequency: "weekly", weekday: 5 }),
  ];
  const matrix = calendarMatrix(templates, "2026-11", calendar);
  assert.equal(matrix.days.length, 30);
  assert.equal(matrix.load.find((item) => item.day === "2026-11-12")?.count, 5);
  assert.equal(matrix.load.find((item) => item.day === "2026-11-20")?.count, 1); // só a semanal de sexta
  assert.deepEqual(matrix.rows.find((row) => row.templateId === "w")?.days, ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);
});

test("validação do modelo recorrente", () => {
  assert.equal(validateTemplateInput({ code: "caju", name: "Caju", frequency: "monthly", scope: "company", dayStart: 30, dayEnd: 30 }), null);
  assert.match(String(validateTemplateInput({ code: "x y", name: "X", frequency: "monthly", scope: "company", dayStart: 1, dayEnd: 2 })), /Código/u);
  assert.match(String(validateTemplateInput({ code: "xx", name: "X", frequency: "monthly", scope: "company", dayStart: 20, dayEnd: 10 })), /Janela/u);
  assert.match(String(validateTemplateInput({ code: "xy", name: "X", frequency: "weekly", scope: "company", weekday: null })), /dia da semana/u);
});

/* ------------------------------------------------------------------ */
/* Fase 3 — regra de corte                                             */
/* ------------------------------------------------------------------ */

const rule = (overrides: Partial<CutoffRule>): CutoffRule => ({
  code: "r", name: "Regra", processTypes: [], kind: "dia_do_mes", value: 26, monthDayLimit: null, description: "", status: "aprovada", ...overrides,
});
const admission = rule({ code: "admissao", name: "Admissão", processTypes: ["CONCILIAÇÃO CADASTRAL", "ADMISSÃO"], kind: "antecedencia_dias_uteis", value: 3, monthDayLimit: 26 });

test("aceite: admissão criada 1 dia útil antes do início está fora do corte", () => {
  const verdict = evaluateCutoff(admission, { createdOn: "2026-10-19", requestedFor: "2026-10-20", competence: null }, calendar);
  assert.equal(verdict.within, false);
  assert.equal(verdict.daysLate, 2);
  assert.equal(verdict.deadline, "2026-10-15"); // 3 dias úteis antes de terça 20/10
  assert.equal(evaluateCutoff(admission, { createdOn: "2026-10-14", requestedFor: "2026-10-19", competence: null }, calendar).within, true);
  // Exatamente 3 dias úteis vale.
  assert.equal(evaluateCutoff(admission, { createdOn: "2026-10-14", requestedFor: "2026-10-19", competence: null }, calendar).daysLate, 0);
  // Janela do mês: pedida no dia 27 para começar no mesmo mês, mesmo com antecedência.
  assert.equal(evaluateCutoff(admission, { createdOn: "2026-07-27", requestedFor: "2026-07-31", competence: null }, calendar).within, false);
  // Sem a data de início, não dá para conferir — e não vira atraso.
  assert.equal(evaluateCutoff(admission, { createdOn: "2026-10-19", requestedFor: null, competence: null }, calendar).within, null);
});

test("as outras regras do seed: rescisão, férias, ponto, variáveis e atestado", () => {
  const rescisao = rule({ kind: "mesmo_dia", value: 0 });
  assert.equal(evaluateCutoff(rescisao, { createdOn: "2026-10-20", requestedFor: "2026-10-20", competence: null }, calendar).within, true);
  assert.equal(evaluateCutoff(rescisao, { createdOn: "2026-10-22", requestedFor: "2026-10-20", competence: null }, calendar).daysLate, 2);
  const ferias = rule({ kind: "antecedencia_dias_corridos", value: 40 });
  assert.equal(evaluateCutoff(ferias, { createdOn: "2026-10-01", requestedFor: "2026-11-10", competence: null }, calendar).within, true);
  assert.equal(evaluateCutoff(ferias, { createdOn: "2026-10-02", requestedFor: "2026-11-10", competence: null }, calendar).within, false);
  const ponto = rule({ kind: "dia_do_mes", value: 25 });
  assert.equal(evaluateCutoff(ponto, { createdOn: "2026-10-25", requestedFor: null, competence: "2026-10" }, calendar).within, true);
  assert.equal(evaluateCutoff(ponto, { createdOn: "2026-10-27", requestedFor: null, competence: "2026-10" }, calendar).daysLate, 2);
  const variaveis = rule({ kind: "dia_do_mes", value: 26 });
  assert.equal(evaluateCutoff(variaveis, { createdOn: "2026-02-27", requestedFor: null, competence: "2026-02" }, calendar).within, false);
  const atestado = rule({ kind: "ate_dias_apos", value: 2 });
  assert.equal(evaluateCutoff(atestado, { createdOn: "2026-10-22", requestedFor: "2026-10-20", competence: null }, calendar).within, true);
  assert.equal(evaluateCutoff(atestado, { createdOn: "2026-10-23", requestedFor: "2026-10-20", competence: null }, calendar).within, false);
});

test("a regra vale pelo tipo de processo, sem acento nem caixa, e só aprovada ou divulgada", () => {
  assert.equal(normalizeProcessType("Férias "), "FERIAS");
  assert.equal(ruleFor([admission], "conciliação cadastral")?.code, "admissao");
  assert.equal(ruleFor([admission], "ADMISSAO")?.code, "admissao");
  assert.equal(ruleFor([{ ...admission, status: "proposta" }], "ADMISSÃO"), null);
  assert.equal(ruleFor([admission], "FÉRIAS"), null);
});

test("relatório por área: total, em aberto, fora do corte e %", () => {
  const report = areaReport([
    { area: "Comercial", open: true, within: false }, { area: "Comercial", open: false, within: true },
    { area: "Comercial", open: false, within: false }, { area: "Operações", open: true, within: true }, { area: "", open: false, within: null },
  ]);
  assert.deepEqual(report[0], { area: "Comercial", total: 3, open: 1, outside: 2, outsidePercent: 66.7 });
  assert.deepEqual(report.map((row) => row.area), ["Comercial", "Operações", "Sem área"]);
});

/* ------------------------------------------------------------------ */
/* Fase 4 — alertas                                                    */
/* ------------------------------------------------------------------ */

const employee = (overrides: Partial<AlertEmployee>): AlertEmployee => ({
  id: "e1", name: "Ana", companyId: "c33", admissionDate: "2026-09-01", employmentStatus: "active", employmentType: "clt",
  cpfLast4: "1234", sankhyaCode: "17", vacationsTaken: 0, managerEmail: "gestor@empresa.com", ...overrides,
});
const alertCompanies = [{ id: "c33", name: "Goiânia", taxId: "43.944.672/0003-20", code: "33", dpStatus: "interno", status: "active" }];

test("experiência: 45 e 90 dias contando a admissão, alerta com 10 dias", () => {
  assert.deepEqual(experienceMilestones("2026-09-01"), { first: "2026-10-15", second: "2026-11-29" });
  const at = (today: string) => computeAlerts({ employees: [employee({})], companies: alertCompanies, today }).filter((alert) => alert.type.startsWith("experience_"));
  assert.equal(at("2026-10-04").length, 0); // 11 dias antes: ainda não
  const due = at("2026-10-05");
  assert.equal(due.length, 1);
  assert.equal(due[0].type, "experience_45");
  assert.equal(due[0].dueDate, "2026-10-15");
  assert.equal(due[0].severity, "warning");
  assert.equal(due[0].managerEmail, "gestor@empresa.com");
  assert.equal(at("2026-10-13")[0].severity, "urgent");
  assert.equal(at("2026-10-16")[0].severity, "overdue");
  assert.equal(at("2026-11-19")[0].type, "experience_90");
  // Estagiário não tem contrato de experiência; desligado não gera alerta.
  assert.equal(computeAlerts({ employees: [employee({ employmentType: "intern" })], companies: alertCompanies, today: "2026-10-10" }).filter((alert) => alert.type.startsWith("experience_")).length, 0);
  assert.equal(computeAlerts({ employees: [employee({ employmentStatus: "terminated" })], companies: alertCompanies, today: "2026-10-10" }).length, 0);
});

test("férias: limite do concessivo, alerta com 60 dias e urgente com 30", () => {
  assert.deepEqual(vacationDeadline("2024-03-10", 0), { period: 1, acquisitiveEnd: "2025-03-09", concessiveEnd: "2026-03-09" });
  assert.deepEqual(vacationDeadline("2024-03-10", 1), { period: 2, acquisitiveEnd: "2026-03-09", concessiveEnd: "2027-03-09" });
  assert.equal(addYears("2024-02-29", 1), "2025-02-28");
  const at = (today: string, taken = 0) => computeAlerts({ employees: [employee({ admissionDate: "2024-03-10", vacationsTaken: taken })], companies: alertCompanies, today })
    .filter((alert) => alert.type === "vacation_deadline");
  assert.equal(at("2026-01-07").length, 0); // 61 dias antes
  assert.equal(at("2026-01-08")[0].severity, "warning");
  assert.equal(at("2026-02-07")[0].severity, "urgent");
  assert.equal(at("2026-03-10")[0].severity, "overdue");
  assert.equal(at("2026-03-10", 1).length, 0); // férias registradas: o próximo período ainda não venceu
});

test("cadastro incompleto: CPF, CODFUNC, empresa sem CNPJ/CODEMP e ativo em empresa sem funcionários", () => {
  const alerts = computeAlerts({
    employees: [employee({ id: "e2", cpfLast4: "", sankhyaCode: "", admissionDate: "2020-01-01", vacationsTaken: 9 }), employee({ id: "e3", companyId: "c40", admissionDate: "2020-01-01", vacationsTaken: 9 })],
    companies: [...alertCompanies, { id: "c40", name: "Goianésia", taxId: "43.944.672/0001-68", code: "40", dpStatus: "sem_funcionarios", status: "active" },
      { id: "cx", name: "Evviva", taxId: "", code: "", dpStatus: "interno", status: "active" }],
    today: "2026-10-21",
  }).filter((alert) => alert.type === "registration_incomplete");
  assert.match(alerts.find((alert) => alert.employeeId === "e2")?.detail ?? "", /CPF; código do Sankhya/u);
  assert.match(alerts.find((alert) => alert.employeeId === "e3")?.detail ?? "", /sem funcionários/u);
  assert.match(alerts.find((alert) => alert.key === "registration_incomplete:company:cx")?.detail ?? "", /CNPJ, código do Sankhya/u);
});

test("contagem por tipo e por titular", () => {
  const summary = summarizeAlerts([
    { type: "experience_45", severity: "urgent", assignedName: "Rian" },
    { type: "experience_45", severity: "overdue", assignedName: "Rian" },
    { type: "vacation_deadline", severity: "warning", assignedName: null },
  ]);
  assert.deepEqual(summary.byType[0], { key: "experience_45", label: "Experiência — 1º período (45 dias)", total: 2, overdue: 1, urgent: 1 });
  assert.deepEqual(summary.byHolder.map((row) => row.label), ["Rian", "Sem responsável"]);
});

test("Central de Trabalho: alerta do DP é fonte, atribuída ao responsável, e abre a ficha", () => {
  const source = workItemSources.find((item) => item.key === "dp_alert");
  assert.ok(source);
  assert.equal(source.capability, "portfolio.read");
  const mine = buildWorkItemQuery({ source, workspaceId: "ws", userId: "u1", scope: "mine", companyIds: null });
  assert.match(mine.sql, /AND a\.assigned_user_id = \?/u);
  assert.deepEqual(mine.parameters, ["ws", "u1"]);
  assert.equal(workItemHref("dp_alert", "a1", "emp-1"), "/painel/cadastros/emp-1");
  assert.equal(workItemHref("dp_alert", "a1"), "/painel/dp?aba=alertas");
});

/* ------------------------------------------------------------------ */
/* Fase 5 — relatório                                                  */
/* ------------------------------------------------------------------ */

test("relatório mensal: PDF válido com as quatro seções", async () => {
  const { buildMonthlyReportPdf } = await import("../lib/dp-report.ts");
  const pdf = buildMonthlyReportPdf({
    workspaceName: "Opyt", period: "2026-09", delivered: 42, deliveredLate: 5, createdInPeriod: 50,
    occurrencesByArea: [{ area: "Comercial", total: 3, daysLate: 7 }],
    outsideCutoff: [{ area: "Comercial", total: 10, open: 2, outside: 3, outsidePercent: 30 }],
    risks: [{ title: "Experiência (45 dias) de Ana vence em 15/10/2026", dueDate: "2026-10-15", severity: "urgent" }],
    holders: [{ userId: "u", name: "Rian", companies: 6, employeesClt: 180, contractorsPj: 4, openCards: 12, overdueCards: 1, alerts: 3 }],
  }, "2026-10-01");
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  for (const section of ["VOLUME ENTREGUE", "FORA DO PRAZO DE CORTE", "RISCOS NOS PR\\\\323XIMOS 30 DIAS", "CARGA POR TITULAR"]) {
    assert.match(text, new RegExp(section, "u"), `seção ${section} ausente`);
  }
  assert.match(text, /\(Rian\)/u);
});

test("migração 0115: RLS forçada em todas as tabelas novas, uma rotina por período e veredito imutável", async () => {
  const sql = await read("drizzle/postgres/0115_dp_operations.sql");
  for (const table of ["fdp_dp_settings", "fdp_recurring_templates", "fdp_recurring_occurrences", "fdp_cutoff_rules", "fdp_dp_occurrences", "fdp_dp_alerts", "fdp_dp_report_runs"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`, "u"), table);
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"), table);
    assert.match(sql, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`, "u"), table);
  }
  assert.match(sql, /"fdp_recurring_occurrences_once_uq" ON "fdp_recurring_occurrences" USING btree \("workspace_id", "template_id", "period_key", "scope_key"\)/u);
  assert.match(sql, /fdp_cards\.within_cutoff é decidido na criação e não muda/u);
  assert.match(sql, /"fdp_dp_report_runs_period_uq"/u);
  const journal = JSON.parse(await read("drizzle/postgres/meta/_journal.json")) as { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0115_dp_operations"));
});

test("o corte é avaliado nos caminhos de criação que têm data pedida", async () => {
  for (const path of ["app/api/cards/route.ts", "lib/integration-engine.ts", "lib/teams-integration.ts", "lib/tangerino/demand.ts",
    "lib/tangerino/open-admissions.ts", "app/api/integrations/teams/demand/route.ts"]) {
    assert.match(await read(path), /prepareCutoffEvaluation\(/u, `${path} cria demanda sem conferir o corte`);
  }
  assert.match(await read("app/api/payroll-movements/route.ts"), /prepareLateMovementOccurrence\(/u);
});

test("o job diário exige o segredo e roda rotinas, alertas e relatório por workspace", async () => {
  const route = await read("app/api/cron/dp-operations/route.ts");
  assert.match(route, /if \(!authorized\(request\)\) return Response\.json\(\{ error: "Execução agendada não autorizada\." \}, \{ status: 401 \}\)/u);
  assert.match(route, /timingSafeEqual/u);
  for (const call of ["generateRecurringTasks(", "refreshDpAlerts(", "sendMonthlyDpReport("]) assert.ok(route.includes(call), call);
  assert.match(await read(".github/workflows/dp-operations-cron.yml"), /api\/cron\/dp-operations/u);
});
