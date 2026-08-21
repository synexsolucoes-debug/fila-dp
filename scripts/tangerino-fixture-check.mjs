/**
 * Verificação do agente Tangerino contra fixtures, com navegador de verdade.
 *
 * Fica fora de `npm test` de propósito: levantar Chromium custa segundos, e a
 * suíte de unidade do repositório roda em menos de um. Esta verificação segue o
 * mesmo lugar que `a11y-check` e `browser-check` já ocupam — o trabalho pesado
 * de navegador roda por script, e o `interface` no CI o executa.
 *
 * O QUE ELA PROVA
 *   Que `readAdmissionFrom`, `collectSearchHits`, `detectAuthBarrier` e
 *   `hasCaptchaWidget` — o mesmo código que roda em produção, não uma cópia —
 *   leem o que existe na página, e que a ausência de um campo crítico vira
 *   `UI_CHANGED` (§65).
 *
 * O QUE ELA NÃO PROVA
 *   Que a tela real do Tangerino se parece com estas fixtures. Não se parece
 *   necessariamente: elas foram escritas sem acesso autorizado ao sistema. Até o
 *   mapeamento da §72 acontecer, verde aqui significa "a mecânica está certa",
 *   e nada sobre o Tangerino.
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  collectSearchHits,
  detectAuthBarrier,
  hasCaptchaWidget,
  readAdmissionFrom,
} from "../worker/tangerino/playwright-session.ts";
import { TangerinoAgentError } from "../lib/tangerino/errors.ts";
import { chooseAdmission, parseAdmission } from "../lib/tangerino/parser.ts";

const FIXTURES = new URL("../tests/fixtures/tangerino/", import.meta.url);
const fixtureUrl = (name) => `file://${fileURLToPath(new URL(name, FIXTURES))}`;

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function launchOptions() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(root)) return {};
  const found = readdirSync(root).find((entry) => /^chromium-\d+$/u.test(entry));
  return found ? { executablePath: `${root}/${found}/chrome-linux/chrome` } : {};
}

const browser = await chromium.launch({ headless: true, ...launchOptions() });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "pt-BR" });

try {
  /* ── Barreiras de autenticação ──────────────────────────────────────────── */
  for (const [fixture, expected] of [
    ["login.html", "login"],
    ["mfa.html", "mfa"],
    ["captcha.html", "captcha"],
    ["sessao-expirada.html", "login"],
  ]) {
    await page.goto(fixtureUrl(fixture), { waitUntil: "domcontentloaded" });
    const barrier = detectAuthBarrier(await page.locator("body").innerText(), await hasCaptchaWidget(page));
    check(`${fixture} é reconhecida como "${expected}"`, barrier === expected, `veio "${barrier}"`);
  }

  /* MFA e CAPTCHA precisam ser distinguidos da tela de login comum: confundi-los
     faria o agente digitar a senha num campo de código de verificação, e repetir
     isso bloqueia a conta do cliente (§16). */
  await page.goto(fixtureUrl("mfa.html"), { waitUntil: "domcontentloaded" });
  check("MFA não é confundida com login", detectAuthBarrier(await page.locator("body").innerText()) !== "login");

  /* O caso que esta verificação descobriu: a tela de CAPTCHA também diz
     "Acessar sua conta", e o desafio vive num iframe sem escrever a palavra em
     lugar nenhum. Detectar só por texto a classificaria como login. */
  await page.goto(fixtureUrl("captcha.html"), { waitUntil: "domcontentloaded" });
  const textoCaptcha = await page.locator("body").innerText();
  check("o widget de CAPTCHA é encontrado no DOM", await hasCaptchaWidget(page));
  check("sem o widget, o texto sozinho classificaria como login",
    detectAuthBarrier(textoCaptcha, false) === "login" && detectAuthBarrier(textoCaptcha, true) === "captcha");

  /* ── Pesquisa ───────────────────────────────────────────────────────────── */
  await page.goto(fixtureUrl("admissoes.html"), { waitUntil: "domcontentloaded" });
  const hits = await collectSearchHits(page);
  check("a pesquisa lê as linhas do resultado", hits.length === 2, `${hits.length} linha(s)`);
  check("o cabeçalho da tabela não vira resultado", !hits.some((hit) => /Colaborador\b.*Admissão/u.test(hit.label)));
  check("o identificador do processo vem da linha", hits[0]?.id === "ADM-4711", hits[0]?.id);

  await page.goto(fixtureUrl("admissoes-vazio.html"), { waitUntil: "domcontentloaded" });
  const vazio = await collectSearchHits(page);
  check("resultado vazio devolve nenhuma linha", vazio.length === 0);
  check("nenhum resultado vira NOT_FOUND", (() => {
    try { chooseAdmission(vazio, ""); return false; } catch (error) {
      return error instanceof TangerinoAgentError && error.state === "NOT_FOUND";
    }
  })());

  await page.goto(fixtureUrl("admissoes-duplicadas.html"), { waitUntil: "domcontentloaded" });
  const duplicadas = await collectSearchHits(page);
  check("duas linhas homônimas são lidas como duas", duplicadas.length === 2);
  check("duplicidade vira MULTIPLE_MATCHES, e não uma escolha", (() => {
    try { chooseAdmission(duplicadas, ""); return false; } catch (error) {
      return error instanceof TangerinoAgentError && error.state === "MULTIPLE_MATCHES";
    }
  })());
  check("o vínculo já salvo desfaz o empate", chooseAdmission(duplicadas, "ADM-4899").id === "ADM-4899");

  /* ── Leitura do processo ────────────────────────────────────────────────── */
  await page.goto(fixtureUrl("processo.html"), { waitUntil: "domcontentloaded" });
  const snapshot = await readAdmissionFrom(page);
  const admission = parseAdmission(snapshot);
  check("a situação é lida da tela", admission.rawStatus === "Documentação em análise", admission.rawStatus);
  check("a situação é traduzida", admission.normalizedStatus === "DOCUMENT_ANALYSIS", admission.normalizedStatus);
  check("a etapa é lida", admission.stage === "Documentação", admission.stage);
  check("a pendência é lida", /Comprovante de residência/u.test(admission.pendingReason), admission.pendingReason);
  check("a data vira ISO", admission.admissionDate === "2026-09-01", admission.admissionDate);
  check("a última atualização vira ISO com hora", admission.sourceUpdatedAt === "2026-08-21T14:30", admission.sourceUpdatedAt);
  check("o código do processo é lido", admission.externalAdmissionId === "ADM-4711", admission.externalAdmissionId);

  for (const [fixture, expected] of [
    ["processo-aguardando-documentos.html", "WAITING_DOCUMENTS"],
    ["processo-aguardando-assinatura.html", "WAITING_SIGNATURE"],
    ["processo-concluida.html", "COMPLETED"],
  ]) {
    await page.goto(fixtureUrl(fixture), { waitUntil: "domcontentloaded" });
    const parsed = parseAdmission(await readAdmissionFrom(page));
    check(`${fixture} → ${expected}`, parsed.normalizedStatus === expected, parsed.normalizedStatus);
  }

  /* ── A verificação da §65 ───────────────────────────────────────────────── */
  await page.goto(fixtureUrl("processo-sem-situacao.html"), { waitUntil: "domcontentloaded" });
  const semSituacao = await readAdmissionFrom(page);
  let resultado = "não lançou";
  try {
    const inferido = parseAdmission(semSituacao);
    resultado = `devolveu ${inferido.normalizedStatus}`;
  } catch (error) {
    resultado = error instanceof TangerinoAgentError ? error.state : "erro inesperado";
  }
  /* O teste que mais importa deste arquivo. Tirar um elemento esperado precisa
     produzir "a tela mudou", e nunca um status por inferência: um COMPLETED
     errado é acreditado e faz alguém admitir no ERP quem ainda não está pronto. */
  check("tela sem situação devolve UI_CHANGED, e nunca um status inferido", resultado === "UI_CHANGED", resultado);
  check("os demais campos continuam sendo lidos", semSituacao.stage === "Documentação", semSituacao.stage);
} finally {
  await browser.close();
}

console.log(`\n${passed} verificação(ões) de fixture passaram.`);
if (failures.length) {
  console.log(`${failures.length} falharam:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
}
