import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §13: o design system precisa ser uma restrição, não um documento.
 *
 * A medição que motivou este arquivo: 149 valores de cor escritos à mão nos CSS
 * de módulo, fora de qualquer token. Trinta e oito deles eram `#fff`, seis eram
 * exatamente `--ui-danger`, e o violeta de Psicologia estava declarado em três
 * arquivos diferentes — mudar a cor de um módulo significava achar todas as
 * cópias, e a que sobrasse ficaria fora de tom sem avisar ninguém.
 *
 * O teto abaixo é por módulo e só pode descer. Não é uma meta: é a garantia de
 * que a dívida medida hoje não cresce enquanto ninguém olha. Um valor novo
 * escrito à mão reprova o build e obriga a decisão a ser explícita — ou vira
 * token, ou o teto sobe por escrito, com o motivo no diff.
 */

const FEATURES = new URL("../app/painel/features/", import.meta.url);

/** Teto de cor crua por módulo. Descer é livre; subir exige justificativa no diff. */
const TETO: Record<string, number> = {
  saas: 36,
  auxiliary: 15,
  /* De 14 para 3: a conversão da faixa do ciclo para a casca clara tirou o
     último bolsão do verde da marca antiga (#38d6a7 e parentes) e as cores de
     superfície escura que ela carregava. A catraca cobrou a descida — é para
     isso que ela existe. */
  operations: 3,
  access: 13,
  integrations: 10,
  assistant: 8,
  registrations: 4,
  payments: 2,
  time: 1,
  "action-center": 0,
  shared: 0,
};

/** Cor crua = literal que não é o valor de reserva de um token. */
function rawColors(css: string) {
  const semComentario = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  // `var(--token, #fallback)` é legítimo: o literal ali espelha o token e
  // existe para o caso de ele não ter sido definido.
  const semFallback = semComentario.replace(/var\(\s*--[\w-]+\s*,\s*[^)]*\)/gu, "VAR");
  return semFallback.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
}

const modules = (await readdir(FEATURES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name);

const contagem = new Map<string, number>();
for (const module_ of modules) {
  const dir = new URL(`${module_}/`, FEATURES);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".module.css"));
  let total = 0;
  for (const name of files) total += rawColors(await readFile(new URL(name, dir), "utf8")).length;
  contagem.set(module_, total);
}

test("nenhum módulo escreve mais cor crua do que o teto medido", () => {
  const acima: string[] = [];
  for (const [module_, total] of contagem) {
    const teto = TETO[module_] ?? 0;
    if (total > teto) acima.push(`${module_}: ${total} (teto ${teto})`);
  }
  assert.deepEqual(acima, [],
    "cor nova escrita à mão. Use um token de app/dashboard-modern.css, ou suba o teto no diff dizendo por quê");
});

test("o teto acompanha a realidade: se um módulo melhorou, o número desce junto", () => {
  // Sem isto o teto vira folga acumulada: alguém limpa vinte cores, o teto
  // continua no valor antigo e as vinte podem voltar sem reprovar nada.
  const folgados: string[] = [];
  for (const [module_, total] of contagem) {
    const teto = TETO[module_] ?? 0;
    if (teto - total > 2) folgados.push(`${module_}: ${total} usado(s), teto ${teto} — abaixe o teto`);
  }
  assert.deepEqual(folgados, []);
});

test("as cores de módulo têm um dono só", async () => {
  // O violeta de Psicologia estava escrito em três arquivos e o âmbar de
  // Prestadores PJ em dois. Agora moram num token, e quem precisa deles o lê.
  const shell = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  for (const token of ["--module-psychology", "--module-contractors", "--on-dark-soft",
    "--on-dark-line", "--on-dark-veil", "--on-dark-confirm", "--ink-shadow", "--ink-scrim"]) {
    assert.match(shell, new RegExp(`${token}:`, "u"), `${token} não está declarado`);
  }
  for (const [module_, literal] of [["auxiliary", "#6550a1"], ["integrations", "#6550a1"],
    ["payments", "#9a5c20"], ["operations", "#b9c9d8"]] as const) {
    const dir = new URL(`${module_}/`, FEATURES);
    for (const name of (await readdir(dir)).filter((file) => file.endsWith(".module.css"))) {
      assert.doesNotMatch(await readFile(new URL(name, dir), "utf8"), new RegExp(literal, "u"),
        `${module_} ainda escreve ${literal} à mão`);
    }
  }
});

test("o acento do módulo alcança os componentes compartilhados", async () => {
  // Psicologia e Prestadores PJ trocam o acento. A troca era feita só no alias
  // local, e o estado vazio e o selo — que agora vêm do módulo compartilhado —
  // leem o token semântico: a tela sairia com cabeçalho violeta e ícone azul.
  for (const module_ of ["auxiliary", "payments"]) {
    const css = await readFile(new URL(`${module_}/${module_}.module.css`, FEATURES), "utf8");
    assert.match(css, /\[data-module="psychology"\] \{ --ui-accent: var\(--module-psychology\)/u,
      `${module_} troca o acento sem alcançar os componentes compartilhados`);
    assert.match(css, /\[data-module="contractors"\] \{ --ui-accent: var\(--module-contractors\)/u);
  }
});

test("a escala semântica não é redeclarada por módulo", async () => {
  // `--saas-green/amber/red` eram `--ui-success/warning/danger` copiados, nos
  // dois temas — inclusive com um bloco de tema escuro só para repetir o que o
  // token já fazia sozinho.
  const saas = await readFile(new URL("saas/saas.module.css", FEATURES), "utf8");
  assert.match(saas, /--saas-green: var\(--ui-success\)/u);
  assert.match(saas, /--saas-amber: var\(--ui-warning\)/u);
  assert.match(saas, /--saas-red: var\(--ui-danger\)/u);
  const dark = saas.slice(saas.indexOf(":global(.theme-dark) .workspace"));
  assert.doesNotMatch(dark.slice(0, 200), /--saas-(green|amber|red)/u,
    "o tema escuro não precisa repetir o que o token já resolve");
});

test("o acento de módulo separa preenchimento de texto, com contrapartida no escuro", async () => {
  // Este teste existe por causa de um defeito que eu mesmo introduzi e que a
  // conferência de acessibilidade pegou: ao propagar o acento do módulo para o
  // token semântico, usei o mesmo violeta para preenchimento e para texto. No
  // tema claro passa (6.53:1 sobre branco); no escuro o cabeçalho de Psicologia
  // caiu para 2.49:1. O sistema já sabia disso — `--ui-accent` e
  // `--ui-accent-text` são separados exatamente porque texto sobre superfície
  // escura precisa clarear mais que preenchimento — e o acento de módulo tinha
  // ficado de fora da regra.
  const shell = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  for (const nome of ["psychology", "contractors"]) {
    assert.match(shell, new RegExp(`--module-${nome}-text: #`, "u"));
    const dark = shell.slice(shell.indexOf("Contrapartida escura dos acentos de módulo"));
    assert.match(dark.slice(0, 400), new RegExp(`--module-${nome}-text: #`, "u"),
      `${nome} não tem cor de texto para o tema escuro`);
    assert.match(dark.slice(0, 400), new RegExp(`--module-${nome}-soft: #`, "u"));
  }
  for (const module_ of ["auxiliary", "payments"]) {
    const css = await readFile(new URL(`${module_}/${module_}.module.css`, FEATURES), "utf8");
    assert.match(css, /--ui-accent-text: var\(--module-psychology-text\)/u,
      `${module_} usa o preenchimento como cor de texto`);
    assert.match(css, /--ui-accent-text: var\(--module-contractors-text\)/u);
  }
});
