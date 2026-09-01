import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { capabilities, capabilitiesForRole, workspaceRoles } from "../lib/authorization.ts";
import { capabilityAreas, capabilitiesOfArea, capabilityCatalog } from "../lib/capability-catalog.ts";

/**
 * A Administração do workspace, na forma da maquete 3.
 *
 * A modal de configurações é onde o grupo é administrado: nome, empresas,
 * usuários, colunas, campos, modelos, SLA e automações. A maquete pede uma
 * faixa de indicadores, tabelas no lugar das listas de botões, e uma matriz de
 * permissões — esta última é a peça que o próprio código já dizia estar
 * faltando.
 */

const painel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");

function bloco(inicio: string, fim: string) {
  const de = painel.indexOf(inicio);
  assert.notEqual(de, -1, `não achei "${inicio}" no painel`);
  const ate = painel.indexOf(fim, de);
  assert.notEqual(ate, -1, `não achei o fim "${fim}" a partir de "${inicio}"`);
  return painel.slice(de, ate + fim.length);
}

/* ── A matriz de permissões ────────────────────────────────────────────────
   O modelo existia inteiro e nunca chegou a uma tela. `capabilitiesForRole`
   nasceu com o comentário "a tela de usuários precisa mostrar o que cada papel
   concede — sem isso o administrador escolhe 'Membro' ou 'Observador' no
   escuro", e nenhum componente jamais o chamou. */

test("a matriz lê o modelo de autorização, e não uma cópia escrita à mão", () => {
  const matriz = bloco("function PermissionMatrix()", "\n}\n");
  assert.match(matriz, /capabilitiesForRole\(papel\)/u,
    "a concessão precisa sair da mesma função que a autorização usa");
  assert.match(matriz, /capabilityCatalog\[capability\]\.label/u,
    "o rótulo precisa sair do catálogo, senão a tela e o servidor divergem");
  assert.match(matriz, /capabilitiesOfArea\(area\.key\)/u);
  /* Uma lista de permissões escrita dentro do componente envelheceria em
     silêncio: capacidade nova entraria no sistema e a matriz continuaria
     mostrando as antigas, dizendo que o papel não tem o que ele tem. */
  for (const inventado of ['"cards.read"', '"workspace.manage"', '"members.manage"']) {
    assert.ok(!matriz.includes(inventado),
      `${inventado} escrito no componente: a matriz virou cópia do modelo`);
  }
});

test("a matriz cobre todos os papéis e todas as capacidades declaradas", () => {
  /* Um papel de fora da matriz seria concedido sem que ninguém visse o que ele
     concede — que é exatamente o estado anterior, com os quatro de fora. */
  const cobertas = new Set(capabilityAreas.flatMap((area) => capabilitiesOfArea(area.key)));
  for (const capability of capabilities) {
    assert.ok(cobertas.has(capability),
      `${capability} não cai em nenhuma área: a matriz não a mostraria`);
  }
  assert.equal(workspaceRoles.length, 4);
  const matriz = bloco("function PermissionMatrix()", "\n}\n");
  assert.match(matriz, /const papeis = workspaceRoles/u,
    "a lista de papéis precisa vir do modelo, para papel novo entrar sozinho");
});

test("a célula tem dois estados, e não um 'parcial' que o modelo não conhece", () => {
  /* A maquete desenha três estados: concedido, parcial e negado. O modelo tem
     dois — a capacidade é do papel ou não é. Desenhar um meio-termo numa matriz
     de permissão faz alguém conceder acesso achando que concedeu menos. */
  const matriz = bloco("function PermissionMatrix()", "\n}\n");
  assert.match(matriz, /className=\{tem \? "concedida" : "negada"\}/u);
  assert.ok(!/parcial/iu.test(matriz),
    "um estado 'parcial' entrou na matriz sem existir no modelo de autorização");
});

test("a célula diz em texto o que o símbolo mostra", () => {
  /* ✓ sozinho é anunciado como "check" sem dizer de quê, e quem não distingue
     matiz vê duas marcas parecidas. O texto acessível nomeia o par inteiro. */
  const matriz = bloco("function PermissionMatrix()", "\n}\n");
  assert.match(matriz, /<span aria-hidden="true">\{tem \? "[^"]+" : "[^"]+"\}<\/span>/u);
  assert.match(matriz, /\{roleLabels\[papel\]\}: \{tem \? "permitido" : "não permitido"\}/u);
});

test("o papel de administrador permite tudo que os outros permitem", () => {
  /* Não é uma regra de tela, é a leitura que a matriz vai mostrar: se algum
     papel tivesse capacidade que o administrador não tem, a coluna dele
     apareceria com um traço e ninguém entenderia por quê. */
  const doAdmin = new Set(capabilitiesForRole("admin"));
  for (const papel of workspaceRoles) {
    for (const capability of capabilitiesForRole(papel)) {
      assert.ok(doAdmin.has(capability),
        `${papel} tem ${capability} e o administrador não`);
    }
  }
});

/* ── A faixa de indicadores ───────────────────────────────────────────────── */

test("nenhum número da administração é fixo no código", () => {
  /* §13: estado vazio é preferível a dado falso. Cada indicador precisa sair de
     uma contagem sobre o snapshot que a modal já tem em mãos. */
  const faixa = bloco("const indicadores = [", "  ];");
  const fixos = [...faixa.matchAll(/value: "([^"$]*\d[^"]*)"/gu)].map((match) => match[1]);
  assert.deepEqual(fixos, [], `número fixo na faixa: ${fixos.join(", ")}`);
  for (const fonte of ["snapshot.members.length", "snapshot.companies.length",
    "snapshot.availableWorkspaces.length", "snapshot.boards.length"]) {
    assert.ok(faixa.includes(fonte), `a faixa deixou de ler ${fonte}`);
  }
  /* E o alerta também é comparação de número, nunca um `true` escrito: um
     cartão âmbar fixo acusaria problema onde não há. */
  const alertas = [...faixa.matchAll(/alert: ([^,\n]+)/gu)].map((match) => match[1].trim());
  assert.equal(alertas.length, 5);
  assert.ok(alertas.includes("semAtivar > 0"));
  assert.ok(alertas.includes("comErro > 0"));
});

test("a faixa da administração não ressuscita a tela de plano por um atalho", () => {
  /* A maquete traz "Plano e utilização" com barras de consumo. A tela de plano
     foi tirada do painel de propósito (§44) e há teste guardando a retirada.
     Uma barra de consumo aqui mostraria uso sem lugar nenhum para agir sobre
     ele — pior que não mostrar. */
  const faixa = bloco("const indicadores = [", "  ];");
  assert.ok(!/plano|utiliza(ç|c)(ã|a)o|consumo|quota/iu.test(faixa),
    "o plano voltou pela faixa de indicadores, sem a tela que o resolve");
});

/* ── As tabelas ───────────────────────────────────────────────────────────── */

test("as tabelas da administração usam cabeçalho de linha, não negrito", () => {
  /* O nome do workspace e o do quadro são o cabeçalho da linha: sem
     `<th scope="row">` o leitor de tela lê as células soltas, sem dizer de que
     workspace elas são. */
  for (const [tabela, colunas] of [
    ["Seus workspaces", ["Workspace", "Seu papel", "Situação"]],
    ["Quadros da operação", ["Quadro", "Tipo", "Etapas"]],
  ] as const) {
    const trecho = bloco(tabela, "</table>");
    for (const coluna of colunas) {
      assert.match(trecho, new RegExp(`<th scope="col">${coluna}</th>`, "u"),
        `a coluna ${coluna} sumiu da tabela de ${tabela}`);
    }
    assert.match(trecho, /<th scope="row">/u, `a tabela de ${tabela} perdeu o cabeçalho de linha`);
    /* A coluna de ação não tem título visível, mas precisa ter nome: uma
       coluna anônima é anunciada como vazia. */
    assert.match(trecho, /<th scope="col"><span className="sr-only">Ação<\/span><\/th>/u);
  }
});

test("a linha vigente se marca por forma, e não só por cor", () => {
  // `aria-current` diz ao leitor de tela; o traço da folha diz a quem não
  // distingue matiz. Um dos dois sozinho deixa alguém de fora.
  assert.match(painel, /aria-current=\{item\.id === snapshot\.workspace\.id \? "true" : undefined\}/u);
  assert.match(painel, /aria-current=\{board\.id === snapshot\.board\.id \? "true" : undefined\}/u);
});

/* ── O nome do grupo ──────────────────────────────────────────────────────── */

test("o nome do grupo aparece no campo venha a modal de onde vier", async () => {
  /* Defeito real, visto na tela: `openWorkspaceSettings` preenchia o estado, e
     desde a §46 a modal também abre pelo endereço — que é o link que se manda
     para alguém e o que sobrevive a um F5. Por esse caminho a função não roda,
     e o administrador chegava a "Nome do workspace" em branco, num campo
     `required`: parecia que o grupo tinha perdido o nome, e salvar dali o
     renomearia para o que a pessoa digitasse.

     A correção é derivar do snapshot em vez de sincronizar por efeito — assim
     os dois caminhos de abertura valem, e não há efeito que possa apagar o que
     está sendo digitado. */
  assert.match(painel, /const workspaceName = workspaceNameEdit \?\? snapshot\?\.workspace\.name \?\? ""/u);
  assert.match(painel, /const \[workspaceNameEdit, setWorkspaceNameEdit\] = useState<string \| null>\(null\)/u);
  assert.match(painel, /value=\{workspaceName\}[^>]*onChange=\{\(event\) => setWorkspaceNameEdit\(event\.target\.value\)\}/u);
  /* E o endereço da seção existe mesmo — sem ele o defeito acima seria
     impossível, e este teste estaria guardando um caminho imaginário. */
  const rotas = await readFile(new URL("../lib/panel-routes.ts", import.meta.url), "utf8");
  assert.match(rotas, /general: "grupo"/u);
});

/* ── A paleta ─────────────────────────────────────────────────────────────── */

test("a administração não mantém uma paleta própria", async () => {
  /* O bloco escuro da modal foi escrito antes do redesenho e ficou com marinho
     e verde-água: a coluna de navegação das configurações era a única
     superfície azul do painel inteiro, e o item ativo o único verde, enquanto
     em todo o resto a marca é latão. */
  const css = await readFile(new URL("../app/access.css", import.meta.url), "utf8");
  const bloco = css.slice(css.indexOf(".theme-dark .workspace-modal > header {"),
    css.indexOf(".theme-dark .workspace-member-list article > button"));
  assert.ok(bloco.length > 400, "o recorte do bloco escuro da modal ficou vazio");
  const hexes = [...bloco.matchAll(/#[0-9a-f]{6}\b/gu)].map((match) => match[0]);
  assert.deepEqual(hexes, [],
    `a modal voltou a fixar cor em vez de usar token: ${hexes.join(", ")}`);

  /* E o item ativo do menu usa o véu do próprio acento. Medido: latão #D9973F
     sobre o véu de menta a 23% rende 4,36:1 — abaixo do mínimo de 4,5. */
  const painelCss = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  assert.match(painelCss,
    /\.settings-nav button\.active, \.settings-nav button:hover \{ background: var\(--ui-primary-soft\)/u);
  assert.doesNotMatch(painelCss,
    /\.settings-nav button\.active[^\n]*color-mix\(in srgb, var\(--ui-mint\)/u,
    "o véu de menta voltou atrás do texto latão, abaixo do contraste mínimo");
});
