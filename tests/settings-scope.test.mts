import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §35: as configurações do painel.
 *
 * Este arquivo já registrou a decisão oposta, e o histórico importa mais que o
 * estado atual:
 *
 *  - em `d2d8d5a` ("Restringe o painel ao fluxo operacional") o menu perdeu oito
 *    entradas de propósito, e sobrou Segurança;
 *  - "Usuários e acessos" foi reaberta depois, para sustentar a hierarquia
 *    Workspace → Departamento → Módulos;
 *  - as outras sete continuaram fechadas, e este teste guardava esse fechamento
 *    para que ninguém o desfizesse achando que era regressão.
 *
 * O dono do repositório desfez a decisão: pelo painel do administrador não havia
 * como editar uma empresa nem dar um módulo a alguém. Não havia mesmo — os sete
 * componentes existiam, funcionavam, conversavam com a API, e nenhum botão
 * levava até eles. Era código completo atrás de uma porta murada.
 *
 * O que o arquivo passa a guardar é a regra que impede as duas falhas de uma
 * vez: **toda seção declarada em `SettingsSection` tem exatamente uma porta no
 * menu, e todo ramo do conteúdo corresponde a uma seção declarada.** Fechar uma
 * seção volta a ser possível — mas exige tirá-la do tipo, e não deixá-la
 * pendurada num ramo que nada alcança.
 */

const source = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");

/** As seções declaradas no tipo. É esta lista que manda. */
const declaradas = (() => {
  const linha = source.match(/^type SettingsSection = ([^;]+);/mu);
  assert.ok(linha, "o tipo SettingsSection sumiu do painel");
  return linha[1].split("|").map((parte) => parte.trim().replace(/"/gu, ""));
})();

/** O menu escrito como dado, para poder ser conferido como dado. */
const grupos = (() => {
  const inicio = source.indexOf("const settingsNavGroups");
  assert.notEqual(inicio, -1, "o menu voltou a ser JSX solto: não há como conferir as portas");
  const bloco = source.slice(inicio, source.indexOf("\n];", inicio));
  return [...bloco.matchAll(/\{ label: "([^"]+)", adminOnly: (true|false), sections: \[([\s\S]*?)\n {2}\] \}/gu)]
    .map((match) => ({
      label: match[1],
      adminOnly: match[2] === "true",
      sections: [...match[3].matchAll(/section: "([a-z]+)"/gu)].map((entry) => entry[1]),
    }));
})();

const comPorta = grupos.flatMap((grupo) => grupo.sections);

test("toda seção declarada tem exatamente uma porta no menu", () => {
  for (const secao of declaradas) {
    const portas = comPorta.filter((item) => item === secao).length;
    assert.equal(portas, 1,
      `a seção ${secao} tem ${portas} porta(s) no menu — sete telas ficaram inalcançáveis exatamente assim`);
  }
  assert.deepEqual([...comPorta].sort(), [...declaradas].sort(),
    "o menu aponta para uma seção que o tipo não declara");
});

test("todo ramo do conteúdo corresponde a uma seção declarada", () => {
  const ramos = new Set([...source.matchAll(/settingsSection === "([a-z]+)"/gu)].map((match) => match[1]));
  for (const ramo of ramos) {
    assert.ok(declaradas.includes(ramo), `o conteúdo renderiza "${ramo}", que não existe em SettingsSection`);
  }
  // O caminho inverso: uma seção declarada, com porta no menu e sem conteúdo
  // abriria um painel vazio — que é a outra metade do mesmo defeito.
  for (const secao of declaradas) {
    assert.ok(ramos.has(secao), `a seção ${secao} tem porta no menu e nenhum conteúdo para mostrar`);
  }
});

test("o cabeçalho do modal nomeia a seção aberta, e não duas dentre nove", () => {
  // Antes eram dois textos escritos à mão: um para "security" e outro para todo
  // o resto. Com uma seção só além dela, passava despercebido; com nove, sete
  // telas anunciariam "Usuários e acessos" no título.
  assert.match(source, /<h2 id="workspace-modal-title">\{settingsSectionMeta\[settingsSection\]\.title\}<\/h2>/u);
  assert.match(source, /<span>\{settingsSectionMeta\[settingsSection\]\.group\}<\/span>/u);
  const meta = source.slice(source.indexOf("const settingsSectionMeta"), source.indexOf("\n};", source.indexOf("const settingsSectionMeta")));
  const titulos = [...meta.matchAll(/title: "([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(titulos.length, declaradas.length, "há seção sem nome no cabeçalho");
  assert.equal(new Set(titulos).size, titulos.length, "duas seções compartilham o mesmo título");
});

test("a administração do grupo fica atrás de isAdmin; a conta pessoal não", () => {
  const pessoais = grupos.filter((grupo) => !grupo.adminOnly).flatMap((grupo) => grupo.sections);
  assert.deepEqual(pessoais.sort(), ["general", "security"],
    "uma seção de administração ficou visível para quem não é administrador do grupo");
  const administrativas = grupos.filter((grupo) => grupo.adminOnly).flatMap((grupo) => grupo.sections);
  for (const secao of ["companies", "team", "columns", "fields", "templates", "sla", "automations"]) {
    assert.ok(administrativas.includes(secao), `${secao} deixou de exigir administrador`);
  }
  assert.match(source, /settingsNavGroups\.filter\(\(group\) => isAdmin \|\| !group\.adminOnly\)/u);
});

test("cada botão do menu tem nome acessível mesmo quando o CSS mostra só o ícone", () => {
  // Em telas estreitas o `<span>` do rótulo recebe `display: none`, o que o tira
  // também da árvore de acessibilidade. Com dois botões isso passava; com nove
  // seria uma coluna de ícones anônimos.
  assert.match(source, /<button key=\{item\.section\} aria-label=\{settingsSectionMeta\[item\.section\]\.title\}/u);
});

test("o modal abre por um caminho só, e o botão do topo diz o que há atrás dele", () => {
  const aberturas = source.match(/setWorkspaceModalOpen\(true\)/gu) ?? [];
  assert.equal(aberturas.length, 1, "mais de um caminho abre o modal: a seção pode divergir do menu");
  assert.match(source, /function openSecuritySettings\(\) \{\s*setSettingsSection\("security"\);/u);
  // A seção passou a poder vir do endereço (§46, /painel/configuracoes/...),
  // e "security" continua sendo o padrão de quem chega sem seção nenhuma.
  assert.match(source, /useState<SettingsSection>\(\s*\(initialLocation\.settings \?\? "security"\)/u);
  // O rótulo antigo dizia só "Perfil e segurança" enquanto escondia empresas,
  // usuários, colunas e automações atrás do mesmo botão.
  assert.match(source, /aria-label=\{isAdmin \? "Abrir configurações do workspace e do perfil" : "Abrir perfil e segurança"\}/u);
});

test("a tela de empresas edita, e a edição chega ao PATCH da API", async () => {
  // O pedido era literal: "não tem a parte de editar a empresa". O cadastro
  // existia, a API tinha PATCH, e a tela só sabia criar e excluir.
  const rota = await readFile(new URL("../app/api/companies/[id]/route.ts", import.meta.url), "utf8");
  assert.match(rota, /export async function PATCH/u);
  assert.match(rota, /requireCapability\(workspace, "companies\.manage"\)/u);
  assert.match(source, /async function updateCompany\(id: string, payload: Record<string, unknown>\) \{\s*return mutate\(`\/api\/companies\/\$\{id\}`, \{ method: "PATCH"/u);
  assert.match(source, /<CompanySettings[^>]*onUpdateCompany=\{updateCompany\}/u);
  // Um formulário só para criar e editar: dois divergem sem ninguém perceber.
  const componente = source.slice(source.indexOf("function CompanySettings("));
  const corpo = componente.slice(0, componente.indexOf("\nfunction "));
  assert.equal((corpo.match(/<form className="company-settings-form"/gu) ?? []).length, 1,
    "o cadastro e a edição de empresa viraram dois formulários");
  assert.match(corpo, /\? await onUpdateCompany\(current\.id/u);
  assert.match(corpo, /: await onCreateCompany\(payload\)/u);
  // Situação editável, porque excluir uma empresa com histórico não é opção.
  assert.match(corpo, /name="status"/u);
});
