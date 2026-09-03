import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";
import {
  commercialCommitments, describePlanOffer, negotiatedPlanCodes, planLimitBehaviour,
  RECOMMENDED_PLAN_CODE, SIGNUP_PATH, siteNavigation, type PlanCatalogRow,
} from "../lib/marketing.ts";
import { publicPages } from "../lib/site-map.ts";
import { selfSignupEnabled } from "../lib/saas.ts";

/**
 * Prontidão comercial do site (lançamento).
 *
 * Três defeitos que este arquivo existe para não deixar voltar, todos medidos
 * contra o produto e não deduzidos:
 *
 * 1. **Botão para lugar nenhum.** A promessa do lançamento é que todo CTA
 *    funcione. Um `href` para uma rota que não existe é 404 em produção e nada
 *    em desenvolvimento — nenhum teste de tipo o pega.
 * 2. **Preço escrito na página.** Home e /planos já tiveram o mesmo SELECT e a
 *    mesma derivação copiados; basta uma das cópias mudar para o site anunciar
 *    uma condição que a cobrança recusa.
 * 3. **Página pública sem auditoria.** A varredura WCAG media a home e o login
 *    e mais nada de fora do produto. Uma página que entra no sitemap e não entra
 *    na varredura nasce sem medição, e o relatório continua dizendo "0".
 */

const appRoot = new URL("../app/", import.meta.url);

async function walk(dir: URL, extensions: string[]): Promise<URL[]> {
  const found: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) found.push(...await walk(child, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(child);
  }
  return found;
}

const existe = async (url: URL) => Boolean(await stat(url).catch(() => null));

/** Rotas que o Next serve sem `page.tsx`: arquivos de metadados e a API. */
const ROTAS_SEM_PAGINA = new Set(["/sitemap.xml", "/robots.txt", "/og-vinculato.jpg"]);

test("todo destino do site público existe como rota", async () => {
  // Só as superfícies públicas: o painel resolve destino por estado, não por
  // `href` literal, e tem a própria conferência de alcance.
  const arquivos = [
    new URL("page.tsx", appRoot),
    ...await walk(new URL("site/", appRoot), [".tsx"]),
    ...await walk(new URL("components/", appRoot), [".tsx"]),
    ...await Promise.all(publicPages
      .filter((page) => page.path !== "/")
      .map((page) => new URL(`${page.path.slice(1)}/`, appRoot))
      .map((dir) => walk(dir, [".tsx"]))).then((listas) => listas.flat()),
  ];

  const quebrados: string[] = [];
  for (const arquivo of arquivos) {
    const fonte = await readFile(arquivo, "utf8");
    for (const match of fonte.matchAll(/href="(\/[^"#?]*)/gu)) {
      const rota = match[1].replace(/\/$/u, "") || "/";
      if (ROTAS_SEM_PAGINA.has(rota)) continue;
      const pagina = rota === "/"
        ? new URL("page.tsx", appRoot)
        : new URL(`${rota.slice(1)}/page.tsx`, appRoot);
      if (!await existe(pagina)) quebrados.push(`${arquivo.pathname.split("/app/")[1]} → ${rota}`);
    }
  }
  assert.deepEqual(quebrados, [], `destino público sem página: ${quebrados.join(", ")}`);
});

test("a navegação do site aponta apenas para páginas publicadas", () => {
  const publicadas = new Set(publicPages.map((page) => page.path));
  for (const item of siteNavigation) {
    assert.ok(publicadas.has(item.href), `${item.href} está no menu e fora do sitemap`);
  }
});

test("o cadastro gratuito só é oferecido quando existe página para recebê-lo", async () => {
  // O CTA "Começar grátis" só é renderizado com `selfSignupEnabled()`. Ligar a
  // chave sem publicar a página deixaria o botão principal da home em 404 —
  // as duas entregas andam juntas, e é isso que esta conferência cobra.
  if (!selfSignupEnabled()) return;
  const pagina = new URL(`${SIGNUP_PATH.slice(1)}/page.tsx`, appRoot);
  assert.ok(await existe(pagina), `cadastro público ligado sem a página ${SIGNUP_PATH}`);
});

test("nenhuma página comercial escreve preço no código", async () => {
  const arquivos = [new URL("page.tsx", appRoot), new URL("planos/page.tsx", appRoot)];
  for (const arquivo of arquivos) {
    const fonte = await readFile(arquivo, "utf8");
    // Valor em reais escrito à mão, com ou sem símbolo: o preço vem do catálogo.
    assert.doesNotMatch(fonte, /R\$\s?\d/u, `${arquivo.pathname} tem preço literal`);
    assert.doesNotMatch(fonte, /\b(?:9700|29700|79700)\b/u, `${arquivo.pathname} tem preço em centavos literal`);
  }
});

const catalogo = (over: Partial<PlanCatalogRow> = {}): PlanCatalogRow => ({
  code: "standard", name: "Standard", description: "", currency: "brl",
  monthly_price_cents: 9700, annual_price_cents: 0, trial_days: 0,
  included_seats: 10, company_limit: 5, integration_limit: 3, storage_limit_mb: 5120,
  stripe_monthly_price_id: "", ...over,
});

test("plano pago sem preço no provedor não oferece contratação direta", () => {
  const offer = describePlanOffer(catalogo(), { signupOpen: true });
  assert.equal(offer.contracting, "specialist");
  assert.equal(offer.ctaLabel, "Falar com especialista");
  assert.match(offer.ctaHref, /^\/contato\?assunto=planos&plano=standard$/u);
});

test("plano pago com preço configurado abre contratação autenticada", () => {
  const offer = describePlanOffer(catalogo({ stripe_monthly_price_id: "price_123" }), { signupOpen: true });
  assert.equal(offer.contracting, "checkout");
  assert.equal(offer.ctaLabel, "Assinar Standard");
  // Assinatura pertence a um workspace: o caminho passa pela autenticação.
  assert.match(offer.ctaHref, /^\/login\?return_to=/u);
});

test("cadastro fechado nunca oferece o plano gratuito", () => {
  const gratuito = catalogo({ code: "starter", name: "Starter", monthly_price_cents: 0 });
  assert.equal(describePlanOffer(gratuito, { signupOpen: false }).contracting, "specialist");
  const aberto = describePlanOffer(gratuito, { signupOpen: true });
  assert.equal(aberto.contracting, "free");
  assert.equal(aberto.ctaLabel, "Começar grátis");
  assert.equal(aberto.ctaHref, SIGNUP_PATH);
});

test("plano negociado não publica preço, mesmo com valor no catálogo", () => {
  // O catálogo guarda um número para o Enterprise porque a cobrança precisa de
  // um; publicá-lo como preço fechado venderia uma condição que ninguém
  // contratou assim.
  const enterprise = catalogo({ code: "enterprise", name: "Enterprise", monthly_price_cents: 79700, stripe_monthly_price_id: "price_ent" });
  const offer = describePlanOffer(enterprise, { signupOpen: true });
  assert.ok(negotiatedPlanCodes.includes("enterprise"));
  assert.equal(offer.price, "Sob consulta");
  assert.equal(offer.contracting, "specialist");
  assert.doesNotMatch(offer.priceNote, /797/u);
});

test("o recomendado é um só, e é o Standard", () => {
  assert.equal(RECOMMENDED_PLAN_CODE, "standard");
  assert.equal(describePlanOffer(catalogo(), { signupOpen: true }).recommended, true);
  assert.equal(describePlanOffer(catalogo({ code: "premium", name: "Premium" }), { signupOpen: true }).recommended, false);
});

test("os limites exibidos vêm do catálogo, com concordância de número", () => {
  const offer = describePlanOffer(catalogo({ included_seats: 1, company_limit: 1, integration_limit: 1, storage_limit_mb: 1024 }), { signupOpen: true });
  const valores = offer.limits.map((limit) => limit.value);
  assert.ok(valores.includes("1 usuário"), valores.join(" | "));
  assert.ok(valores.includes("1 empresa"), valores.join(" | "));
  assert.ok(valores.includes("1 integração"), valores.join(" | "));
  assert.ok(valores.includes("1 GB"), valores.join(" | "));
});

test("o site não anuncia troca de plano pelo painel enquanto ela não existir", async () => {
  // A página de planos já afirmou que "upgrade, downgrade e cancelamento são
  // feitos no próprio painel". Não são: não há tela de assinatura no painel, e
  // nenhum componente consome /api/saas/checkout ou /api/saas/portal.
  const painel = await walk(new URL("painel/", appRoot), [".tsx"]);
  const consomeCobranca = await Promise.all(painel.map(async (arquivo) => /api\/saas\/(checkout|portal)/u.test(await readFile(arquivo, "utf8"))));
  const disponivel = consomeCobranca.some(Boolean);

  const mudanca = commercialCommitments.find((item) => item.title === "Mudança de plano");
  assert.ok(mudanca, "falta o compromisso de mudança de plano");
  if (!disponivel) {
    assert.match(mudanca.text, /ainda não está disponível/u,
      "sem tela de assinatura no painel, o site não pode dizer que a troca é feita lá");
  }

  const planos = await readFile(new URL("planos/page.tsx", appRoot), "utf8");
  if (!disponivel) {
    assert.doesNotMatch(planos, /feitos no próprio painel/u);
  }
});

test("o site explica o que acontece em cada limite do catálogo", () => {
  const cobertos = planLimitBehaviour.map((item) => item.limit);
  for (const limite of ["Usuários", "Empresas", "Integrações", "Armazenamento"]) {
    assert.ok(cobertos.includes(limite as (typeof cobertos)[number]), `limite sem explicação: ${limite}`);
  }
  // Nenhum limite pode ser descrito como perda de dado: o produto recusa a
  // próxima ação, não apaga o que já existe.
  for (const item of planLimitBehaviour) {
    assert.doesNotMatch(item.behaviour, /\bapaga(?!do pelo sistema)\w*\b(?! nenhum)/u, item.limit);
  }
});

test("a varredura WCAG cobre todas as páginas públicas do sitemap", async () => {
  const script = await readFile(new URL("../scripts/a11y-check.mjs", import.meta.url), "utf8");
  const bloco = script.split("const PAGINAS_PUBLICAS = [")[1]?.split("];")[0] ?? "";
  const faltando = publicPages
    .map((page) => page.path)
    .filter((path) => !new RegExp(`"${path}"\\]`, "u").test(bloco));
  assert.deepEqual(faltando, [], `página pública fora da varredura: ${faltando.join(", ")}`);

  // E o piso precisa acompanhar: uma varredura maior com piso antigo volta a
  // tolerar o colapso que o piso existe para acusar.
  const piso = Number(script.match(/const MINIMO_DE_TELAS = (\d+);/u)?.[1]);
  assert.ok(piso >= 75, `piso de cobertura ficou para trás: ${piso}`);
});
