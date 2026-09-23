import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import { readSankhyaCatalogWorkbook } from "../lib/sankhya-catalog-xlsx.ts";
import { readSankhyaWorkScheduleWorkbook } from "../lib/sankhya-work-schedule-xlsx.ts";

/**
 * Os cadastros auxiliares (cargo, departamento, sindicato) ganharam
 * exportação do Sankhya do mesmo jeito que o colaborador já tinha —
 * ver lib/sankhya-catalog-xlsx.ts. Nenhum nome ou código aqui é real: a
 * estrutura da planilha (mesmos rótulos de coluna) é a que apareceu no
 * "Resultado da Query" de produção, com conteúdo fabricado.
 */

async function buildWorkbook(headerRow: string[], rows: Array<Array<string | number>>) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Resultado da Query");
  sheet.addRow(["Resultado da Query"]);
  sheet.addRow(["Emissão:22/09/2026 21:00:00", "Total de registros:" + rows.length]);
  sheet.addRow(headerRow);
  for (const row of rows) sheet.addRow(row);
  return (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
}

test("lê cargos do Sankhya, com CODCBO e ATIVO", async () => {
  const buffer = await buildWorkbook(
    ["CODCARGO", "DESCRCARGO", "CODCBO", "ATIVO"],
    [[1, "ANALISTA DE SISTEMAS", 212405, "S"], [2, "CARGO DESATIVADO", 0, "N"]],
  );
  const records = await readSankhyaCatalogWorkbook(buffer, "positions");
  assert.deepEqual(records, [
    { code: "1", name: "ANALISTA DE SISTEMAS", cboCode: "212405", status: "active" },
    { code: "2", name: "CARGO DESATIVADO", cboCode: "0", status: "inactive" },
  ]);
});

test("lê departamentos do Sankhya, sem CODCBO", async () => {
  const buffer = await buildWorkbook(["CODDEP", "DESCRDEP", "ATIVO"], [[1010000, "COMERCIAL", "S"]]);
  const records = await readSankhyaCatalogWorkbook(buffer, "departments");
  assert.deepEqual(records, [{ code: "1010000", name: "COMERCIAL", cboCode: "", status: "active" }]);
});

test("lê sindicatos do Sankhya, sem coluna ATIVO (assume ativo)", async () => {
  const buffer = await buildWorkbook(["CODSIND", "NOMESIND"], [[5, "SINDICATO EXEMPLO"]]);
  const records = await readSankhyaCatalogWorkbook(buffer, "unions");
  assert.deepEqual(records, [{ code: "5", name: "SINDICATO EXEMPLO", cboCode: "", status: "active" }]);
});

test("rejeita planilha sem os cabeçalhos esperados", async () => {
  const buffer = await buildWorkbook(["CODIGO", "DESCRICAO"], [[1, "X"]]);
  await assert.rejects(readSankhyaCatalogWorkbook(buffer, "positions"), /CODCARGO e DESCRCARGO/u);
});

test("rejeita código repetido na mesma planilha", async () => {
  const buffer = await buildWorkbook(["CODSIND", "NOMESIND"], [[5, "A"], [5, "B"]]);
  await assert.rejects(readSankhyaCatalogWorkbook(buffer, "unions"), /aparece mais de uma vez/u);
});

test("fdp_unions segue o mesmo desenho tenant-scoped dos outros cadastros auxiliares", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0094_registrations_unions_catalog.sql", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /export const unions = pgTable\("fdp_unions"/u);
  assert.match(migration, /ALTER TABLE "fdp_unions" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /CREATE POLICY "fdp_unions_workspace_isolation"/u);
  assert.match(migration, /fdp_unions_workspace_company_code_uq/u);
});

test("importação de catálogo exige a mesma capability e faz upsert por código", async () => {
  const route = await readFile(new URL("../app/api/registrations/catalogs/[resource]/import/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireCapability\(workspace, "registrations\.catalogs\.manage"\)/u);
  assert.match(route, /requireCompanyAccess/u);
  assert.match(route, /ON CONFLICT \(workspace_id, company_id, code\) DO UPDATE/u);
  assert.match(route, /positions: "positions", departments: "departments", unions: "unions"/u);
  assert.match(route, /key === "work-schedules"/u);
  // Centro de custo não tem planilha Sankhya equivalente ainda.
  assert.doesNotMatch(route, /"cost-centers":\s*"/u);
});

test("cadastro de sindicatos e jornadas aparece no painel com botão de importação Sankhya", async () => {
  const view = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");
  assert.match(view, /unions: \{ label: "Sindicatos"/u);
  assert.match(view, /catalogImportable: Partial<Record<CatalogResource, true>> = \{ positions: true, departments: true, unions: true, "work-schedules": true \}/u);
  assert.match(view, /CatalogImportDialog resource=\{catalogResource\}/u);
});

/**
 * A carga horária vem em formato bem diferente dos outros cadastros: uma
 * linha por dia da semana × turno, não uma linha por jornada. As colunas e a
 * forma dos dados (DIASEM 1=domingo, ENTRADA/SAÍDA em HHMM) reproduzem o
 * "Resultado da Query" real; os horários abaixo são fabricados.
 */

async function buildScheduleWorkbook(rows: Array<[number, number, number | string, number | string]>) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Resultado da Query");
  sheet.addRow(["Resultado da Query"]);
  sheet.addRow(["Emissão:22/09/2026 21:54:03", "Total de registros:" + rows.length]);
  sheet.addRow(["CODCARGAHOR", "DIASEM", "ENTRADA", "SAIDA", "TURNO", "DESCANSOSEM"]);
  for (const [code, diasem, entrada, saida] of rows) sheet.addRow([code, diasem, entrada, saida, 1, entrada === "" ? "S" : "N"]);
  return (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
}

test("soma segunda a sexta 8h-12h e 14h-18h, sábado 8h-12h, para 44h semanais", async () => {
  const buffer = await buildScheduleWorkbook([
    [1, 1, "", ""], // domingo, folga
    [1, 2, 800, 1200], [1, 2, 1400, 1800],
    [1, 3, 800, 1200], [1, 3, 1400, 1800],
    [1, 4, 800, 1200], [1, 4, 1400, 1800],
    [1, 5, 800, 1200], [1, 5, 1400, 1800],
    [1, 6, 800, 1200], [1, 6, 1400, 1800],
    [1, 7, 800, 1200],
  ]);
  const [record] = await readSankhyaWorkScheduleWorkbook(buffer);
  assert.equal(record.code, "1");
  assert.equal(record.weeklyHours, 44);
  assert.equal(record.name, "44h semanais");
  assert.equal(record.description, "Seg a Sex: 08:00–12:00 e 14:00–18:00 · Sáb: 08:00–12:00");
});

test("horário quebrado (não múltiplo de hora) aparece na descrição e arredonda nas horas semanais", async () => {
  const buffer = await buildScheduleWorkbook([
    [2, 2, 800, 1200], [2, 2, 1330, 1800],
    [2, 3, 800, 1200], [2, 3, 1330, 1800],
    [2, 4, 800, 1200], [2, 4, 1330, 1800],
    [2, 5, 800, 1200], [2, 5, 1330, 1800],
    [2, 6, 800, 1200], [2, 6, 1330, 1800],
  ]);
  const [record] = await readSankhyaWorkScheduleWorkbook(buffer);
  assert.equal(record.weeklyHours, 43); // 42.5h arredondado
  assert.equal(record.name, "42h30 semanais");
  assert.equal(record.description, "Seg a Sex: 08:00–12:00 e 13:30–18:00");
});

test("linhas sem horário (folga) não entram na conta nem na descrição", async () => {
  const buffer = await buildScheduleWorkbook([
    [3, 1, "", ""], [3, 7, "", ""],
    [3, 2, 900, 1300], [3, 3, 900, 1300], [3, 4, 900, 1300], [3, 5, 900, 1300], [3, 6, 900, 1300],
  ]);
  const [record] = await readSankhyaWorkScheduleWorkbook(buffer);
  assert.equal(record.weeklyHours, 20);
  assert.equal(record.description, "Seg a Sex: 09:00–13:00");
});

test("hora semanal fica dentro de 1 e 60 mesmo sem nenhum turno com horário", async () => {
  const buffer = await buildScheduleWorkbook([[0, 1, "", ""]]);
  await assert.rejects(readSankhyaWorkScheduleWorkbook(buffer), /Nenhuma jornada/u);
});

test("jornada rejeita planilha sem os cabeçalhos esperados", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Resultado da Query");
  sheet.addRow(["CODIGO", "DESCRICAO"]);
  sheet.addRow([1, "X"]);
  const buffer = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  await assert.rejects(readSankhyaWorkScheduleWorkbook(buffer), /CODCARGAHOR, DIASEM, ENTRADA, SAIDA/u);
});
