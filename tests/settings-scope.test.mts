import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §35: as configurações do painel.
 *
 * O que este arquivo registra é uma **decisão**, não um defeito. Em `d2d8d5a`
 * ("Restringe o painel ao fluxo operacional") o menu de configurações perdeu
 * oito entradas de propósito, e sobrou uma: Segurança. As oito seções
 * continuam implementadas no código e nenhum caminho as abre.
 *
 * O registro existe porque a leitura natural de quem chega depois é "sumiu um
 * menu, isso é regressão" — e restaurá-lo desfaria a decisão sem discussão.
 * Já aconteceu neste repositório com a tela global de usuários: uma
 * verificação de navegador desatualizada acusava a ausência dela no painel, e
 * a ausência era o certo.
 *
 * O que *não* é decisão, e por isso foi corrigido: o estado inicial apontava
 * para uma seção que nenhum caminho consegue mostrar.
 */

const source = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");

test("o modal de configurações abre por um caminho só, e nele a seção é sempre Segurança", () => {
  // Um único botão abre o modal, e ele fixa a seção antes de abrir.
  const aberturas = source.match(/setWorkspaceModalOpen\(true\)/gu) ?? [];
  assert.equal(aberturas.length, 1, "mais de um caminho abre o modal: a seção pode divergir do menu");
  assert.match(source, /function openSecuritySettings\(\) \{\s*setSettingsSection\("security"\);/u);
  assert.match(source, /onClick=\{openSecuritySettings\}/u);
});

test("o estado inicial é uma seção que a tela consegue mostrar", () => {
  // Estava em "general", que o menu atual não aponta. Enquanto houver um só
  // caminho de abertura isso não aparece; no dia em que houver dois, aparece
  // como um painel sem item de menu correspondente.
  assert.match(source, /useState<SettingsSection>\("security"\)/u);
});

test("as oito seções fechadas seguem fechadas — é decisão, não esquecimento", () => {
  // Se alguém quiser reabri-las, que seja de propósito e com este teste no
  // diff. O menu tem um rótulo e um botão.
  const nav = source.slice(source.indexOf('<nav className="settings-nav"'));
  const menu = nav.slice(0, nav.indexOf("</nav>"));
  const botoes = menu.match(/<button/gu) ?? [];
  assert.equal(botoes.length, 1, "o menu de configurações voltou a ter mais de uma entrada");
  assert.match(menu, /Segurança<small>Dispositivos e sessões<\/small>/u);
  for (const secao of ["general", "companies", "columns", "team", "fields", "templates", "sla", "automations"]) {
    assert.doesNotMatch(menu, new RegExp(`setSettingsSection\\("${secao}"\\)`, "u"),
      `a seção ${secao} voltou ao menu — se for intencional, atualize este teste`);
  }
});

test("o código diz quantas seções seguem implementadas e fechadas", () => {
  // Duzentas e trinta e sete linhas de componentes que nada abre. Deixá-las
  // sem registro é o que faz alguém "consertar" o menu meses depois.
  const fechadas = ["ListsSettings", "CompanySettings", "FieldsSettings",
    "TemplatesSettings", "SlaSettings", "RulesSettings"];
  for (const componente of fechadas) {
    assert.match(source, new RegExp(`function ${componente}\\(`, "u"),
      `${componente} sumiu: se foi remoção deliberada, tire-o desta lista`);
    // Cada um tem exatamente um ponto de uso, e é um ramo que nada alcança.
    const usos = source.match(new RegExp(`<${componente}\\b`, "gu")) ?? [];
    assert.equal(usos.length, 1, `${componente} passou a ter mais de um uso`);
  }
});
