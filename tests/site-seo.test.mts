import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { privatePaths, publicOrigin, publicPages } from "../lib/site-map.ts";

/**
 * §45 e §46: o site precisa ser encontrável.
 *
 * Dois defeitos medidos contra o site de pé, não deduzidos do código.
 *
 * O primeiro: `alternates: { canonical: origin }` estava no layout, e no Next
 * o layout é herdado. Toda página declarava a home como sua canônica —
 * /planos, /funcionalidades, /faq, /privacidade e /termos diziam ao buscador
 * "eu sou uma cópia da home". A consequência normal disso é a página sair do
 * índice, e /planos e /funcionalidades são justamente as comerciais.
 *
 * O segundo: /robots.txt e /sitemap.xml respondiam 404.
 */

const pages = await (async () => {
  const raiz = new URL("../app/", import.meta.url);
  const encontrados = new Map<string, string>();
  for (const entry of await readdir(raiz, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "page.tsx") encontrados.set("/", await readFile(new URL("page.tsx", raiz), "utf8"));
    if (!entry.isDirectory()) continue;
    const arquivo = new URL(`${entry.name}/page.tsx`, raiz);
    const fonte = await readFile(arquivo, "utf8").catch(() => null);
    if (fonte) encontrados.set(`/${entry.name}`, fonte);
  }
  return encontrados;
})();

test("cada página pública declara a si mesma como canônica", () => {
  const erradas: string[] = [];
  for (const page of publicPages) {
    const fonte = pages.get(page.path);
    assert.ok(fonte, `${page.path} está no sitemap e não existe como página`);
    if (!new RegExp(`canonical: "${page.path}"`, "u").test(fonte)) erradas.push(page.path);
  }
  assert.deepEqual(erradas, [], "página sem canônica própria volta a se declarar cópia da home");
});

test("o layout não impõe uma canônica a todas as páginas", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const codigo = layout.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  assert.doesNotMatch(codigo, /alternates:\s*\{\s*canonical:\s*origin/u,
    "a canônica global volta a dizer que toda página é cópia da home");
  // `metadataBase` fica: é ele que resolve os caminhos relativos das páginas.
  assert.match(layout, /metadataBase: new URL\(origin\)/u);
});

test("sitemap e robots existem e falam da mesma lista", async () => {
  const sitemap = await readFile(new URL("../app/sitemap.ts", import.meta.url), "utf8");
  const robots = await readFile(new URL("../app/robots.ts", import.meta.url), "utf8");
  assert.match(sitemap, /publicPages\.map/u);
  assert.match(robots, /disallow: \[\.\.\.privatePaths\]/u);
  assert.match(robots, /sitemap: `\$\{origin\}\/sitemap\.xml`/u);

  // Uma lista só. Mantê-las separadas garantiria o desencontro: alguém
  // acrescenta uma página, esquece do sitemap, e ela nasce invisível.
  assert.ok(publicPages.length >= 10, "o sitemap encolheu — confira se foi de propósito");
  for (const privado of ["/painel", "/plataforma", "/api"]) {
    assert.ok((privatePaths as readonly string[]).includes(privado), `${privado} precisa ficar fora do rastreio`);
  }
});

test("nenhuma página privada entrou no sitemap", () => {
  for (const page of publicPages) {
    for (const privado of privatePaths) {
      assert.ok(!page.path.startsWith(privado), `${page.path} é área logada e não é conteúdo`);
    }
  }
});

test("a origem pública é configurável e recusa lixo", () => {
  // O domínio real ainda não está definido (§46). A variável é o lugar de dizer
  // qual é quando ele existir; sem ela, a reserva é o endereço de hoje — e não
  // um placeholder que iria para o sitemap de produção.
  const anterior = process.env.FDP_PUBLIC_ORIGIN;
  try {
    process.env.FDP_PUBLIC_ORIGIN = "https://vinculato.com.br";
    assert.equal(publicOrigin(), "https://vinculato.com.br");
    process.env.FDP_PUBLIC_ORIGIN = "https://vinculato.com.br/";
    assert.equal(publicOrigin(), "https://vinculato.com.br", "a barra final duplicaria no sitemap");
    process.env.FDP_PUBLIC_ORIGIN = "não é uma origem";
    assert.match(publicOrigin(), /^https:\/\//u, "origem inválida não pode virar URL do sitemap");
  } finally {
    if (anterior === undefined) delete process.env.FDP_PUBLIC_ORIGIN;
    else process.env.FDP_PUBLIC_ORIGIN = anterior;
  }
});
