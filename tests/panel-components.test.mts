import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { statusTone } from "../app/painel/features/shared/status-tone.ts";

/**
 * §16 pede componentes padronizados. Eles existiam — cada módulo tinha os
 * seus. O cabeçalho de painel estava definido três vezes, o estado vazio três,
 * o selo de status cinco e o aviso de erro dez, com `min-height` de 280px,
 * 310px e 330px para a mesma ideia, cinco ícones diferentes para o mesmo erro e
 * dois vocabulários incompatíveis de estado (`data-tone` e `data-status`).
 *
 * Este teste não confere aparência: confere que a definição é uma só. É a
 * garantia que falta quando o padrão vive num documento e não no código — a
 * próxima tela copia a cópia mais próxima, e a divergência volta.
 */

const FEATURES = new URL("../app/painel/features/", import.meta.url);
const modules = (await readdir(FEATURES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== "shared")
  .map((entry) => entry.name);

async function sourcesOf(module_: string) {
  const dir = new URL(`${module_}/`, FEATURES);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".tsx"));
  return Promise.all(files.map(async (name) => [name, await readFile(new URL(name, dir), "utf8")] as const));
}
const allSources = await Promise.all(modules.map(async (name) => [name, await sourcesOf(name)] as const));

test("nenhum módulo redefine um componente que o painel já tem", async () => {
  const shared = ["PanelHeader", "EmptyState", "LoadingState", "ErrorBanner", "StatusPill"];
  for (const [module_, files] of allSources) {
    for (const [file, source] of files) {
      for (const name of shared) {
        assert.doesNotMatch(source, new RegExp(`function ${name}\\s*\\(`, "u"),
          `${module_}/${file} redefine ${name} — importe de "../shared"`);
      }
    }
  }
});

test("o aviso de erro é sempre anunciado", async () => {
  // Duas das dez cópias anteriores não tinham `role="alert"`: o erro aparecia
  // na tela e nada era dito a quem usa leitor de tela. Com um componente só,
  // esquecer deixou de ser possível — mas só enquanto ninguém escrever outro.
  const shared = await readFile(new URL("shared/panel-ui.tsx", FEATURES), "utf8");
  assert.match(shared, /className=\{styles\.errorBanner\} role="alert"/u);

  for (const [module_, files] of allSources) {
    for (const [file, source] of files) {
      assert.doesNotMatch(source, /styles\.errorBanner/u,
        `${module_}/${file} desenha o próprio aviso de erro`);
    }
  }
});

test("o selo de status tem uma definição e um gancho estável de posicionamento", async () => {
  const shared = await readFile(new URL("shared/panel-ui.tsx", FEATURES), "utf8");
  // A classe vem de um CSS Module e é remapeada na compilação. Sem o atributo,
  // um seletor de posicionamento escrito noutro módulo — `.pendingLedger
  // article > .statusPill` — deixaria de casar sem erro nenhum, e a arrumação
  // em tela estreita sumiria em silêncio.
  assert.match(shared, /data-panel-ui="pill"/u);

  for (const [module_, files] of allSources) {
    for (const [file, source] of files) {
      assert.doesNotMatch(source, /styles\.statusPill|styles\.statusBadge/u,
        `${module_}/${file} desenha o próprio selo de status`);
    }
  }
});

test("nenhum CSS de módulo posiciona o selo por classe importada de fora", async () => {
  // O contrário do teste acima, visto do CSS: `.pendingLedger article >
  // .statusPill` continuaria compilando e nunca casaria.
  for (const module_ of modules) {
    const dir = new URL(`${module_}/`, FEATURES);
    for (const name of (await readdir(dir)).filter((file) => file.endsWith(".module.css"))) {
      const css = await readFile(new URL(name, dir), "utf8");
      const semComentarios = css.replace(/\/\*[\s\S]*?\*\//gu, "");
      for (const orfa of ["statusPill", "statusBadge", "emptyState", "errorBanner", "panelHeader"]) {
        if (module_ === "time" && orfa === "panelHeader") continue; // cabeçalho próprio, sem descrição
        assert.doesNotMatch(semComentarios, new RegExp(`\\.${orfa}\\b`, "u"),
          `${module_}/${name} ainda estiliza .${orfa}`);
      }
    }
  }
});

test("o mesmo estado tem o mesmo tom em qualquer módulo", () => {
  // O ponto do vocabulário compartilhado: quem opera Cadastros, Operações e
  // Benefícios no mesmo dia não pode aprender três significados para o verde.
  assert.equal(statusTone("approved"), "safe");
  assert.equal(statusTone("active"), "safe");
  assert.equal(statusTone("rejected"), "danger");
  assert.equal(statusTone("pending_approval"), "warning");
  // Cobrança entrou no mesmo mapa quando o módulo SaaS deixou de ter o seu.
  assert.equal(statusTone("past_due"), "warning");
  assert.equal(statusTone("uncollectible"), "danger");
  assert.equal(statusTone("trialing"), "safe");
  // O desconhecido é legível, não invisível: a versão anterior deixava o estado
  // sem regra herdar a cor do contêiner e "Aplicada" saía em 1.29:1.
  assert.equal(statusTone("estado_que_ninguem_previu"), "neutral");
});

test("o tom neutro do selo tem contraste de texto", async () => {
  // Verificado contra os pares `--ui-state-*`, que têm contrapartida no tema
  // escuro. O selo antigo de dois módulos usava `--ui-success` cru sobre um
  // `color-mix` da superfície — funcionava por coincidência de token.
  const css = await readFile(new URL("shared/panel-ui.module.css", FEATURES), "utf8");
  for (const par of ["neutral", "ok", "warn", "danger"]) {
    assert.match(css, new RegExp(`--ui-state-${par}-bg`, "u"));
    assert.match(css, new RegExp(`--ui-state-${par}-text`, "u"));
  }
});

test("o vocabulário de conector continua podendo divergir, e diz por quê", async () => {
  // Num canal externo, estado que o painel não reconhece é sinal — não ruído.
  // A divergência é legítima e por isso passa por `tone`, explícita, em vez de
  // uma segunda cópia do componente.
  const drawers = await readFile(new URL("integrations/IntegrationDrawers.tsx", FEATURES), "utf8");
  assert.match(drawers, /<StatusPill status=\{status\} tone=\{tone\}/u);
  assert.match(drawers, /o desconhecido aqui pede atenção/u);
});
