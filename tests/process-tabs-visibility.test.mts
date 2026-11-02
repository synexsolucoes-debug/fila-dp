import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Só a tela visível desenha abas no cabeçalho do processo.
 *
 * Medido no navegador: abrir Gestão de EPI e depois Desenho de processos
 * deixava as dez abas do EPI em cima de Processos. O painel guarda escondidas
 * as telas já visitadas (`keepAlive`), e o portal das abas ignora o `hidden`
 * do pai.
 */
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("o portal das abas respeita a tela visível", async () => {
  const tabs = await read("app/painel/features/shared/process-tabs.tsx");
  assert.match(tabs, /export const ViewPaneActiveContext = createContext\(true\)/u);
  assert.match(tabs, /return node && active \? createPortal\(children, node\) : null;/u);
});

test("cada tela guardada informa se é a visível", async () => {
  const app = await read("app/painel/WorkspaceApp.tsx");
  assert.match(app, /hidden=\{target !== view\}>\s*<ViewPaneActiveContext\.Provider value=\{target === view && !erpMode\}>/u);
  assert.match(app, /hidden=\{!erpMode\}><ViewPaneActiveContext\.Provider value=\{erpMode\}>/u);
});

test("os módulos do painel são carregados sob demanda", async () => {
  const app = await read("app/painel/WorkspaceApp.tsx");
  for (const view of ["EpiControlView", "PaymentsView", "ProcessManagementView", "ErpDpView", "RegistrationsView", "LedgerView"]) {
    assert.match(app, new RegExp(`const ${view} = dynamic\\(\\(\\) => import\\(`, "u"), `${view} voltou a ser importado de forma estática`);
  }
  assert.doesNotMatch(app, /^import \{ PaymentsView/mu);
});
