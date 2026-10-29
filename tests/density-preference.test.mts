import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { densityLabels, nextDensity, parseDensity } from "../lib/density.ts";

/**
 * Travas da camada ERP (docs/engenharia-reversa-design-centi-sap.md): a
 * densidade compacta do Fiori e a barra de status dos ERPs de gestão pública.
 */

const ler = (caminho: string) => readFile(new URL(`../${caminho}`, import.meta.url), "utf8");

test("valor guardado fora do vocabulário vira a densidade padrão", () => {
  for (const lixo of ["", "Compact", "cozy", "compacta", "../x", undefined, null]) {
    assert.equal(parseDensity(lixo as string | undefined), "comfortable", `"${String(lixo)}"`);
  }
  assert.equal(parseDensity("compact"), "compact");
  assert.equal(parseDensity("comfortable"), "comfortable");
});

test("o botão alterna entre as duas densidades e volta", () => {
  assert.equal(nextDensity("comfortable"), "compact");
  assert.equal(nextDensity(nextDensity("comfortable")), "comfortable");
  assert.deepEqual(Object.keys(densityLabels).sort(), ["comfortable", "compact"]);
});

test("a casca declara a densidade e a folha só reage a ela", async () => {
  const app = await ler("app/painel/WorkspaceApp.tsx");
  assert.match(app, /data-density=\{density\}/u);
  const css = await ler("app/design-centi-sap.css");
  assert.match(css, /\[data-density="compact"\]/u);
});

test("a camada ERP é carregada depois da camada de refinamento", async () => {
  const layout = await ler("app/layout.tsx");
  const refresh = layout.indexOf('import "./interface-refresh.css"');
  const erp = layout.indexOf('import "./design-centi-sap.css"');
  assert.ok(refresh >= 0 && erp > refresh, "design-centi-sap.css precisa vir depois de interface-refresh.css");
});

test("a camada ERP não escreve cor crua: só tokens da casca", async () => {
  const css = (await ler("app/design-centi-sap.css")).replace(/\/\*[\s\S]*?\*\//gu, "");
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/gu) ?? [], []);
});

test("a barra de status mostra entidade, exercício, competência, usuário e data", async () => {
  const app = await ler("app/painel/WorkspaceApp.tsx");
  const barra = app.slice(app.indexOf('className="dashboard-statusbar"'));
  assert.ok(barra.length > 0, "a barra de status sumiu da casca");
  const trecho = barra.slice(0, barra.indexOf("</footer>"));
  for (const rotulo of ["Entidade", "Empresa", "Exercício", "Competência", "Usuário", "Data"]) {
    assert.match(trecho, new RegExp(`<small>${rotulo}</small>`, "u"), `falta ${rotulo}`);
  }
});
