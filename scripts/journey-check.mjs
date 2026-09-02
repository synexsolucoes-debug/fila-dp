/**
 * Jornadas de sessão, isolamento e autorização, contra o app rodando.
 *
 * `browser-check.mjs` percorre as telas e prova que a operação acontece pela
 * interface. Três jornadas ficavam de fora dele, e são justamente as que, quando
 * quebram, quebram calado:
 *
 *   J5 — o mesmo usuário em dois grupos, com dado de um invisível no outro;
 *   J6 — quem não tem a permissão é recusado pelo SERVIDOR, não só pela tela;
 *   J7 — sair e entrar em outra conta leva à outra conta.
 *
 * A J7 existe porque o defeito já aconteceu: "Entrar em outra conta" devolvia o
 * usuário à conta anterior. Um defeito de sessão não reaparece com barulho — ele
 * reaparece com a pessoa errada vendo a folha do cliente errado. Por isso a
 * verificação é de regressão permanente, e não uma conferência manual.
 *
 * A J6 é feita por chamada direta à API, com o cookie do usuário sem permissão.
 * Esconder o botão não é autorização: o que vale é a resposta do servidor.
 *
 * Uso:
 *   JOURNEY_BASE_URL=http://localhost:3000 \
 *   JOURNEY_ADMIN_EMAIL=admin@vinculato.test JOURNEY_ADMIN_PASSWORD='...' \
 *   JOURNEY_MEMBER_EMAIL=membro@vinculato.test JOURNEY_MEMBER_PASSWORD='...' \
 *   node scripts/journey-check.mjs
 *
 * As contas são as da semente `scripts/seed-ui-fixture.mjs`: uma administradora
 * e um membro sem as permissões de administração.
 */
import { chromium } from "playwright";
import { existsSync, readdirSync } from "node:fs";

const base = process.env.JOURNEY_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.JOURNEY_ADMIN_EMAIL ?? "admin@vinculato.test";
const adminPassword = process.env.JOURNEY_ADMIN_PASSWORD ?? "";
const memberEmail = process.env.JOURNEY_MEMBER_EMAIL ?? "membro@vinculato.test";
const memberPassword = process.env.JOURNEY_MEMBER_PASSWORD ?? "";

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// O caminho do Chromium empacotado varia com a versão; procurar evita fixar um
// número de build que quebra o ensaio no próximo ambiente.
const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const chromiumDirectory = existsSync(browsersRoot)
  ? readdirSync(browsersRoot).find((entry) => /^chromium-\d+$/u.test(entry))
  : undefined;
const executablePath = chromiumDirectory ? `${browsersRoot}/${chromiumDirectory}/chrome-linux/chrome` : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

async function signIn(email, password) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 25000 }).catch(() => undefined),
    page.getByRole("button", { name: /^Entrar$/u }).last().click(),
  ]);
  await page.waitForTimeout(2000);
}

/** Sair como a interface sai: POST na rota, e o cookie deixa de valer. */
async function signOut() {
  await page.request.post(`${base}/api/auth/logout`, { headers: { Origin: base } }).catch(() => undefined);
  await context.clearCookies({ name: "fila_dp_session" }).catch(() => undefined);
}

const snapshot = async () => {
  const response = await page.request.get(`${base}/api/workspace`);
  if (!response.ok()) return null;
  return response.json();
};

/* ─────────────── J1: login → workspace → painel ─────────────── */
await signIn(adminEmail, adminPassword);
record("J1 o login leva ao painel", page.url().includes("/painel"), page.url());
const primeiro = await snapshot();
record("J1 o painel abre com um grupo operacional",
  Boolean(primeiro?.workspace?.id) && primeiro?.workspace?.operational === true,
  `${primeiro?.workspace?.name ?? "—"} (${primeiro?.workspace?.status ?? "—"})`);

/* ─────────────── J5: dois grupos, dado de um invisível no outro ─────────────── */
const grupos = (primeiro?.availableWorkspaces ?? []).filter((item) => item.operational);
if (grupos.length < 2) {
  record("J5 o ensaio precisa de dois grupos operacionais para comparar", false,
    `${grupos.length} grupo(s) — crie o segundo antes de rodar`);
} else {
  const [a, b] = grupos;
  const demandasDe = (dados) => new Set((dados?.lists ?? []).flatMap((list) => (list.cards ?? []).map((card) => card.id)));

  await page.request.post(`${base}/api/workspaces/select`, {
    headers: { Origin: base, "Content-Type": "application/json" },
    data: { workspaceId: a.id },
  });
  const dadosA = await snapshot();
  const demandasA = demandasDe(dadosA);

  await page.request.post(`${base}/api/workspaces/select`, {
    headers: { Origin: base, "Content-Type": "application/json" },
    data: { workspaceId: b.id },
  });
  const dadosB = await snapshot();
  const demandasB = demandasDe(dadosB);

  record("J5 a troca de grupo muda o contexto de verdade",
    dadosA?.workspace?.id === a.id && dadosB?.workspace?.id === b.id,
    `${dadosA?.workspace?.id} → ${dadosB?.workspace?.id}`);

  const vazadas = [...demandasA].filter((id) => demandasB.has(id));
  /* Conjunto vazio não prova isolamento: se um dos lados não tem demanda, a
     interseção é vazia por aritmética, não por segurança. O ensaio diz isso em
     vez de exibir um ✓ que não foi conquistado. */
  const comparavel = demandasA.size > 0 && demandasB.size > 0;
  record("J5 nenhuma demanda de um grupo aparece no outro",
    vazadas.length === 0 && comparavel,
    vazadas.length
      ? `vazaram: ${vazadas.slice(0, 3).join(", ")}`
      : comparavel
      ? `${demandasA.size} × ${demandasB.size} demanda(s), sem interseção`
      : `INCONCLUSIVO: ${demandasA.size} × ${demandasB.size} — um dos grupos está vazio, crie demanda nos dois`);

  // O grupo não é só a lista de demandas: empresa é dado de cliente também.
  const empresasDe = (dados) => new Set((dados?.companies ?? []).map((item) => item.id));
  const empresasVazadas = [...empresasDe(dadosA)].filter((id) => empresasDe(dadosB).has(id));
  record("J5 nenhuma empresa de um grupo aparece no outro", empresasVazadas.length === 0,
    empresasVazadas.length ? `vazaram: ${empresasVazadas.slice(0, 3).join(", ")}` : "sem interseção");

  /* Devolver o contexto ao grupo em que a pessoa estava.
     A troca grava preferência no banco e sobrevive ao fim do processo: sem esta
     linha, o ensaio deixa o usuário em outro grupo e o ensaio SEGUINTE mede o
     grupo errado — foi exatamente assim que `browser-check` passou a falhar no
     EPI, medindo um grupo que não era o dele. Ensaio não pode deixar rastro. */
  await page.request.post(`${base}/api/workspaces/select`, {
    headers: { Origin: base, "Content-Type": "application/json" },
    data: { workspaceId: primeiro.workspace.id },
  });
}

/* ─────────────── J7: sair e entrar em OUTRA conta ─────────────── */
await signOut();
await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);
record("J7 depois de sair, o painel exige autenticação de novo",
  page.url().includes("/login"), page.url());

await signIn(memberEmail, memberPassword);
record("J7 entrar em outra conta leva ao painel, e não de volta ao login",
  page.url().includes("/painel"), page.url());

const corpo = (await page.textContent("body")) ?? "";
record("J7 a sessão é da conta nova, sem vestígio da anterior",
  !corpo.includes(adminEmail), `procurado por "${adminEmail}" na tela`);

/* ─────────────── J6: recusa vem do servidor, não da tela ─────────────── */
const comoMembro = async (path, init = {}) => (await page.request.fetch(`${base}${path}`, {
  headers: { Origin: base, "Content-Type": "application/json" }, ...init,
})).status();

// A pessoa entrou como membro: estas são permissões que o papel não concede.
const auditoria = await comoMembro("/api/audit");
record("J6 membro sem audit.read é recusado pela API de auditoria",
  auditoria === 403, `HTTP ${auditoria} (403 esperado)`);

const plataforma = await comoMembro("/api/platform/workspaces");
record("J6 membro não alcança a administração da plataforma",
  plataforma === 403, `HTTP ${plataforma} (403 esperado)`);

const criarEmpresa = await comoMembro("/api/companies", {
  method: "POST",
  data: { legalName: "Empresa da Jornada", tradeName: "Jornada", taxId: "11222333000181" },
});
record("J6 membro sem companies.manage não cria empresa pela API",
  criarEmpresa === 403, `HTTP ${criarEmpresa} (403 esperado)`);

// Contraprova: a recusa acima precisa vir da permissão, e não de uma rota morta.
await signOut();
await signIn(adminEmail, adminPassword);
const auditoriaAdmin = await comoMembro("/api/audit");
record("J6 contraprova — a mesma rota responde ao administrador",
  auditoriaAdmin === 200, `HTTP ${auditoriaAdmin} (200 esperado)`);

record("nenhum erro de JavaScript no console durante as jornadas",
  consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

await browser.close();

const failures = results.filter((item) => !item.ok);
console.log(`\n${results.length - failures.length}/${results.length} jornadas verificadas.`);
if (failures.length) {
  console.log("Falhas:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
