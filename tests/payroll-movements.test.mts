import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MOVEMENT_EXPORT_HEADER, assignSequences, buildMovementExport, checkMovement, competenceEnd, competenceReference,
  hasBlock, normalizeTipmov, parseCompetence, parseDecimalInput, parseEventCatalogRows, parsePastedMovements, pastedCompanyMismatch, pastedMovementCells,
  sankhyaCompanyCode, sankhyaEmployeeCode, toCents, type PayrollCatalogEvent,
} from "../lib/payroll-movements.ts";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const horasExtras: PayrollCatalogEvent = { code: 9, description: "HORAS EXTRAS 50%", unit: "H", eventType: 1, active: true };
const comissao: PayrollCatalogEvent = { code: 120, description: "COMISSÕES", unit: "V", eventType: 1, active: true };
const desconto: PayrollCatalogEvent = { code: 37, description: "DESCONTO", unit: "V", eventType: -1, active: true };
const inativo: PayrollCatalogEvent = { code: 55, description: "EVENTO ANTIGO", unit: "V", eventType: 1, active: false };
const ativo = { employmentStatus: "active", terminationDate: null };

test("a planilha sai com as colunas do modelo do Sankhya, na ordem", () => {
  assert.deepEqual([...MOVEMENT_EXPORT_HEADER], [
    "CODEMP", "CODFUNC", "REFERENCIA", "TIPMOV", "CODEVENTO", "SEQUENCIA", "INDICE", "VLRMOV", "TIPEVENTO", "UNIDADE",
  ]);
});

test("competência e referência", () => {
  assert.equal(parseCompetence("2026-10"), "2026-10");
  assert.equal(parseCompetence("2026-13"), null);
  assert.equal(parseCompetence("10/2026"), null);
  assert.equal(competenceReference("2026-10"), "2026-10-01");
  assert.equal(competenceEnd("2026-02"), "2026-02-28");
  assert.equal(competenceEnd("2028-02"), "2028-02-29");
  assert.equal(competenceEnd("2026-10"), "2026-10-31");
});

test("número digitado do jeito brasileiro, horas e texto inválido", () => {
  assert.equal(parseDecimalInput("1.234,56"), 1234.56);
  assert.equal(parseDecimalInput("12,5"), 12.5);
  assert.equal(parseDecimalInput("312.50"), 312.5);
  assert.equal(parseDecimalInput("R$ 850,00"), 850);
  assert.equal(parseDecimalInput("2:30"), 2.5);
  assert.equal(parseDecimalInput(""), 0);
  assert.equal(parseDecimalInput("doze"), null);
  assert.equal(toCents(1234.565), 123457);
});

test("TIPMOV aceita o código do Sankhya e cai no padrão quando vem vazio ou estranho", () => {
  assert.equal(normalizeTipmov("a"), "A");
  assert.equal(normalizeTipmov(""), "A");
  assert.equal(normalizeTipmov("M"), "M");
  assert.equal(normalizeTipmov("ABC"), "A");
});

test("o catálogo lê a query da TFPEVE com título e emissão antes do cabeçalho", () => {
  const rows = [
    ["Resultado da Query"],
    ["Emissão:20/10/2026 14:30:14", "Total de registros:4"],
    ["CODEVENTO", "DESCREVENTO", "UNIDADE", "CODFORM", "INDICE", "TIPEVENTO", "ATIVO"],
    [9, "HORAS EXTRAS 50%", "H", 9325, 1.5, 1, "S"],
    [37, "DESCONTO", "V", "", 0, -1, "S"],
    ["0", "<SEM EVENTO>", "D", "", "", -1, "S"],
    [40, "BASE MARGEM", "V", "", 0, 0, "N"],
    [41, "", "V", "", 0, 1, "S"],
  ];
  const { events, skipped } = parseEventCatalogRows(rows);
  assert.deepEqual(events.map((event) => event.code), [9, 37, 40]);
  assert.equal(skipped, 2);
  assert.deepEqual(events[0], { code: 9, description: "HORAS EXTRAS 50%", unit: "H", eventType: 1, active: true });
  assert.equal(events[1].eventType, -1);
  assert.equal(events[2].eventType, 0);
  assert.equal(events[2].active, false);
  assert.throws(() => parseEventCatalogRows([["CODFUNC", "NOMEFUNC"]]), /CODEVENTO e DESCREVENTO/u);
});

test("códigos do Sankhya: CODFUNC pelo external_id, depois matrícula numérica, senão nada", () => {
  assert.equal(sankhyaEmployeeCode({ externalId: "10:017", registrationNumber: "abc" }), "17");
  assert.equal(sankhyaEmployeeCode({ externalId: "", registrationNumber: "0045" }), "45");
  assert.equal(sankhyaEmployeeCode({ externalId: "solides-123", registrationNumber: "A-12" }), "");
  assert.equal(sankhyaCompanyCode("033"), "33");
  assert.equal(sankhyaCompanyCode("COD_EMPRESA"), "");
});

test("evento de horas vai no índice e evento de valor vai em reais — trocar é bloqueio", () => {
  const competence = "2026-10";
  assert.deepEqual(checkMovement({ competence, indexValue: 12.5, amountCents: 0, event: horasExtras, employee: ativo }), []);
  assert.ok(hasBlock(checkMovement({ competence, indexValue: 0, amountCents: 5000, event: horasExtras, employee: ativo })));
  assert.ok(hasBlock(checkMovement({ competence, indexValue: 3, amountCents: 0, event: comissao, employee: ativo })));
  assert.deepEqual(checkMovement({ competence, indexValue: 0, amountCents: 85000, event: comissao, employee: ativo }), []);
  const misto = checkMovement({ competence, indexValue: 2, amountCents: 100, event: horasExtras, employee: ativo });
  assert.ok(!hasBlock(misto) && misto.some((check) => check.level === "warn"));
});

test("evento inativo, fora do catálogo ou lançamento zerado bloqueiam", () => {
  const competence = "2026-10";
  assert.ok(hasBlock(checkMovement({ competence, indexValue: 0, amountCents: 100, event: inativo, employee: ativo })));
  assert.ok(hasBlock(checkMovement({ competence, indexValue: 0, amountCents: 100, event: null, employee: ativo })));
  assert.ok(hasBlock(checkMovement({ competence, indexValue: 0, amountCents: 0, event: comissao, employee: ativo })));
});

test("desligado antes da competência bloqueia; desligado nela só avisa", () => {
  const competence = "2026-10";
  const antes = checkMovement({ competence, indexValue: 0, amountCents: 100, event: comissao,
    employee: { employmentStatus: "terminated", terminationDate: "2026-09-14" } });
  assert.ok(hasBlock(antes));
  const durante = checkMovement({ competence, indexValue: 0, amountCents: 100, event: comissao,
    employee: { employmentStatus: "terminated", terminationDate: "2026-10-10" } });
  assert.ok(!hasBlock(durante));
  assert.match(durante[0].message, /desligado nesta competência/u);
  assert.ok(hasBlock(checkMovement({ competence, indexValue: 0, amountCents: 100, event: comissao, employee: null })));
});

test("SEQUENCIA começa em 0 e sobe no mesmo colaborador e evento, na ordem do lançamento", () => {
  const rows = assignSequences([
    { id: "b", companyCode: "10", employeeCode: "17", eventCode: 120, createdAt: "2026-10-20T10:00:00Z" },
    { id: "a", companyCode: "10", employeeCode: "17", eventCode: 120, createdAt: "2026-10-20T09:00:00Z" },
    { id: "c", companyCode: "10", employeeCode: "17", eventCode: 9, createdAt: "2026-10-20T11:00:00Z" },
    { id: "d", companyCode: "10", employeeCode: "23", eventCode: 120, createdAt: "2026-10-20T08:00:00Z" },
  ]);
  assert.deepEqual(rows.map((row) => [row.id, row.sequence]), [["c", 0], ["a", 0], ["b", 1], ["d", 0]]);
});

test("a exportação monta a linha do modelo e bloqueia o arquivo inteiro diante de qualquer problema", () => {
  const events = new Map([[9, horasExtras], [120, comissao], [37, desconto], [55, inativo]]);
  const base = { employeeName: "Fulano", createdAt: "2026-10-20T10:00:00Z" };
  const ok = buildMovementExport({ competence: "2026-10", tipmov: "", events, entries: [
    { ...base, id: "1", companyCode: "10", employeeCode: "17", eventCode: 9, indexValue: 12.5, amountCents: 0 },
    { ...base, id: "2", companyCode: "10", employeeCode: "17", eventCode: 37, indexValue: 0, amountCents: 31250 },
  ] });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.rows[0], { companyCode: 10, employeeCode: 17, reference: "2026-10-01", tipmov: "A", eventCode: 9,
    sequence: 0, indexValue: 12.5, amount: 0, eventType: 1, unit: "H" });
  assert.deepEqual(ok.rows[1], { companyCode: 10, employeeCode: 17, reference: "2026-10-01", tipmov: "A", eventCode: 37,
    sequence: 0, indexValue: 0, amount: 312.5, eventType: -1, unit: "V" });

  const bad = buildMovementExport({ competence: "2026-10", tipmov: "A", events, entries: [
    { ...base, id: "1", companyCode: "10", employeeCode: "17", eventCode: 9, indexValue: 1, amountCents: 0 },
    { ...base, id: "2", companyCode: "", employeeCode: "", eventCode: 55, indexValue: 0, amountCents: 100 },
  ] });
  assert.equal(bad.rows.length, 0);
  assert.deepEqual(bad.problems.map((problem) => problem.entryId), ["2", "2", "2"]);
});

test("colar do Excel entende tabulação, ponto e vírgula, horas e pula o cabeçalho", () => {
  const { rows, invalidLines } = parsePastedMovements("CODFUNC\tCODEVENTO\tINDICE\tVALOR\n17\t9\t12:30\t0\n23;37;0;312,50\nxx;9;1;0\n\n41\t120\t\t850");
  assert.deepEqual(rows, [
    { line: 2, companyCode: "", employeeCode: "17", eventCode: 9, indexValue: 12.5, amountCents: 0 },
    { line: 3, companyCode: "", employeeCode: "23", eventCode: 37, indexValue: 0, amountCents: 31250 },
    { line: 6, companyCode: "", employeeCode: "41", eventCode: 120, indexValue: 0, amountCents: 85000 },
  ]);
  assert.deepEqual(invalidLines, [4]);
});

test("colar do Excel com cinco colunas: CODEMP na frente", () => {
  const { rows, invalidLines } = parsePastedMovements("CODEMP\tCODFUNC\tCODEVENTO\tINDICE\tVALOR\n33\t17\t9\t2:30\t0\n033;23;37;0;312,50\nAB;23;37;0;1");
  assert.deepEqual(rows, [
    { line: 2, companyCode: "33", employeeCode: "17", eventCode: 9, indexValue: 2.5, amountCents: 0 },
    { line: 3, companyCode: "33", employeeCode: "23", eventCode: 37, indexValue: 0, amountCents: 31250 },
  ]);
  assert.deepEqual(invalidLines, [4]);
  // VALOR vazio no fim não faz o CODEMP virar CODFUNC.
  assert.deepEqual(pastedMovementCells("33\t17\t9\t2\t"), { companyCode: "33", employeeCode: "17", eventCode: "9", index: "2", amount: "" });
  assert.deepEqual(pastedMovementCells("17\t9\t2\t0"), { companyCode: "", employeeCode: "17", eventCode: "9", index: "2", amount: "0" });
  assert.equal(pastedMovementCells("CODFUNC;CODEVENTO"), null);
});

test("linha colada de outra empresa é recusada, não lançada na selecionada", () => {
  const goiania = { code: "33", name: "OPYT GOIANIA" };
  assert.equal(pastedCompanyMismatch("", goiania), null);
  assert.equal(pastedCompanyMismatch("033", goiania), null);
  assert.match(String(pastedCompanyMismatch("10", goiania)), /empresa 10, mas a empresa selecionada é OPYT GOIANIA \(33\)/u);
  assert.match(String(pastedCompanyMismatch("33", { code: "", name: "EVVIVA" })), /sem Código Sankhya/u);
  assert.match(String(pastedCompanyMismatch("x", goiania)), /inválido/u);
});

test("a migration cria as duas tabelas com RLS forçada e está no journal e no manifesto", async () => {
  const migration = await read("drizzle/postgres/0113_payroll_movements.sql");
  for (const table of ["fdp_payroll_event_catalog", "fdp_payroll_movement_entries"]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`, "u"));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`, "u"));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"));
  }
  assert.match(migration, /"index_value" > 0 OR "amount_cents" > 0/u);
  const journal = JSON.parse(await read("drizzle/postgres/meta/_journal.json")) as { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0113_payroll_movements"));
  assert.match(await read("lib/schema-manifest.ts"), /"0113_payroll_movements\.sql"/u);
});

test("as rotas exigem capacidade e escopo de empresa, e a exportação fica na auditoria", async () => {
  const lista = await read("app/api/payroll-movements/route.ts");
  assert.match(lista, /requireCapability\(workspace, "hr\.read"\)/u);
  assert.match(lista, /requireCapability\(workspace, "hr\.write"\)/u);
  assert.match(lista, /requireCompanyAccess/u);
  const exportacao = await read("app/api/payroll-movements/export/route.ts");
  assert.match(exportacao, /requireCapability\(workspace, "hr\.write"\)/u);
  assert.match(exportacao, /action: "payroll_movements\.exported"/u);
  assert.match(exportacao, /buildMovementExport/u);
  const catalogo = await read("app/api/payroll-movements/events/route.ts");
  assert.match(catalogo, /readEventCatalogWorkbook/u);
});

test("a tela Folha mostra o lançador", async () => {
  const app = await read("app/painel/WorkspaceApp.tsx");
  assert.match(app, /<PayrollMovementsPanel /u);
});

test("o lote colado guarda a ordem das linhas, e a SEQUENCIA segue essa ordem", async () => {
  // Com o default now(), todas as linhas do lote tinham o mesmo created_at e a
  // SEQUENCIA de duas linhas iguais caía no desempate pelo id aleatório.
  const lista = await read("app/api/payroll-movements/route.ts");
  assert.match(lista, /created_by, created_at\)\s+VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, clock_timestamp\(\)\)/u);
  assert.match(lista, /pastedCompanyMismatch\(/u);
  const ordered = assignSequences([
    { id: "b", companyCode: "33", employeeCode: "12", eventCode: 37, createdAt: "2026-10-21T10:00:00.000001Z" },
    { id: "a", companyCode: "33", employeeCode: "12", eventCode: 37, createdAt: "2026-10-21T10:00:00.000002Z" },
  ]);
  assert.deepEqual(ordered.map((row) => [row.id, row.sequence]), [["b", 0], ["a", 1]]);
});
