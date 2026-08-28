import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skip = new Set([".next", "node_modules", ".git", "dist"]);

async function walk(directory: string, extensions: string[]): Promise<string[]> {
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries) {
    if (skip.has(entry)) continue;
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) files.push(...await walk(path, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) files.push(path);
  }
  return files;
}

/**
 * Remove comentários antes de medir.
 *
 * O teste procura o nome antigo em *texto de interface*, e comentário não é
 * interface. A distinção passou a importar quando o cartão de compartilhamento
 * foi corrigido: o comentário que explica por que o endereço da imagem mudou
 * precisa dizer que o arquivo anterior estampava a marca antiga — e nomear o
 * defeito é a única forma de documentá-lo. Sem esta separação, o repositório
 * fica proibido de contar a própria história.
 *
 * O `//` só conta como comentário quando não vem depois de `:`, para não comer
 * o resto de uma linha que contenha `https://`.
 */
function interfaceTextOf(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

test("nenhum texto de interface ainda diz o nome antigo", async () => {
  const files = await walk(root, [".ts", ".tsx", ".css"]);
  const offenders: string[] = [];
  for (const file of files) {
    const source = interfaceTextOf(await readFile(file, "utf8"));
    // A marca também aparecia partida entre elementos ("Fila <strong>DP</strong>"),
    // que a busca por texto corrido não pegava. O padrão abaixo cobre os dois casos.
    /* Sem `i`, a varredura era cega para caixa alta — e foi assim que o
       cartão de erro do painel ficou estampando "FILA DP" depois da
       renomeação. Um guard que só pega uma grafia dá a impressão de cobertura
       que ele não tem. */
    if (/Fila\s*DP|FilaDP|Fila\s*<(?:strong|b)>\s*DP/iu.test(source)) offenders.push(file.replace(root, ""));
  }
  assert.deepEqual(offenders, [], `arquivos com o nome antigo: ${offenders.join(", ")}`);
});

test("a varredura continua vendo o nome antigo onde ele importa", () => {
  // Contraprova: se tirar comentários tivesse cegado a busca, ela pararia de
  // acusar o texto renderizado — e o teste viraria enfeite verde.
  assert.match(interfaceTextOf(`<h1>Fila DP</h1>`), /Fila DP/u);
  assert.match(interfaceTextOf(`const t = "Fila DP"; // marca`), /Fila DP/u);
  assert.match(interfaceTextOf(`<p>Fila <strong>DP</strong></p>`), /Fila\s*<strong>\s*DP/u);
  // E o comentário deixa de contar, que é o ponto.
  assert.doesNotMatch(interfaceTextOf(`// o arquivo anterior dizia Fila DP`), /Fila DP/u);
  assert.doesNotMatch(interfaceTextOf(`/* dizia Fila DP */`), /Fila DP/u);
  // Sem comer o que vem depois de uma URL na mesma linha.
  assert.match(interfaceTextOf(`const u = "https://exemplo.test"; const n = "Fila DP";`), /Fila DP/u);
});

test("identificadores técnicos foram preservados na renomeação", async () => {
  // Renomear tabela, variável de ambiente ou cabeçalho quebraria bancos e
  // integrações já instalados. O nome do produto mudou; o contrato técnico não.
  const [schema, api] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/competences/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /pgTable\("fdp_workspaces"/);
  assert.match(api, /x-fila-dp-request-id/);
});

test("a identidade visual vive em tokens, não espalhada em HEX", async () => {
  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  // Os dois azuis vêm dos pixels do símbolo oficial, não de estimativa. Eles não
  // acompanham a paleta de referência de propósito: adotá-la faria a interface
  // deixar de combinar com o próprio logo.
  for (const token of ["--vin-navy: #062B60", "--vin-blue-vivid: #168CFD"]) {
    assert.ok(globals.includes(token), `token ausente: ${token}`);
  }
  // Os neutros, ao contrário, seguem a paleta de referência (§14).
  for (const token of ["--vin-bg: #F6F8FC", "--vin-text: #172033", "--vin-border: #E2E8F0", "--vin-teal: #16A394"]) {
    assert.ok(globals.includes(token), `token ausente: ${token}`);
  }
  // Exceção medida: a referência pede #64748B para texto secundário, que rende
  // 4.48:1 sobre o fundo #F6F8FC — abaixo do mínimo 4.5 da WCAG 2.2 AA. O tom
  // adotado rende 5.78:1. Adotar o pedido criaria a violação que a auditoria de
  // acessibilidade acusaria nas 59 telas.
  assert.ok(globals.includes("--vin-text-soft: #55627A"), "o texto secundário precisa passar no contraste");
  // A conferência é sobre uso como valor, não sobre a palavra: o comentário que
  // explica a exceção cita o tom, e casar com ele acusaria o contrário.
  assert.ok(!/:\s*#64748B/u.test(globals), "o tom que reprova no contraste não pode virar valor de token");
  for (const semantic of ["--brand:", "--brand-strong:", "--brand-accent:", "--ui-surface:", "--ui-text:"]) {
    assert.ok(globals.includes(semantic), `token semântico ausente: ${semantic}`);
  }
});

test("a tipografia carrega de verdade: Manrope nos títulos, Inter na interface", async () => {
  // O CSS nomeava as duas famílias sem carregar nenhuma, então a interface caía
  // para a fonte do sistema — que muda de máquina para máquina e derruba a
  // densidade que uma tela operacional precisa.
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /from "next\/font\/google"/u, "sem carregamento, a família é só um nome no CSS");
  assert.match(layout, /Manrope\(\{[^}]*variable: "--font-titles"/u);
  assert.match(layout, /Inter\(\{[^}]*variable: "--font-interface"/u);
  // `next/font` hospeda no próprio deploy: nenhuma requisição a terceiros em
  // runtime, o que mantém o CSP fechado.
  assert.doesNotMatch(layout, /fonts\.googleapis\.com|fonts\.gstatic\.com/u);

  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globals, /--font-title: var\(--font-titles\)/u);
  assert.match(globals, /h1, h2, h3, h4, h5, h6 \{ font-family: var\(--font-title\)/u);
});

test("a marca usa os arquivos oficiais, não um redesenho", async () => {
  const logo = await readFile(new URL("../app/components/VinculatoLogo.tsx", import.meta.url), "utf8");
  assert.match(logo, /export function VinculatoMark/);
  assert.match(logo, /export function VinculatoLogo/);
  // Arquivo oficial recortado, servido por next/image — sem path desenhado à mão.
  assert.match(logo, /markSource: "\/brand\/vinculato-mark\.png"/);
  assert.match(logo, /logoSource: "\/brand\/vinculato-logo\.png"/);
  assert.doesNotMatch(logo, /<path\s/u);
  assert.match(logo, /VINCULATO_TAGLINE = "Sua operação, conectada\."/);

  const [mark, wordmark, icon] = await Promise.all([
    stat(new URL("../public/brand/vinculato-mark.png", import.meta.url)),
    stat(new URL("../public/brand/vinculato-logo.png", import.meta.url)),
    stat(new URL("../app/icon.png", import.meta.url)),
  ]);
  assert.ok(mark.size > 1000, "o símbolo oficial precisa existir em public/brand");
  assert.ok(wordmark.size > 1000, "o logotipo oficial precisa existir em public/brand");
  assert.ok(icon.size > 200, "o favicon precisa ser gerado do símbolo oficial");
});

test("o verde-menta da marca anterior não voltou pelas bordas", async () => {
  // Restaram três acentos em telas escuras e um hover depois da troca de marca.
  // Verde de sucesso continua permitido: o que não pode é menta como identidade.
  const files = await walk(root, [".css"]);
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const legacy of ["#45dcb0", "#8ae0c5", "#0E3B3B", "#0e3b3b"]) {
      if (source.includes(legacy)) offenders.push(`${file.replace(root, "")} (${legacy})`);
    }
  }
  assert.deepEqual(offenders, [], `menta da marca antiga ainda no CSS: ${offenders.join(", ")}`);
});

test("o azul vivo nunca é a cor do texto sobre superfície clara", async () => {
  // --brand-accent puro fica em 3.39:1 sobre branco. Quem precisa de azul em
  // texto usa --ui-mint-text (claro) ou --brand-accent-on-dark (escuro).
  const dashboard = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  assert.ok(dashboard.includes("--ui-mint-text:"), "falta o par legível de --ui-mint");
  assert.ok(dashboard.includes("--ui-on-mint:"), "falta a cor de texto sobre preenchimento --ui-mint");
  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.ok(globals.includes("--brand-accent-on-dark:"), "falta o acento legível sobre navy");
});

test("a conferência WCAG faz parte do repositório, não de uma rodada avulsa", async () => {
  const script = await readFile(new URL("../scripts/a11y-check.mjs", import.meta.url), "utf8");
  // Gradiente medido de verdade: pular superfície com background-image foi o que
  // deixou passar três textos entre 3.09:1 e 4.09:1 na primeira rodada.
  assert.match(script, /gradientSurfaces/u);
  assert.match(script, /process\.exit\(failures === 0 \? 0 : 1\)/u);
  // As duas larguras: alvo de 24px muda com o layout.
  assert.match(script, /width: 390/u);

  // Piso de cobertura. Este script já falhou do jeito mais perigoso que um
  // verificador pode falhar: passando. Um seletor de navegação que deixou de
  // casar tirou 32 telas da varredura e a conclusão continuou "OK: 0
  // violações" — 0 violações em nada. Sem o piso, a próxima mudança de menu
  // repete o silêncio.
  assert.match(script, /const MINIMO_DE_TELAS = \d+;/u);
  assert.match(script, /if \(screensAudited < MINIMO_DE_TELAS\)/u);
  assert.match(script, /COBERTURA INSUFICIENTE/u);

  /* E a varredura precisa entrar nas abas de dentro de cada módulo.
     Sem isto ela visitava o módulo, media a primeira aba e seguia adiante: as
     dez abas do Controle de EPI, as nove da gestão de Processos e as quatro do
     quadro nunca eram medidas, e o relatório dizia "0 violações" sobre o que
     não tinha olhado. A primeira passagem com elas dentro acusou 122 violações
     de contraste reais. */
  assert.match(script, /async function auditModuleTabs/u);
  assert.match(script, /await auditModuleTabs\(/u);
  // As abas do cabeçalho de processo ficam de fora: elas levam às mesmas telas
  // que o segundo nível do menu, e medi-las de novo infla o piso sem medir nada.
  assert.match(script, /\.process-context \[role="tab"\]/u);
  assert.ok(Number(script.match(/const MINIMO_DE_TELAS = (\d+);/u)?.[1]) >= 55,
    "o piso precisa acompanhar o alcance da varredura, senão vira folga acumulada");

  // E a varredura precisa alcançar o menu mesmo com os itens agrupados: o
  // seletor de filho direto era exatamente o que quebrou.
  assert.match(script, /nav\[aria-label="Navegação do painel"\] /u);
  assert.doesNotMatch(script, /Navegação do painel"\] > button/u);
  // Console sem áreas visíveis passou a ser falha, não aviso.
  assert.match(script, /nenhuma área visível; a varredura não rodou/u);

  /* O menu tem dois níveis desde que passou a agrupar por processo (§25), e os
     módulos do segundo só existem no DOM enquanto o processo está aberto. Ler
     os rótulos uma vez no começo mediria os processos e os módulos de um só
     deles — a mesma classe de ponto cego que já tirou 32 telas desta varredura
     imprimindo "0 violações". Os dois níveis são percorridos em sequência. */
  assert.match(script, /\.sidebar-process > button/u);
  assert.match(script, /\.sidebar-process-view/u);

  /* O produto voltou a ter um tema só, por decisão de produto registrada — e a
     varredura volta ao posto de sentinela.

     Esta trava já mudou de lado três vezes, e é justamente por isso que ela
     existe: a regra que atravessou as três versões é sempre a mesma, **nunca
     audite metade**. Quando havia dois temas, ela cobrava que os dois fossem
     medidos. Com um só, ela cobra que a volta do segundo seja acusada em vez
     de passar em silêncio — que é a única coisa capaz de tornar esta varredura
     parcial sem ninguém perceber. */
  assert.doesNotMatch(script, /async function switchTheme/u);
  assert.match(script, /async function themeToggleExists/u);
  assert.match(script, /um alternador de tema voltou à interface/u);
  assert.match(script, /await auditEverything\(\);/u);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["a11y-check"], "node scripts/a11y-check.mjs");
});

test("nenhuma tela usa mais o marcador decorativo antigo", async () => {
  const files = await walk(root, [".tsx"]);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // O bloco de três barrinhas era um placeholder; a marca real substituiu.
    if (/brand-mark|brandMark/u.test(source)) offenders.push(file.replace(root, ""));
  }
  assert.deepEqual(offenders, [], `telas ainda com o marcador antigo: ${offenders.join(", ")}`);
});

test("o catálogo de planos publica os quatro planos de lançamento em centavos", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0022_plan_catalog_pricing.sql", import.meta.url), "utf8");
  for (const [code, cents, seats] of [
    ["starter", "0", "3"], ["standard", "9700", "10"], ["premium", "29700", "30"], ["enterprise", "79700", "100"],
  ] as const) {
    const block = migration.split(`WHERE "code" = '${code}'`)[0].split("UPDATE \"fdp_saas_plans\" SET").at(-1) ?? "";
    assert.ok(block.includes(`"monthly_price_cents" = ${cents}`), `${code} sem o preço ${cents}`);
    assert.ok(block.includes(`"included_seats" = ${seats}`), `${code} sem ${seats} assentos`);
    assert.ok(block.includes(`"status" = 'active'`), `${code} precisa estar ativo para ser vendido`);
  }
  // Preço é histórico versionado: alterar não pode mudar contrato antigo.
  assert.match(migration, /CREATE TABLE "fdp_saas_plan_prices"/);
  assert.match(migration, /plan prices are append-only/);
  assert.match(migration, /ALTER TABLE "fdp_workspace_subscriptions" ADD COLUMN IF NOT EXISTS "plan_price_id"/);
});

test("alterar preço no console global cria nova versão em vez de sobrescrever", async () => {
  const route = await readFile(new URL("../app/api/platform/plans/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /INSERT INTO fdp_saas_plan_prices/);
  assert.match(route, /const priceChanged =/);
  assert.match(route, /newPriceVersion: priceChanged/);
});

test("o limite de assentos explica plano, uso e limite", async () => {
  const route = await readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8");
  assert.match(route, /PLAN_SEAT_LIMIT/);
  assert.match(route, /permite \$\{allowance\.seat_limit\} usuário\(s\)/u);
  assert.match(route, /já estão em uso/u);
  assert.match(route, /SUBSCRIPTION_INACTIVE/);
  // A trava contra corrida continua no banco, não só na checagem prévia.
  assert.match(route, /pg_advisory_xact_lock/);
});

test("a administração da plataforma administra de verdade, e sempre com trilha", async () => {
  const [list, detail, users, userDetail] = await Promise.all([
    readFile(new URL("../app/api/platform/workspaces/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/workspaces/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/users/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/users/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [list, detail, users, userDetail]) {
    assert.match(source, /requirePlatformAdmin/);
    assert.match(source, /withPlatformContext/);
  }
  // Criar workspace é transacional e nasce com proprietário, papel e assinatura.
  assert.match(list, /provisionWorkspaceDefaults\(tenant, workspaceId, statements\)/);
  assert.match(list, /INSERT INTO fdp_workspace_members \(workspace_id, user_id, role\) VALUES \(\?, \?, 'admin'\)/);
  assert.match(list, /INSERT INTO fdp_workspace_subscriptions/);
  // Senha nunca é inventada: o proprietário novo entra pela recuperação de acesso.
  assert.match(list, /Nunca criamos senha padrão nem senha em texto aberto/u);
  // Toda alteração administrativa grava na trilha global.
  for (const source of [list, detail, userDetail]) {
    assert.match(source, /INSERT INTO fdp_platform_audit_events/);
  }
  // Salvaguardas exigidas antes de liberar o produto.
  assert.match(detail, /PLAN_DOWNGRADE_BLOCKED/);
  assert.match(detail, /STATUS_REASON_REQUIRED/);
  assert.match(userDetail, /OWNER_BLOCK_BLOCKED/);
  assert.match(userDetail, /OWNER_UNLINK_BLOCKED/);
  // Bloquear derruba as sessões abertas: sem isso o bloqueio só valeria no próximo login.
  assert.match(userDetail, /DELETE FROM fdp_auth_sessions WHERE user_id = \?/);
  // A listagem global não projeta material de senha.
  assert.doesNotMatch(users, /password_hash AS|password_salt/);
});

test("usuário bloqueado e workspace suspenso perdem acesso de verdade", async () => {
  const [database, login, migration] = await Promise.all([
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0023_platform_lifecycle.sql", import.meta.url), "utf8"),
  ]);
  // Vale em toda requisição, não só no login.
  assert.match(database, /USER_BLOCKED/);
  assert.match(login, /USER_BLOCKED/);
  // Workspace fora do ar continua sem operar — mas a recusa deixou de derrubar
  // a sessão inteira. Quem tem outro grupo ativo entra nele; quem não tem
  // recebe NO_ACTIVE_WORKSPACE dizendo qual grupo está em qual estado.
  const access = await readFile(new URL("../lib/workspace-access.ts", import.meta.url), "utf8");
  assert.match(access, /OPERATIONAL_WORKSPACE_STATUSES = new Set\(\["active"\]\)/u);
  assert.match(database, /noAccessibleWorkspaceError/u);
  assert.match(access, /"NO_ACTIVE_WORKSPACE"/u);
  // O banco exige motivo registrado para qualquer estado que corte acesso.
  assert.match(migration, /"fdp_workspaces_status_reason_check"/);
  assert.match(migration, /"fdp_users_status_reason_check"/);
  assert.match(migration, /"status" IN \('active', 'suspended', 'canceled', 'archived'\)/);
});

test("provisionar pela plataforma usa os dois contextos na mesma transação", async () => {
  const adapter = await readFile(new URL("../db/index.ts", import.meta.url), "utf8");
  assert.match(adapter, /export function getPlatformScopedD1/);
  assert.match(adapter, /set_config\('app\.workspace_id', \$\{this\.boundContext\.workspaceId\}, true\)[\s\S]{0,120}set_config\('app\.platform_admin', 'true', true\)/);
  // Não existe caminho que dispense o workspace: a marca de plataforma sozinha
  // continua sem acesso às tabelas do cliente.
  assert.match(adapter, /if \(this\.boundContext && this\.withPlatformFlag\)/);
});

test("excluir um grupo é irreversível, então exige quatro portas antes", async () => {
  const source = await readFile(new URL("../app/api/platform/workspaces/[id]/delete/route.ts", import.meta.url), "utf8");
  assert.match(source, /requirePlatformAdmin\(/u);
  // Não se exclui um grupo em operação por engano.
  assert.match(source, /WORKSPACE_NOT_ARCHIVED/u);
  // O identificador digitado por extenso impede que o clique caia no grupo errado.
  assert.match(source, /confirmation !== workspace\.slug/u);
  assert.match(source, /WORKSPACE_DELETE_REASON_REQUIRED/u);
});

test("a contagem da exclusão roda dentro do escopo do tenant", async () => {
  const source = await readFile(new URL("../app/api/platform/workspaces/[id]/delete/route.ts", import.meta.url), "utf8");
  // Contando pela conexão de plataforma a RLS esconde as linhas do cliente e o
  // COUNT devolve zero sem erro: o registro anotou 4 linhas onde havia 6 no
  // primeiro ensaio. Número inventado é pior que número nenhum num registro que
  // existe para ser prova.
  assert.match(source, /const scoped = getPlatformScopedD1\(/u);
  assert.match(source, /scoped\.prepare\(`SELECT COUNT\(\*\) AS total FROM \$\{table\}/u);
  const countAt = source.indexOf("const counts: Record<string, number> = {}");
  const deleteAt = source.indexOf("DELETE FROM fdp_workspaces");
  assert.ok(countAt > 0 && deleteAt > countAt, "a contagem precisa acontecer antes da remoção");
});

test("a trilha do grupo é removida explicitamente, e o registro de exclusão é imutável", async () => {
  const source = await readFile(new URL("../app/api/platform/workspaces/[id]/delete/route.ts", import.meta.url), "utf8");
  // Uma exclusão de auditoria precisa estar escrita no código de quem a fez,
  // não escondida numa constraint CASCADE.
  assert.match(source, /DELETE FROM fdp_audit_events WHERE workspace_id = \?/u);
  assert.match(source, /set_config\('app\.audit_maintenance', 'on', true\)/u);

  const migration = await readFile(new URL("../drizzle/postgres/0034_workspace_deletion_ledger.sql", import.meta.url), "utf8");
  // Sem FK para o grupo: ele deixa de existir, e o registro precisa sobreviver.
  assert.doesNotMatch(migration, /REFERENCES "public"\."fdp_workspaces"[\s\S]{0,80}fdp_workspace_deletions/u);
  assert.match(migration, /workspace deletion records are immutable/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "fdp_workspace_deletions"/u);
});

test("administrador global entra no console mesmo sem vínculo de workspace", async () => {
  const route = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  // Excluir o último cliente não pode impedir o administrador global de entrar
  // e provisionar o próximo pelo Console Global.
  assert.match(route, /const platformAdmin = isPlatformAdmin\(identity\)/u);
  assert.match(route, /if \(!access && !platformAdmin\)/u);
  assert.match(route, /platformAdmin && !access \? "\/plataforma"/u);
});
