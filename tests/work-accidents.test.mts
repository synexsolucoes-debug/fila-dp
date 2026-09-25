import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilities, hasCapability } from "../lib/authorization.ts";
import { capabilityCatalog } from "../lib/capability-catalog.ts";
import { moduleWriteCapabilities } from "../lib/modules.ts";
import { areaModuleKeys } from "../lib/areas.ts";
import { panelViews, panelPath, parsePanelPath } from "../lib/panel-routes.ts";
import { groupOfView, viewsWithoutProcess } from "../lib/process-navigation.ts";
import {
  accidentBodyParts, accidentGenders, accidentShifts, accidentTypes, catDeadline,
  investigationDemandTitle, matchesPeriod, summarizeAccidents, UNASSIGNED_SECTOR,
  type WorkAccidentRecord,
} from "../lib/work-accidents.ts";

/**
 * Dashboard de Acidente de Trabalho.
 *
 * O módulo tem três promessas, e são elas que estes testes prendem:
 *
 *  1. **os nove recortes são a mesma soma.** Total, tipo, parte do corpo,
 *     setor, gênero, turno e mês saem de uma função só sobre um registro por
 *     acidente. Dois deles discordarem seria o defeito que faz o SESMT levar
 *     números diferentes para a mesma reunião;
 *  2. **o período é o do fato.** Filtrar por lançamento moveria o acidente de
 *     março para o mês em que alguém o digitou;
 *  3. **o percentual exibido fecha em 100.** Os números aparecem escritos ao
 *     lado da rosca, e arredondar cada fatia isolada produz 99 num dia e 101 no
 *     outro.
 *
 * O resto verifica o que o produto exige de todo módulo novo: migration com
 * RLS, catálogo, permissões descritas e tela com porta no menu.
 */

const migration = await readFile(new URL("../drizzle/postgres/0083_work_accident_dashboard.sql", import.meta.url), "utf8");

const accident = (over: Partial<WorkAccidentRecord> = {}): WorkAccidentRecord => ({
  id: crypto.randomUUID(), companyId: "empresa-1", companyName: "Empresa 1",
  occurredOn: "2026-03-10", accidentType: "typical", bodyPart: "hand", sector: "Operacional",
  shift: "morning", gender: "male", employeeLabel: "", leaveDays: 0, expenseAmount: 0,
  catNumber: "", catIssued: false, description: "", investigationCardId: null, ...over,
});

/* -------------------------------------------------------------------------- */
/* Apuração                                                                   */
/* -------------------------------------------------------------------------- */

test("os recortes somam o mesmo total do cartão do topo", () => {
  const records = [
    accident({ accidentType: "typical", bodyPart: "hand", sector: "Operacional", shift: "morning", gender: "male" }),
    accident({ accidentType: "commute", bodyPart: "leg", sector: "Comercial", shift: "night", gender: "female" }),
    accident({ accidentType: "incident", bodyPart: "eyes", sector: "Operacional", shift: "afternoon", gender: "female" }),
  ];
  const dashboard = summarizeAccidents(records);
  assert.equal(dashboard.totals.accidents, 3);
  for (const slice of ["byType", "byBodyPart", "bySector", "byGender", "byShift"] as const) {
    const total = dashboard[slice].reduce((sum, item) => sum + item.total, 0);
    assert.equal(total, 3, `${slice} não fecha com o total de acidentes`);
  }
  assert.equal(dashboard.byMonth.reduce((sum, point) => sum + point.total, 0), 3);
});

test("o percentual exibido fecha em 100, inclusive quando a divisão não é exata", () => {
  // Três fatias iguais dão 33,33% cada: somadas com arredondamento simples, 99.
  const records = [accident({ accidentType: "typical" }), accident({ accidentType: "commute" }), accident({ accidentType: "incident" })];
  const dashboard = summarizeAccidents(records);
  assert.equal(dashboard.byType.reduce((sum, item) => sum + item.share, 0), 100);
  // E com sete fatias, onde o resto se acumula em mais lugares.
  const sete = Array.from({ length: 7 }, (_, index) =>
    accident({ bodyPart: accidentBodyParts[index] }));
  assert.equal(summarizeAccidents(sete).byBodyPart.reduce((sum, item) => sum + item.share, 0), 100);
});

test("o período filtra pela data do fato, não pela do lançamento", () => {
  const records = [
    accident({ occurredOn: "2025-03-04" }),
    accident({ occurredOn: "2026-03-19" }),
    accident({ occurredOn: "2026-09-02" }),
  ];
  assert.equal(summarizeAccidents(records, { years: [2026] }).totals.accidents, 2);
  assert.equal(summarizeAccidents(records, { years: [2026], months: [3] }).totals.accidents, 1);
  assert.equal(summarizeAccidents(records, { months: [3] }).totals.accidents, 2);
  // Filtro vazio é "tudo", e não "nada": é o estado em que a tela abre.
  assert.equal(summarizeAccidents(records, {}).totals.accidents, 3);
});

test("os anos oferecidos vêm da base inteira, não do recorte atual", () => {
  // Sem isso, quem entra em 2026 não teria botão para voltar a 2025.
  const dashboard = summarizeAccidents(
    [accident({ occurredOn: "2025-01-05" }), accident({ occurredOn: "2026-01-05" })],
    { years: [2026] },
  );
  assert.deepEqual(dashboard.years, [2025, 2026]);
  assert.equal(dashboard.totals.accidents, 1);
});

test("dias afastados e despesa somam o que foi lançado, e o afastamento tem contagem própria", () => {
  const dashboard = summarizeAccidents([
    accident({ leaveDays: 15, expenseAmount: 1200.55 }),
    accident({ leaveDays: 0, expenseAmount: 300.45 }),
    accident({ leaveDays: 3, expenseAmount: 0, catIssued: true }),
  ]);
  assert.equal(dashboard.totals.leaveDays, 18);
  assert.equal(dashboard.totals.expenses, 1501);
  assert.equal(dashboard.totals.withLeave, 2);
  assert.equal(dashboard.totals.catIssued, 1);
});

test("mês sem acidente é zero na série, e não buraco", () => {
  const dashboard = summarizeAccidents([accident({ occurredOn: "2026-07-08" })], { years: [2026] });
  assert.equal(dashboard.byMonth.length, 12);
  assert.equal(dashboard.byMonth[6].total, 1);
  assert.equal(dashboard.byMonth[0].total, 0);
  assert.deepEqual(dashboard.byMonth.map((point) => point.label).slice(0, 3), ["JAN", "FEV", "MAR"]);
});

test("setor em branco tem nome na barra, e gênero não informado continua contando", () => {
  const dashboard = summarizeAccidents([
    accident({ sector: "   ", gender: "not_informed" }),
    accident({ sector: "Operacional", gender: "female" }),
  ]);
  assert.ok(dashboard.bySector.some((item) => item.label === UNASSIGNED_SECTOR));
  assert.equal(dashboard.bySector.reduce((sum, item) => sum + item.total, 0), 2);
  // Somar só quem declarou e apresentar como o todo seria um gráfico que mente
  // sem errar nenhuma conta.
  assert.equal(dashboard.byGender.reduce((sum, item) => sum + item.total, 0), 2);
  assert.equal(dashboard.byGender.find((item) => item.key === "not_informed")?.total, 1);
});

test("o recorte por empresa vale junto com o de período", () => {
  const registro = accident({ companyId: "empresa-2", occurredOn: "2026-03-10" });
  assert.equal(matchesPeriod(registro, { companyId: "empresa-2", years: [2026], months: [3] }), true);
  assert.equal(matchesPeriod(registro, { companyId: "empresa-1" }), false);
  assert.equal(matchesPeriod(registro, { years: [2025] }), false);
});

test("base vazia não quebra nenhum gráfico", () => {
  const dashboard = summarizeAccidents([]);
  assert.equal(dashboard.totals.accidents, 0);
  assert.equal(dashboard.totals.expenses, 0);
  assert.deepEqual(dashboard.byType, []);
  assert.equal(dashboard.byMonth.length, 12);
  assert.deepEqual(dashboard.years, []);
});

test("o prazo da CAT pula sábado e domingo, e só isso — feriado não entra porque não há calendário por empresa", () => {
  // Quinta 2026-01-08: prazo é sexta (dia seguinte).
  assert.equal(catDeadline("2026-01-08"), "2026-01-09");
  // Sexta 2026-01-09: prazo pula para segunda.
  assert.equal(catDeadline("2026-01-09"), "2026-01-12");
  // Sábado 2026-01-10: prazo também cai na segunda.
  assert.equal(catDeadline("2026-01-10"), "2026-01-12");
  // Domingo 2026-01-11: o dia seguinte já é segunda, sem ajuste extra.
  assert.equal(catDeadline("2026-01-11"), "2026-01-12");
});

/* -------------------------------------------------------------------------- */
/* Banco                                                                      */
/* -------------------------------------------------------------------------- */

test("a tabela nasce com isolamento por tenant no banco, e não só na consulta", () => {
  assert.match(migration, /ALTER TABLE "fdp_work_accidents" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "fdp_work_accidents" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /USING \("workspace_id" = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)\)/u);
  assert.match(migration, /WITH CHECK \("workspace_id" = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)\)/u);
});

test("o vocabulário do dashboard é o mesmo no banco e no código", () => {
  // Uma lista que divirja da outra grava uma fatia que o CHECK recusa — ou pior,
  // aceita um valor que nenhum rótulo sabe traduzir e a rosca mostra em branco.
  for (const value of accidentTypes) assert.ok(migration.includes(`'${value}'`), `tipo ${value} fora do CHECK`);
  for (const value of accidentBodyParts) assert.ok(migration.includes(`'${value}'`), `parte ${value} fora do CHECK`);
  for (const value of accidentShifts) assert.ok(migration.includes(`'${value}'`), `turno ${value} fora do CHECK`);
  for (const value of accidentGenders) assert.ok(migration.includes(`'${value}'`), `gênero ${value} fora do CHECK`);
});

test("o banco recusa número somado que não faz sentido, e protocolo sem emissão", () => {
  assert.match(migration, /"fdp_work_accidents_leave_days_check" CHECK \("fdp_work_accidents"\."leave_days" >= 0\)/u);
  assert.match(migration, /"fdp_work_accidents_expense_check" CHECK \("fdp_work_accidents"\."expense_amount" >= 0\)/u);
  assert.match(migration, /"fdp_work_accidents_cat_number_check"[\s\S]{0,140}"cat_issued" = 1 OR/u);
});

test("o módulo entra no catálogo e em todos os planos", () => {
  assert.match(migration, /INSERT INTO "fdp_modules"[\s\S]{0,400}\('safety', 'Acidentes de Trabalho'/u);
  assert.match(migration, /'pessoas', 'safety', 'safety\.view'/u);
  assert.match(migration, /INSERT INTO "fdp_plan_modules"[\s\S]{0,120}SELECT p\."id", 'safety' FROM "fdp_saas_plans" p/u);
});

test("a migration está registrada no journal do Drizzle", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/postgres/meta/_journal.json", import.meta.url), "utf8")) as
    { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0083_work_accident_dashboard"));
});

/* -------------------------------------------------------------------------- */
/* Permissões e navegação                                                     */
/* -------------------------------------------------------------------------- */

test("toda capacidade do módulo está descrita para quem administra o grupo", () => {
  for (const capability of capabilities.filter((item) => item.startsWith("safety."))) {
    assert.equal(capabilityCatalog[capability].area, "safety");
    assert.ok(capabilityCatalog[capability].label.length > 10, `${capability} sem explicação`);
  }
});

test("registrar é do membro; excluir não é", () => {
  // Apagar um acidente apaga o número que sustenta o período inteiro, e a CAT
  // que ele acompanha já saiu da empresa.
  assert.equal(hasCapability("member", "safety.manage"), true);
  assert.equal(hasCapability("member", "safety.export"), true);
  assert.equal(hasCapability("member", "safety.delete"), false);
  assert.equal(hasCapability("admin", "safety.delete"), true);
  // Observador consulta e não escreve; convidado não entra.
  assert.equal(hasCapability("observer", "safety.view"), true);
  assert.equal(hasCapability("observer", "safety.manage"), false);
  assert.equal(hasCapability("guest", "safety.view"), false);
});

test("negar o módulo fecha também as ações de escrita dele", () => {
  // `fdp_modules` guarda só a capacidade de leitura; sem o mapa de escrita,
  // quem perdesse a tela continuaria lançando acidente pela rota.
  assert.deepEqual(moduleWriteCapabilities.safety, ["safety.manage", "safety.delete", "safety.export"]);
});

test("a tela tem endereço próprio e mora em um processo do menu", () => {
  assert.ok(panelViews.includes("safety"));
  assert.equal(panelPath({ view: "safety" }), "/painel/acidentes");
  assert.equal(parsePanelPath("/painel/acidentes").view, "safety");
  assert.equal(groupOfView("safety")?.id, "seguranca-do-trabalho");
  // Tela fora de grupo some do menu sem erro de compilação e sem tela em branco.
  assert.deepEqual(viewsWithoutProcess([...panelViews]), []);
});

test("cada rota do módulo confere a própria permissão", async () => {
  const rotas = [
    ["overview/route.ts", "safety.view"],
    ["accidents/route.ts", "safety.view"],
    ["accidents/[id]/route.ts", "safety.manage"],
    ["accidents/[id]/investigation/route.ts", "safety.manage"],
    ["export/route.ts", "safety.export"],
  ] as const;
  for (const [caminho, capability] of rotas) {
    const fonte = await readFile(new URL(`../app/api/safety/${caminho}`, import.meta.url), "utf8");
    assert.ok(fonte.includes(`requireNamedCapability(workspace, "${capability}"`), `${caminho} não exige ${capability}`);
    // Recorte de empresa em toda rota: sem ele, quem enxerga uma filial leria
    // o acidente de outra.
    assert.match(fonte, /getCompanyAccessScope|requireCompanyAccess/u, `${caminho} sem recorte de empresa`);
  }
  const escrita = await readFile(new URL("../app/api/safety/accidents/[id]/route.ts", import.meta.url), "utf8");
  assert.ok(escrita.includes('requireNamedCapability(workspace, "safety.delete"'), "excluir precisa de permissão própria");
});

/* -------------------------------------------------------------------------- */
/* Plano de ação — demanda de investigação (§4.14)                            */
/* -------------------------------------------------------------------------- */

test("o título da demanda de investigação nomeia o setor e a data, para distinguir dois acidentes do mesmo setor", () => {
  assert.equal(investigationDemandTitle("Operacional", "2026-03-10"), "Investigar acidente de trabalho — Operacional (2026-03-10)");
  assert.equal(investigationDemandTitle("", "2026-03-10"), `Investigar acidente de trabalho — ${UNASSIGNED_SECTOR} (2026-03-10)`);
});

test("a área de investigação de acidentes está no catálogo de roteamento, ao lado das áreas de EPI", () => {
  assert.ok(areaModuleKeys.includes("safety.investigation"));
});

test("o cartão de investigação nasce antes de o acidente apontar para ele — a FK exige que ele já exista", async () => {
  const rota = await readFile(new URL("../app/api/safety/accidents/[id]/investigation/route.ts", import.meta.url), "utf8");
  const servico = await readFile(new URL("../lib/work-accidents-service.ts", import.meta.url), "utf8");
  const batchStart = rota.indexOf("await d1.batch([");
  const insertIndex = rota.indexOf("demand.statement", batchStart);
  const updateIndex = rota.indexOf("UPDATE fdp_work_accidents SET investigation_card_id", batchStart);
  assert.ok(insertIndex > batchStart && updateIndex > insertIndex,
    "o INSERT do cartão precisa vir antes do UPDATE que vincula o acidente a ele");
  assert.match(servico, /resolveAreaModule\(d1, input\.workspaceId, "safety\.investigation"\)/u);
});

test("duplo clique não abre dois planos de ação — a guarda está na condição do UPDATE, não numa checagem antes", () => {
  return readFile(new URL("../app/api/safety/accidents/[id]/investigation/route.ts", import.meta.url), "utf8").then((rota) => {
    assert.match(rota, /WHERE workspace_id = \? AND id = \? AND investigation_card_id IS NULL/u);
    assert.match(rota, /if \(accident\.investigation_card_id\)/u, "checagem otimista também existe, para recusar cedo o caso comum");
  });
});

test("a tela mostra o botão de abrir plano de ação só para quem gerencia, e chama a rota certa", async () => {
  const view = await readFile(new URL("../app/painel/features/safety/WorkAccidentDashboardView.tsx", import.meta.url), "utf8");
  assert.match(view, /requestJson\(`\/api\/safety\/accidents\/\$\{record\.id\}\/investigation`, \{ method: "POST" \}\)/u);
  assert.match(view, /record\.investigationCardId\s*\n?\s*\?\s*"Aberto em Demandas"/u);
});
