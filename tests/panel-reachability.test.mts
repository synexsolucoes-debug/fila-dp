import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Telas construídas e sem porta.
 *
 * Este arquivo existe porque descobri duas por acidente, em dias diferentes da
 * mesma auditoria:
 *
 *  - oito seções de configurações, fechadas de propósito em `d2d8d5a`;
 *  - o módulo SaaS inteiro — plano, faturas, cotas, sequência de ativação —,
 *    que nada renderiza e para o qual não achei decisão registrada.
 *
 * A segunda só apareceu porque coloquei um botão dentro dela e fui conferir no
 * navegador. O botão não aparecia. Se eu tivesse confiado no código, teria
 * publicado uma exportação "com porta" cuja porta não existia — com teste verde,
 * porque o teste lia o arquivo errado.
 *
 * Achar isso por acidente duas vezes é sorte. Este teste transforma em conta:
 * componente de feature que ninguém renderiza reprova, a menos que esteja na
 * lista abaixo com o motivo escrito.
 */

const FEATURES = new URL("../app/painel/features/", import.meta.url);

/**
 * Componentes sem renderizador, com motivo.
 *
 * Não são remoções que eu deva fazer sozinho: é código do dono do repositório,
 * escondido de propósito ou por acidente, e a diferença muda o que fazer. O
 * que este teste garante é que a situação fique visível e datada, em vez de
 * ser redescoberta daqui a seis meses.
 */
const SEM_PORTA = new Map<string, string>([]);

const modules = (await readdir(FEATURES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name);

/** Componentes que cada feature publica no próprio `index.ts`. */
const exported = new Map<string, string>();
for (const module_ of modules) {
  const index = await readFile(new URL(`${module_}/index.ts`, FEATURES), "utf8").catch(() => "");
  for (const match of index.matchAll(/export \{([^}]*)\}/gu)) {
    for (const parte of match[1].split(",")) {
      const bruto = parte.trim();
      // `export { StatusPill, type PanelTone }`: tipo não é renderizado por
      // ninguém, e cobrá-lo tornaria este teste ruído em vez de sinal.
      if (bruto.startsWith("type ")) continue;
      const nome = bruto.split(" as ")[0].trim();
      if (nome && /^[A-Z]/u.test(nome)) exported.set(nome, module_);
    }
  }
}

/** Todo o código da aplicação, para procurar quem renderiza o quê. */
const sources = await (async () => {
  const root = new URL("../app/", import.meta.url);
  const encontrados: Array<[string, string]> = [];
  async function andar(dir: URL, prefixo: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await andar(new URL(`${entry.name}/`, dir), `${prefixo}${entry.name}/`);
      else if (/\.tsx?$/u.test(entry.name)) encontrados.push([`${prefixo}${entry.name}`, await readFile(new URL(entry.name, dir), "utf8")]);
    }
  }
  await andar(root, "");
  return encontrados;
})();

function renderersOf(component: string, module_: string) {
  return sources.filter(([caminho, fonte]) =>
    !caminho.startsWith(`painel/features/${module_}/`)
    && new RegExp(`<${component}\\b`, "u").test(fonte)).map(([caminho]) => caminho);
}

test("todo componente publicado por uma feature tem quem o renderize", () => {
  const orfaos: string[] = [];
  for (const [component, module_] of exported) {
    if (SEM_PORTA.has(component)) continue;
    if (renderersOf(component, module_).length === 0) orfaos.push(`${component} (${module_})`);
  }
  assert.deepEqual(orfaos, [],
    "tela construída e sem porta. Ou dê a porta, ou registre o motivo em SEM_PORTA");
});

test("a lista de telas sem porta não cresce em silêncio, e cada entrada diz por quê", () => {
  /* Zero, e as duas foram resolvidas por caminhos diferentes.

     `SaasView`: removida. `tests/saas-phase7.test.mts` registra que administrar
     assinatura é da plataforma por desenho e proíbe `view === "saas"` no
     painel — coerente com o produto não ter autocadastro.

     `AccessView`: a gestão de membros dela duplicava a que já vive em
     WorkspaceApp.tsx, mas `MemberModules` ao lado era a ÚNICA interface de
     /api/members/[id]/modules — a exceção de módulo por pessoa, cuja
     autorização foi corrigida em f86fa6d. Apagar a pasta teria removido a
     porta de uma feature viva. O componente migrou para `features/shared` e
     entrou na ficha do membro; só então a tela foi removida. */
  assert.equal(SEM_PORTA.size, 0, "mudou o número de telas sem porta — atualize o motivo junto");
  for (const [component, motivo] of SEM_PORTA) {
    assert.ok(motivo.length > 80, `${component} precisa de um motivo, não de uma linha`);
    assert.ok(exported.has(component), `${component} saiu do index: tire-o da lista também`);
    assert.deepEqual(renderersOf(component, exported.get(component)!), [],
      `${component} ganhou porta — tire-o da lista de telas sem porta`);
  }
});

test("os componentes compartilhados continuam com muitos usos, que é o ponto deles", () => {
  // Contraprova do método: se a busca por renderizadores estivesse quebrada,
  // ela acusaria estes como órfãos também.
  for (const component of ["EmptyState", "StatusPill", "PanelHeader", "ErrorBanner"]) {
    assert.ok(renderersOf(component, "shared").length >= 3,
      `${component} deveria aparecer em vários módulos; a busca pode estar quebrada`);
  }
});
