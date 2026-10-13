import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { workItemSources } from "../lib/work-items.ts";

/**
 * Regra do produto (§4.30): o que é ERP fica no ERP, e o que é Vinculato fica
 * no Vinculato.
 *
 * O modo ERP DP lê as mesmas tabelas, mas as telas não se misturam: nenhuma
 * tela do Vinculato mostra Vida funcional, Contrato, correção de registro,
 * prazos contratuais, retorno de afastamento ou retroativos — e o ERP não
 * escreve nas Pendências da Operação DP. A única porta entre os dois é o
 * botão de troca no canto superior direito.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const FEATURES = new URL("../app/painel/features/", import.meta.url);

/** Os termos que só existem no ERP DP. */
const ERP_ONLY = [
  /Vida funcional/u, /FunctionalHistoryPanel/u, /ContractPanel/u, /CorrectionPanel/u, /historyMode/u,
  /return_to_work/u, /Retorno de afastamento/u, /Prazos contratuais/u, /erp-dp\//u, /fdp_erp_retroactive_items/u,
  /RemunerationPanel/u, /CalculationsPanel/u, /PayrollRunPanel/u, /\/api\/erp-dp\/payroll-runs/u, /payroll-calc/u, /\/api\/erp-dp\/calculations/u, /\/remuneration/u,
];

test("nenhuma tela do Vinculato importa ou mostra o que é do ERP DP", async () => {
  const vinculatoModules = (await readdir(FEATURES, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "erp-dp").map((entry) => entry.name);
  const leaks: string[] = [];
  for (const module_ of vinculatoModules) {
    const dir = new URL(`${module_}/`, FEATURES);
    for (const name of (await readdir(dir)).filter((file) => /\.(tsx?|css)$/u.test(file))) {
      const source = await readFile(new URL(name, dir), "utf8");
      for (const term of ERP_ONLY) if (term.test(source)) leaks.push(`${module_}/${name}: ${term.source}`);
    }
  }
  assert.deepEqual(leaks, []);
});

test("as telas do ERP moram na pasta do ERP", async () => {
  const files = await readdir(new URL("erp-dp/", FEATURES));
  for (const name of ["ErpDpView.tsx", "ErpFunctionalHistoryPanel.tsx", "ErpContractPanel.tsx", "ErpCorrectionPanel.tsx",
    "ErpRemunerationPanel.tsx", "ErpCalculationsPanel.tsx", "ErpPayrollRunPanel.tsx"]) {
    assert.ok(files.includes(name), `${name} fora de features/erp-dp`);
  }
  // E não puxam CSS do Vinculato.
  for (const name of files.filter((file) => file.endsWith(".tsx"))) {
    assert.doesNotMatch(await read(`app/painel/features/erp-dp/${name}`), /\.\.\/registrations\//u, name);
  }
});

test("o painel só conhece o ERP pela troca de modo", async () => {
  const app = await read("app/painel/WorkspaceApp.tsx");
  const mentions = app.match(/ErpDpView/gu) ?? [];
  // Um import e um uso — atrás de `erpMode`.
  assert.equal(mentions.length, 2);
  assert.match(app, /erpMode \? <ErpDpView /u);
});

test("a Central de Trabalho do Vinculato não recebe prazos do ERP", () => {
  const keys = workItemSources.map((source) => source.key as string);
  assert.ok(!keys.some((key) => /contract|notice/u.test(key)), keys.join(", "));
});

test("retroativo é do ERP: tabela própria, fora das Pendências da Operação DP", async () => {
  const migration = await read("drizzle/postgres/0110_erp_dp_separation.sql");
  assert.match(migration, /CREATE TABLE "fdp_erp_retroactive_items"/u);
  // Os que a versão anterior gravou como pendência são copiados e dispensados lá — nada apagado.
  assert.match(migration, /INSERT INTO "fdp_erp_retroactive_items"[\s\S]+WHERE p\."idempotency_key" LIKE 'retro:%'/u);
  assert.match(migration, /SET "status" = 'waived', "resolution" = 'Movido para Retroativos do ERP DP'/u);
  assert.doesNotMatch(migration, /DELETE FROM/u);
  for (const path of ["app/api/operations/movements/[id]/apply/route.ts", "lib/erp-dp-service.ts",
    "app/api/erp-dp/retroactivity/route.ts", "app/api/erp-dp/overview/route.ts"]) {
    assert.doesNotMatch(await read(path), /fdp_operational_pending_items/u, path);
  }
});

test("a Operação DP do Vinculato não oferece retorno de afastamento: é medida do ERP", async () => {
  for (const path of ["app/painel/features/operations/OperationDialogs.tsx", "app/painel/features/operations/OperationsView.tsx",
    "app/painel/features/operations/operations.types.ts", "app/painel/features/operations/operations.api.ts"]) {
    assert.doesNotMatch(await read(path), /return_to_work/u, path);
  }
  assert.match(await read("app/api/erp-dp/actions/return-to-work/route.ts"), /export async function POST/u);
});
