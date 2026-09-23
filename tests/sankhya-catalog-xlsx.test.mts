import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import { readSankhyaCatalogWorkbook } from "../lib/sankhya-catalog-xlsx.ts";

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
  // Centro de custo e jornada não têm planilha Sankhya equivalente ainda.
  assert.doesNotMatch(route, /"cost-centers":\s*"/u);
});

test("cadastro de sindicatos aparece no painel com botão de importação Sankhya", async () => {
  const view = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");
  assert.match(view, /unions: \{ label: "Sindicatos"/u);
  assert.match(view, /catalogImportable: Partial<Record<CatalogResource, true>> = \{ positions: true, departments: true, unions: true \}/u);
  assert.match(view, /CatalogImportDialog resource=\{catalogResource\}/u);
});
