import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Obrigação legal ganha unidade opcional (0097_obligation_establishment.sql),
 * no mesmo padrão de `fdp_employees.establishment_id`
 * (0096_employee_establishment.sql, `tests/sankhya-catalog-xlsx.test.mts`):
 * coluna nula, sem migrar nenhuma obrigação existente.
 */

const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/postgres/0097_obligation_establishment.sql", import.meta.url), "utf8");
const criar = await readFile(new URL("../app/api/operations/obligations/route.ts", import.meta.url), "utf8");
const editar = await readFile(new URL("../app/api/operations/obligations/[id]/route.ts", import.meta.url), "utf8");
const overview = await readFile(new URL("../app/api/operations/overview/route.ts", import.meta.url), "utf8");
const dialogs = await readFile(new URL("../app/painel/features/operations/OperationDialogs.tsx", import.meta.url), "utf8");
const api = await readFile(new URL("../app/painel/features/operations/operations.api.ts", import.meta.url), "utf8");
const types = await readFile(new URL("../app/painel/features/operations/operations.types.ts", import.meta.url), "utf8");

test("a coluna é nova e nula: nenhuma obrigação existente é migrada", () => {
  assert.doesNotMatch(migration, /UPDATE\s+"?fdp_compliance_obligations"?/iu);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "establishment_id" text;/u);
  assert.match(migration, /fdp_compliance_obligations_workspace_establishment_fk/u);
});

test("o schema declara a FK, recortada por empresa como as demais", () => {
  assert.match(schema, /establishmentId: text\("establishment_id"\)/u);
  assert.match(schema, /fdp_compliance_obligations_workspace_establishment_fk/u);
});

test("criar e editar aceitam a unidade", () => {
  assert.match(criar, /establishmentId: cleanText\(body\.establishmentId, 120\) \|\| null/u);
  assert.match(criar, /card_id, establishment_id, obligation_type/u);
  assert.match(editar, /establishmentId: Object\.hasOwn\(body, "establishmentId"\) \? cleanText\(body\.establishmentId, 120\) \|\| null : current\.establishment_id/u);
  assert.match(editar, /owner_user_id = \?, establishment_id = \?/u);
});

test("a visão geral devolve a unidade da obrigação e a lista de unidades ativas para o formulário", () => {
  assert.match(overview, /card_id, establishment_id, notes/u);
  assert.match(overview, /FROM fdp_establishments WHERE workspace_id = \? AND company_id = \? AND status = 'active'/u);
  assert.match(overview, /establishments: establishments\.results/u);
});

test("o formulário de obrigação oferece a unidade como opcional", () => {
  assert.match(dialogs, /name="establishmentId"/u);
  assert.match(dialogs, /Não localizada/u);
});

test("os tipos e o normalizador do painel carregam a unidade ponta a ponta", () => {
  assert.match(types, /establishmentId: string; notes: string;/u);
  assert.match(types, /EstablishmentOption = \{ id: string; name: string \}/u);
  assert.match(api, /establishmentId: text\(value\(row, "establishmentId", "establishment_id"\)\)/u);
  assert.match(api, /normalizeEstablishment/u);
});
