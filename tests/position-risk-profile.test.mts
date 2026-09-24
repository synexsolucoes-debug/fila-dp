import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Cargo rico, passo 1 (0098_position_risk_profile.sql): grau de risco e
 * atividades especiais ao lado do CBO que já existe em fdp_positions
 * (0013_registrations_foundation.sql). A análise de produto de set/2026
 * nomeou isto como base da Matriz de Requisitos e do módulo de SESMT — sem
 * saber o risco e as atividades especiais de um cargo, não há como decidir
 * depois quais exames ocupacionais ou treinamentos ele exige.
 *
 * Os dois campos entram sem taxonomia fixa nem regra automática, exatamente
 * como o próprio CBO já é tratado: texto livre digitado por quem cadastra,
 * consumido hoje só pela própria tela de cadastro de cargo.
 */

const migration = await readFile(new URL("../drizzle/postgres/0098_position_risk_profile.sql", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const criar = await readFile(new URL("../app/api/registrations/catalogs/[resource]/route.ts", import.meta.url), "utf8");
const editar = await readFile(new URL("../app/api/registrations/catalogs/[resource]/[id]/route.ts", import.meta.url), "utf8");
const view = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");
const types = await readFile(new URL("../app/painel/features/registrations/registrations.types.ts", import.meta.url), "utf8");

test("as colunas são novas, com default seguro, e nenhum cargo existente é migrado", () => {
  assert.doesNotMatch(migration, /UPDATE\s+"?fdp_positions"?/iu);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "risk_level" text DEFAULT 'none' NOT NULL;/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "special_activities" text DEFAULT '' NOT NULL;/u);
});

test("o grau de risco é restrito a um vocabulário fechado, tanto no banco quanto no schema", () => {
  assert.match(migration, /CHECK \("risk_level" IN \('none', 'low', 'medium', 'high'\)\)/u);
  assert.match(schema, /riskLevel: text\("risk_level"\)\.notNull\(\)\.default\("none"\)/u);
  assert.match(schema, /fdp_positions_risk_level_check/u);
});

test("criar e editar cargo aceitam risco e atividades especiais, com o mesmo tratamento do CBO", () => {
  assert.match(criar, /enumValue\(body\.riskLevel, positionRiskLevels, "none"\)/u);
  assert.match(criar, /cleanText\(body\.specialActivities, 500\)/u);
  assert.match(criar, /cbo_code, risk_level, special_activities/u);
  assert.match(editar, /Object\.hasOwn\(body, "riskLevel"\) \? enumValue\(body\.riskLevel, positionRiskLevels, "none"\) : current\.risk_level/u);
  assert.match(editar, /Object\.hasOwn\(body, "specialActivities"\) \? cleanText\(body\.specialActivities, 500\) : current\.special_activities/u);
});

test("a listagem de cargos devolve risco e atividades especiais junto com o CBO", () => {
  assert.match(criar, /", cbo_code, risk_level, special_activities" : key === "work-schedules"/u);
});

test("o cadastro de cargo mostra e edita o grau de risco e as atividades especiais", () => {
  assert.match(view, /<span>Grau de risco<\/span><select value=\{riskLevel\}/u);
  assert.match(view, /<span>Atividades especiais<\/span><input value=\{specialActivities\}/u);
  assert.match(view, /riskLevelLabels\[item\.riskLevel\]/u);
});

test("os tipos do painel carregam o grau de risco como um vocabulário fechado", () => {
  assert.match(types, /riskLevel: "none" \| "low" \| "medium" \| "high";/u);
  assert.match(types, /specialActivities: string;/u);
});

test("a importação do Sankhya não sobrescreve risco nem atividades especiais de um cargo já cadastrado", async () => {
  // O Sankhya não tem este dado: importar de novo não pode apagar o que foi
  // preenchido manualmente na tela.
  const importRoute = await readFile(new URL("../app/api/registrations/catalogs/[resource]/import/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(importRoute, /risk_level|special_activities/u);
});
