import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  closingDateFor, cnpjRoot, isAbsent, isDpStatus, isHeadquarters, isIsoDate, resolveResponsible,
  skipsSankhyaSync, termOn, validatePortfolioChange, type MemberAbsence, type PortfolioTerm,
} from "../lib/portfolio.ts";
import { buildWorkItemQuery, workItemSources } from "../lib/work-items.ts";

/**
 * Carteira do DP — Fase 1 do DP Operacional.
 *
 * `resolveResponsible` é a regra que toda criação de demanda consulta quando
 * ninguém escolheu o responsável. O aceite da especificação está escrito aqui
 * com os nomes reais: demanda da empresa 33 vai para o Rian; com o Rian em
 * ausência, para a Odete.
 */

const RIAN = "user-rian";
const ODETE = "user-odete";
const GOIANIA = "company-33";
const INHUMAS = "company-10";

const carteira: PortfolioTerm[] = [
  { companyId: GOIANIA, holderUserId: RIAN, backupUserId: ODETE, validFrom: "2026-01-01", validTo: null },
  { companyId: INHUMAS, holderUserId: ODETE, backupUserId: RIAN, validFrom: "2026-01-01", validTo: null },
];

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("aceite: demanda da 33 vai para o Rian; com o Rian ausente, para a Odete", () => {
  assert.deepEqual(resolveResponsible(carteira, [], GOIANIA, "2026-10-20"),
    { userId: RIAN, via: "holder", holderUserId: RIAN });
  const feriasDoRian: MemberAbsence[] = [{ userId: RIAN, startsOn: "2026-10-15", endsOn: "2026-10-30" }];
  assert.deepEqual(resolveResponsible(carteira, feriasDoRian, GOIANIA, "2026-10-20"),
    { userId: ODETE, via: "backup", holderUserId: RIAN });
  // A ausência de um não muda a carteira de quem não é titular ali.
  assert.equal(resolveResponsible(carteira, feriasDoRian, INHUMAS, "2026-10-20").userId, ODETE);
});

test("ausência vale nas duas pontas, inclusive", () => {
  const ausencia: MemberAbsence[] = [{ userId: RIAN, startsOn: "2026-10-10", endsOn: "2026-10-20" }];
  assert.equal(isAbsent(ausencia, RIAN, "2026-10-09"), false);
  assert.equal(isAbsent(ausencia, RIAN, "2026-10-10"), true);
  assert.equal(isAbsent(ausencia, RIAN, "2026-10-20"), true);
  assert.equal(isAbsent(ausencia, RIAN, "2026-10-21"), false);
  assert.equal(resolveResponsible(carteira, ausencia, GOIANIA, "2026-10-21").userId, RIAN);
});

test("titular e backup ausentes: ninguém, e a demanda fica em Sem responsável", () => {
  const ambos: MemberAbsence[] = [
    { userId: RIAN, startsOn: "2026-10-01", endsOn: "2026-10-31" },
    { userId: ODETE, startsOn: "2026-10-20", endsOn: "2026-10-20" },
  ];
  assert.deepEqual(resolveResponsible(carteira, ambos, GOIANIA, "2026-10-20"),
    { userId: null, via: null, holderUserId: RIAN });
});

test("titular ausente sem backup: ninguém", () => {
  const semBackup: PortfolioTerm[] = [{ companyId: GOIANIA, holderUserId: RIAN, backupUserId: null, validFrom: "2026-01-01", validTo: null }];
  const ausencia: MemberAbsence[] = [{ userId: RIAN, startsOn: "2026-10-20", endsOn: "2026-10-20" }];
  assert.equal(resolveResponsible(semBackup, ausencia, GOIANIA, "2026-10-20").userId, null);
});

test("sem carteira ou sem empresa: ninguém", () => {
  assert.equal(resolveResponsible(carteira, [], "company-46", "2026-10-20").userId, null);
  assert.equal(resolveResponsible(carteira, [], null, "2026-10-20").userId, null);
  assert.equal(resolveResponsible(carteira, [], "", "2026-10-20").userId, null);
});

test("a vigência decide quem respondia na data, não quem responde hoje", () => {
  const historico: PortfolioTerm[] = [
    { companyId: GOIANIA, holderUserId: ODETE, backupUserId: null, validFrom: "2025-01-01", validTo: "2026-06-30" },
    { companyId: GOIANIA, holderUserId: RIAN, backupUserId: ODETE, validFrom: "2026-07-01", validTo: null },
  ];
  assert.equal(resolveResponsible(historico, [], GOIANIA, "2026-03-10").userId, ODETE);
  assert.equal(resolveResponsible(historico, [], GOIANIA, "2026-06-30").userId, ODETE);
  assert.equal(resolveResponsible(historico, [], GOIANIA, "2026-07-01").userId, RIAN);
  // Antes da primeira vigência não há carteira.
  assert.equal(resolveResponsible(historico, [], GOIANIA, "2024-12-31").userId, null);
});

test("troca no mesmo dia em que a vigência começou: vale a nova", () => {
  const corrigida: PortfolioTerm[] = [
    { companyId: GOIANIA, holderUserId: ODETE, backupUserId: null, validFrom: "2026-10-20", validTo: "2026-10-20" },
    { companyId: GOIANIA, holderUserId: RIAN, backupUserId: null, validFrom: "2026-10-20", validTo: null },
  ];
  assert.equal(termOn(corrigida, GOIANIA, "2026-10-20")?.holderUserId, RIAN);
  // A ordem de leitura do banco não decide.
  assert.equal(termOn([...corrigida].reverse(), GOIANIA, "2026-10-20")?.holderUserId, RIAN);
});

test("onde a vigência que sai termina", () => {
  assert.equal(closingDateFor("2026-01-01", "2026-10-20"), "2026-10-19");
  assert.equal(closingDateFor("2026-03-01", "2026-03-01"), "2026-03-01");
  // Virada de mês e de ano.
  assert.equal(closingDateFor("2026-01-01", "2026-03-01"), "2026-02-28");
  assert.equal(closingDateFor("2025-01-01", "2026-01-01"), "2025-12-31");
  // Antes do início: recusada, reescreveria o passado.
  assert.equal(closingDateFor("2026-10-20", "2026-10-19"), null);
});

test("validação da troca de carteira", () => {
  assert.equal(validatePortfolioChange({ companyId: GOIANIA, holderUserId: RIAN, backupUserId: ODETE, validFrom: "2026-10-20" }), null);
  assert.match(String(validatePortfolioChange({ holderUserId: RIAN, validFrom: "2026-10-20" })), /empresa/u);
  assert.match(String(validatePortfolioChange({ companyId: GOIANIA, validFrom: "2026-10-20" })), /titular/u);
  assert.match(String(validatePortfolioChange({ companyId: GOIANIA, holderUserId: RIAN, backupUserId: RIAN, validFrom: "2026-10-20" })), /outra pessoa/u);
  assert.match(String(validatePortfolioChange({ companyId: GOIANIA, holderUserId: RIAN, validFrom: "2026-02-30" })), /data/u);
  assert.equal(isIsoDate("2026-02-28"), true);
  assert.equal(isIsoDate("20/10/2026"), false);
});

test("raiz e matriz derivadas do CNPJ: Goiânia é filial da raiz de Goianésia", () => {
  assert.equal(cnpjRoot("43.944.672/0003-20"), "43944672");
  assert.equal(cnpjRoot("43.944.672/0001-68"), "43944672");
  assert.equal(isHeadquarters("43.944.672/0003-20"), false);
  assert.equal(isHeadquarters("43.944.672/0001-68"), true);
  assert.equal(cnpjRoot(""), "");
  assert.equal(isHeadquarters("123"), false);
});

test("situação do DP e a regra da sincronização", () => {
  for (const status of ["interno", "a_internalizar", "sem_funcionarios", "terceirizado"]) assert.equal(isDpStatus(status), true);
  assert.equal(isDpStatus("ativo"), false);
  assert.equal(skipsSankhyaSync("sem_funcionarios"), true);
  assert.equal(skipsSankhyaSync("interno"), false);
  assert.equal(skipsSankhyaSync(undefined), false);
});

test("migração: carteira e ausência com RLS forçada, vigência aberta única e histórico que só cresce", async () => {
  const sql = await read("drizzle/postgres/0114_dp_portfolio.sql");
  for (const table of ["fdp_company_portfolio", "fdp_member_absences"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`, "u"));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"));
    assert.match(sql, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`, "u"));
  }
  assert.match(sql, /"fdp_company_portfolio_open_uq" ON "fdp_company_portfolio" USING btree \("workspace_id", "company_id"\) WHERE "valid_to" IS NULL/u);
  assert.match(sql, /BEFORE UPDATE ON "fdp_company_portfolio"/u);
  assert.match(sql, /vigência encerrada não muda/u);
  assert.match(sql, /"cnpj_root" text\s+GENERATED ALWAYS AS/u);
  assert.match(sql, /'interno', 'a_internalizar', 'sem_funcionarios', 'terceirizado'/u);
  const journal = JSON.parse(await read("drizzle/postgres/meta/_journal.json")) as { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0114_dp_portfolio"));
});

test("toda criação de demanda do DP passa pela carteira quando ninguém escolheu o responsável", async () => {
  const caminhos = [
    "app/api/cards/route.ts",
    "lib/process-instances.ts",
    "lib/integration-engine.ts",
    "lib/teams-integration.ts",
    "lib/tangerino/demand.ts",
    "lib/tangerino/open-admissions.ts",
    "lib/epi-service.ts",
    "app/api/integrations/movements/[id]/route.ts",
    "app/api/inbox/[id]/convert/route.ts",
  ];
  for (const caminho of caminhos) {
    const codigo = await read(caminho);
    assert.match(codigo, /INSERT INTO fdp_cards/u, `${caminho} não cria demanda`);
    assert.match(codigo, /preparePortfolioAssignment\(/u, `${caminho} cria demanda sem consultar a carteira`);
  }
  // A investigação de acidente é do SESMT, não de um analista de DP: fica de
  // fora por escrito, e não por esquecimento.
  const acidente = await read("lib/work-accidents-service.ts");
  assert.match(acidente, /Fora da carteira do DP de propósito/u);
  // Escolha explícita vence: o formulário com responsável não consulta a carteira.
  const cards = await read("app/api/cards/route.ts");
  assert.match(cards, /const portfolio = hasAssignees\s+\? \{ statements: \[\], resolution: null \}/u);
  // E a etapa inicial que nomeia um usuário também vence.
  const processo = await read("lib/process-instances.ts");
  assert.match(processo, /responsibilityMode === "USER" \? initial\.config\.responsibleUserId/u);
});

test("nenhum outro arquivo cria demanda sem estar na lista acima", async () => {
  const { readdir } = await import("node:fs/promises");
  const encontrados: string[] = [];
  async function walk(dir: URL, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, dir), `${path}/`);
      else if (/\.tsx?$/u.test(entry.name) && /INSERT INTO fdp_cards\b/u.test(await readFile(new URL(entry.name, dir), "utf8"))) encontrados.push(path);
    }
  }
  await walk(new URL("../lib/", import.meta.url), "lib/");
  await walk(new URL("../app/", import.meta.url), "app/");
  assert.deepEqual(encontrados.sort(), [
    "app/api/cards/route.ts",
    "app/api/inbox/[id]/convert/route.ts",
    "app/api/integrations/movements/[id]/route.ts",
    "lib/epi-service.ts",
    "lib/integration-engine.ts",
    "lib/process-instances.ts",
    "lib/tangerino/demand.ts",
    "lib/tangerino/open-admissions.ts",
    "lib/teams-integration.ts",
    "lib/work-accidents-service.ts",
  ], "novo ponto de criação de demanda: ligue-o à carteira (lib/portfolio-assignment.ts) e inclua-o no teste acima");
});

test("a sincronização do Sankhya ignora registro de empresa sem funcionários", async () => {
  const importer = await read("lib/sankhya/importer.ts");
  assert.match(importer, /skipsSankhyaSync\(company\?\.dp_status\)/u);
  assert.match(importer, /totals\.ignored = input\.records\.length/u);
  const planilha = await read("app/api/employees/import/sankhya/route.ts");
  assert.match(planilha, /dp_status = 'sem_funcionarios'/u);
  assert.match(planilha, /classification: "ignored" as const/u);
});

test("Central de Trabalho: o recorte Sem responsável só traz demanda sem ninguém atribuído", () => {
  const card = workItemSources.find((source) => source.key === "card");
  assert.ok(card);
  const semResponsavel = buildWorkItemQuery({ source: card, workspaceId: "ws", userId: "u", scope: "unassigned", companyIds: null });
  assert.match(semResponsavel.sql, /AND NOT EXISTS \(SELECT 1 FROM fdp_card_assignees ca WHERE ca\.card_id = c\.id\)/u);
  assert.deepEqual(semResponsavel.parameters, ["ws"]);
  // Fonte sem noção de responsável não entra nesse recorte.
  const approval = workItemSources.find((source) => source.key === "approval");
  assert.ok(approval);
  assert.match(buildWorkItemQuery({ source: approval, workspaceId: "ws", userId: "u", scope: "unassigned", companyIds: null }).sql, /AND false/u);
});
