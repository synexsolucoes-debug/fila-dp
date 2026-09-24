import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildEpiCompliance } from "../lib/epi-compliance.ts";

/**
 * Unidade entra como terceira dimensão de escopo da regra de EPI obrigatório
 * (0099_epi_requirement_establishment.sql), ao lado de departamento e cargo
 * (0048_epi_compliance.sql). Obra e escritório da mesma empresa podem exigir
 * EPIs diferentes para o mesmo cargo; até aqui a única saída era duplicar o
 * cargo por endereço.
 *
 * NULL continua significando "qualquer unidade" — mesma semântica que
 * departamento e cargo em branco já tinham.
 */

const migration = await readFile(new URL("../drizzle/postgres/0099_epi_requirement_establishment.sql", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const criar = await readFile(new URL("../app/api/epi/requirements/route.ts", import.meta.url), "utf8");
const porColaborador = await readFile(new URL("../app/api/epi/employees/[id]/route.ts", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../app/api/epi/dashboard/route.ts", import.meta.url), "utf8");
const relatorio = await readFile(new URL("../app/api/epi/reports/route.ts", import.meta.url), "utf8");
const painel = await readFile(new URL("../app/painel/features/epi/EpiCompliancePanels.tsx", import.meta.url), "utf8");

test("a coluna é nova e nula: nenhuma regra existente é migrada", () => {
  assert.doesNotMatch(migration, /UPDATE\s+"?fdp_epi_requirements"?/iu);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "establishment_id" text;/u);
  assert.match(migration, /fdp_epi_requirements_establishment_fk/u);
});

test("a unicidade da regra agora considera a unidade, sem quebrar nenhuma regra existente", () => {
  // Toda regra existente tem unidade nula; o índice novo é uma restrição
  // adicional sobre a mesma chave, nunca menos restritivo que o anterior.
  assert.match(migration, /DROP INDEX IF EXISTS "fdp_epi_requirements_scope_product_uq"/u);
  assert.match(migration, /COALESCE\("department_id", ''\)[\s\S]{0,20}COALESCE\("position_id", ''\)[\s\S]{0,20}COALESCE\("establishment_id", ''\)/u);
});

test("o schema declara a FK e o índice único com a unidade", () => {
  assert.match(schema, /establishmentId: text\("establishment_id"\)/u);
  assert.match(schema, /fdp_epi_requirements_establishment_fk/u);
  assert.match(schema, /sql`COALESCE\(\$\{table\.positionId\}, ''\)`, sql`COALESCE\(\$\{table\.establishmentId\}, ''\)`, table\.productId/u);
});

test("criar valida a unidade contra a empresa e recusa duplicar a mesma regra na mesma unidade", () => {
  assert.match(criar, /establishmentId: cleanText\(body\.establishmentId, 120\) \|\| null/u);
  assert.match(criar, /A unidade não pertence à empresa selecionada/u);
  assert.match(criar, /establishment_id IS NOT DISTINCT FROM \?/u);
  assert.match(criar, /department_id, position_id, establishment_id, product_id/u);
});

test("o cálculo por colaborador e o dashboard recortam a regra também pela unidade dele", () => {
  assert.match(porColaborador, /AND \(r\.establishment_id IS NULL OR r\.establishment_id = e\.establishment_id\)/u);
  assert.match(porColaborador, /establishmentId: String\(employee\.establishment_id \?\? ""\)/u);
  assert.match(dashboard, /e\.establishment_id/u);
  assert.match(dashboard, /establishmentId: asText\(row\.establishment_id\)/u);
});

test("o relatório agregado usa a mesma precedência: regra específica por unidade vence a genérica", () => {
  assert.match(relatorio, /AND \(candidate\.establishment_id IS NULL OR candidate\.establishment_id = e\.establishment_id\)/u);
  assert.match(relatorio, /CASE WHEN candidate\.establishment_id IS NULL THEN 0 ELSE 1 END/u);
});

test("o formulário de regra oferece a unidade, travada na edição como as outras dimensões", () => {
  assert.match(painel, /UNIDADE<\/span><select value=\{establishmentId\}/u);
  assert.match(painel, /disabled=\{Boolean\(requirement\)\}/u);
});

/* -------------------------------------------------------------------------- */
/* A função pura: unidade é mais uma dimensão de especificidade                */
/* -------------------------------------------------------------------------- */

test("regra amarrada a uma unidade só se aplica a quem está naquela unidade", () => {
  const employees = [
    { id: "obra", companyId: "c1", name: "Ana", registrationNumber: "1", departmentId: "", departmentName: "", positionId: "", positionName: "", establishmentId: "obra" },
    { id: "escritorio", companyId: "c1", name: "Bruno", registrationNumber: "2", departmentId: "", departmentName: "", positionId: "", positionName: "", establishmentId: "escritorio" },
  ];
  const requirements = [{
    id: "r1", companyId: "c1", departmentId: "", departmentName: "", positionId: "", positionName: "",
    establishmentId: "obra", productId: "capacete", productName: "Capacete", caNumber: "1", caExpiresOn: "", productExpiresOn: "",
    quantity: 1, replacementDays: 0, warningDays: 30,
  }];
  const compliance = buildEpiCompliance(employees, requirements, [], "2026-06-01");
  assert.equal(compliance[0].status, "missing", "a obra exige o capacete e ninguém entregou");
  assert.equal(compliance[1].status, "unconfigured", "o escritório não tem nenhuma regra que se aplique a ele");
});

test("regra específica por unidade vence a regra geral do mesmo produto", () => {
  const employee = { id: "e1", companyId: "c1", name: "Ana", registrationNumber: "1", departmentId: "", departmentName: "", positionId: "", positionName: "", establishmentId: "obra" };
  const geral = {
    id: "geral", companyId: "c1", departmentId: "", departmentName: "", positionId: "", positionName: "",
    establishmentId: "", productId: "luva", productName: "Luva", caNumber: "", caExpiresOn: "", productExpiresOn: "",
    quantity: 1, replacementDays: 0, warningDays: 30,
  };
  const especifica = { ...geral, id: "especifica", establishmentId: "obra", quantity: 2 };
  const compliance = buildEpiCompliance([employee], [geral, especifica], [
    { employeeId: "e1", productId: "luva", quantity: 1, lastDeliveredOn: "2026-01-01" },
  ], "2026-06-01");
  assert.equal(compliance[0].items.length, 1, "a regra geral e a específica são o mesmo produto, não duas exigências");
  assert.equal(compliance[0].items[0].requirementId, "especifica");
  assert.equal(compliance[0].items[0].requiredQuantity, 2);
});

test("colaborador sem unidade só casa com regra que também vale para qualquer unidade", () => {
  const employee = { id: "e1", companyId: "c1", name: "Ana", registrationNumber: "1", departmentId: "", departmentName: "", positionId: "", positionName: "", establishmentId: "" };
  const requirement = {
    id: "r1", companyId: "c1", departmentId: "", departmentName: "", positionId: "", positionName: "",
    establishmentId: "obra", productId: "capacete", productName: "Capacete", caNumber: "", caExpiresOn: "", productExpiresOn: "",
    quantity: 1, replacementDays: 0, warningDays: 30,
  };
  const compliance = buildEpiCompliance([employee], [requirement], [], "2026-06-01");
  assert.equal(compliance[0].status, "unconfigured", "colaborador sem unidade não deve herdar a regra de uma unidade específica");
});
