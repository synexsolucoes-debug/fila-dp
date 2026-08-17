import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { areaModuleList } from "../lib/areas.ts";

test("departamentos aceitam módulos do catálogo sem perder o roteamento SESMT e DP", () => {
  assert.deepEqual(
    areaModuleList(["epi", "registrations", "epi.owner", "epi.discount_analysis", "epi"], ["epi", "registrations"]),
    ["epi", "registrations", "epi.owner", "epi.discount_analysis"],
  );
  assert.throws(
    () => areaModuleList(["modulo-inventado"], ["epi"]),
    /Roteamento de módulo inválido/u,
  );
});

test("API entrega o catálogo real e valida as chaves antes de persistir", async () => {
  const [collection, detail] = await Promise.all([
    readFile(new URL("../app/api/areas/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/areas/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(collection, /getWorkspaceModules\(d1, workspace\.id, "admin"/u);
  assert.match(collection, /modules: modules\.map/u);
  for (const source of [collection, detail]) {
    assert.match(source, /SELECT key FROM fdp_modules/u);
    assert.match(source, /areaModuleList\(body\.moduleKeys, catalog\.results/u);
  }
});

test("tela separa módulos do departamento do roteamento operacional", async () => {
  const [panel, registrations] = await Promise.all([
    readFile(new URL("../app/painel/features/registrations/AreasPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(registrations, /Departamentos e módulos/u);
  assert.match(panel, /Módulos do departamento/u);
  assert.match(panel, /name="departmentModules" value=\{module\.key\}/u);
  assert.match(panel, /Roteamento SESMT → DP/u);
});

test("SESMT existente recebe o módulo de EPI sem sobrescrever associação manual", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0046_department_module_backfill.sql", import.meta.url), "utf8");
  assert.match(migration, /SELECT "workspace_id", 'epi', "area_id", "created_by"/u);
  assert.match(migration, /WHERE "module_key" = 'epi\.owner'/u);
  assert.match(migration, /ON CONFLICT \("workspace_id", "module_key"\) DO NOTHING/u);
});
