import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Foco de diálogo e atalho para o conteúdo (WCAG 2.4.1, 2.4.3).
 *
 * Medido no navegador antes da correção: na gaveta de Nova demanda
 * (`aria-modal="true"`), o 28º Tab levava o foco para o `<body>`, e o Esc
 * devolvia o foco a um indicador da página, não ao botão que abriu a gaveta.
 * A guarda global corrige para todo diálogo modal; estes testes impedem que
 * ela saia do layout ou volte a calcular visibilidade por `offsetParent`.
 */
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("o layout raiz monta a guarda de foco para todas as áreas", async () => {
  const layout = await read("app/layout.tsx");
  assert.match(layout, /import \{ ModalFocusGuard \} from "\.\/components\/ModalFocusGuard"/u);
  assert.match(layout, /<ModalFocusGuard \/>/u);
});

test("a guarda prende o Tab no diálogo do topo e devolve o foco a quem abriu", async () => {
  const guard = await read("app/components/ModalFocusGuard.tsx");
  assert.match(guard, /\[role="dialog"\]\[aria-modal="true"\]/u);
  assert.match(guard, /getClientRects\(\)\.length > 0/u, "visibilidade real, não offsetParent");
  assert.doesNotMatch(guard, /\.offsetParent\b/u, "offsetParent trata como invisível o que está em pai fixo");
  assert.match(guard, /window\.addEventListener\("keydown", onKeyDown, true\)/u, "age antes dos diálogos (captura na janela)");
  assert.match(guard, /restore\.focus\(/u, "devolve o foco ao gatilho");
  assert.match(guard, /new MutationObserver/u, "percebe diálogo que abre e fecha sem avisar");
});

test("o painel oferece Pular para o conteúdo e o primeiro Tab começa do topo", async () => {
  const app = await read("app/painel/WorkspaceApp.tsx");
  assert.match(app, /<a className="skip-link" href="#conteudo-painel">Pular para o conteúdo<\/a>/u);
  assert.match(app, /className="dashboard-content" id="conteudo-painel" tabIndex=\{-1\}/u);
  assert.match(app, /document\.activeElement !== document\.body\) return;\n\s*const skip = document\.querySelector<HTMLAnchorElement>\("\.skip-link"\)/u);
  const css = await read("app/vinculato-shell.css");
  assert.match(css, /\.skip-link:focus-visible/u);
});
