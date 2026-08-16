/**
 * Gera a imagem de compartilhamento (`public/og-vinculato.jpg`).
 *
 * Por que existe um gerador em vez de um arquivo desenhado à mão:
 *
 * O site foi remarcado de Fila DP para Vinculato — nome, paleta, tipografia e
 * posicionamento. A imagem de compartilhamento ficou para trás. Durante meses,
 * todo link enviado no WhatsApp, no LinkedIn ou no Slack anunciou "Fila DP",
 * em verde, com o posicionamento antigo — enquanto o `og:title` ao lado dela
 * dizia "Vinculato — Sua operação, conectada.". O texto certo e a figura
 * contradizendo o texto.
 *
 * Nenhuma verificação pegava: `browser-check` confere que "Fila DP" não aparece
 * na página inicial e que o posicionamento anterior saiu, mas a imagem é um
 * binário referenciado só nos metadados. Ninguém a renderiza, então ninguém a
 * lê. É a mesma classe de defeito que esta auditoria encontrou seis vezes — a
 * conferência cobria o que conseguia enxergar, e a lacuna guardava o defeito.
 *
 * O conserto estrutural é este arquivo: o cartão passa a ser *derivado* da
 * marca em vez de desenhado ao lado dela. Ele lê o logotipo oficial de
 * `public/brand/`, as cores de `VINCULATO_BRAND` — extraídas dos pixels do
 * símbolo, não estimadas — e o posicionamento de `VINCULATO_TAGLINE`, o mesmo
 * que a home usa no `h1`. Trocar a marca passa a trocar o cartão; não trocar
 * fica impossível.
 *
 * Uso:
 *   npm run build          # as fontes da marca saem daqui
 *   npm run og:generate
 */
import { chromium } from "playwright";
import sharp from "sharp";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ALTURA, LARGURA, LIMITE_BYTES, SAIDA } from "./share-image.config.mjs";

const raiz = fileURLToPath(new URL("../", import.meta.url));

/* -------------------------------------------------------------------------- */
/* A marca, lida de onde o produto a define                                    */
/* -------------------------------------------------------------------------- */

/**
 * `VinculatoLogo.tsx` e `globals.css` são a fonte da verdade da identidade.
 * Ler os valores de lá — em vez de repetir os HEX aqui — é o que impede este
 * cartão de virar uma segunda definição da marca, divergindo em silêncio da
 * primeira. Foi exatamente assim que o `og.png` anterior envelheceu.
 */
function extrair(arquivo, padrao, nome) {
  const fonte = readFileSync(new URL(arquivo, import.meta.url), "utf8");
  const achado = fonte.match(padrao);
  if (!achado) throw new Error(`Não encontrei ${nome} em ${arquivo}. A marca mudou de lugar — atualize o gerador junto.`);
  return achado[1];
}

const marca = {
  navyDeep: extrair("../app/globals.css", /--vin-navy-deep:\s*(#[0-9A-Fa-f]{6})/u, "--vin-navy-deep"),
  navy: extrair("../app/globals.css", /--vin-navy:\s*(#[0-9A-Fa-f]{6})/u, "--vin-navy"),
  blue: extrair("../app/globals.css", /--vin-blue-vivid:\s*(#[0-9A-Fa-f]{6})/u, "--vin-blue-vivid"),
  teal: extrair("../app/globals.css", /--vin-teal:\s*(#[0-9A-Fa-f]{6})/u, "--vin-teal"),
  onBrandText: extrair("../app/globals.css", /--on-brand-text:\s*(#[0-9A-Fa-f]{6})/u, "--on-brand-text"),
  onBrandSoft: extrair("../app/globals.css", /--on-brand-soft:\s*(#[0-9A-Fa-f]{6})/u, "--on-brand-soft"),
  accentOnDark: extrair("../app/globals.css", /--brand-accent-on-dark:\s*(#[0-9A-Fa-f]{6})/u, "--brand-accent-on-dark"),
  tagline: extrair("../app/components/VinculatoLogo.tsx", /VINCULATO_TAGLINE = "([^"]+)"/u, "VINCULATO_TAGLINE"),
  logoLight: extrair("../app/components/VinculatoLogo.tsx", /logoLightSource: "([^"]+)"/u, "logoLightSource"),
};

/**
 * O descritor. É o `openGraph.description` do layout, palavra por palavra — o
 * mesmo texto que já acompanha a imagem no compartilhamento. Cortá-lo aqui
 * criaria uma segunda versão da frase, que é como a marca antiga sobreviveu
 * neste arquivo em primeiro lugar.
 */
const descricao = extrair("../app/layout.tsx", /openGraph:[\s\S]*?description: "([^"]+)"/u, "openGraph.description");

/** Proporção real do logotipo, lida do componente que o produto usa. */
const logoRatio = (() => {
  const bruto = extrair("../app/components/VinculatoLogo.tsx", /logoRatio: (\d+ \/ \d+)/u, "logoRatio");
  const [w, h] = bruto.split("/").map((n) => Number(n.trim()));
  return w / h;
})();

/**
 * Módulos reais do produto, não promessas. Ficam no cartão porque §44 pede a
 * plataforma como protagonista visual — e três palavras verdadeiras dizem mais,
 * em miniatura, que um mockup ilegível.
 */
const modulos = ["Demandas", "Competências", "Integrações"];

/* -------------------------------------------------------------------------- */
/* Tipografia da marca                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Manrope nos títulos e Inter no corpo, as mesmas que o site carrega.
 *
 * Os arquivos saem do build — `next/font` os baixa e versiona. O gerador
 * **falha** se não os encontrar, em vez de cair numa fonte do sistema: um
 * cartão que silenciosamente troca a tipografia da marca é o defeito que este
 * arquivo existe para impedir, com outra roupa.
 */
function fontesDaMarca() {
  const estatico = `${raiz}.next/static`;
  if (!existsSync(estatico)) {
    throw new Error("Sem build: rode `npm run build` antes. As fontes da marca saem de .next/static/.");
  }
  // O Next já emitiu o CSS em `static/css` e hoje o emite em `static/chunks`.
  // Varrer em vez de fixar a pasta evita que uma mudança de layout do build
  // devolva o cartão à tipografia do sistema em silêncio.
  const css = readdirSync(estatico, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".css"))
    .map((e) => readFileSync(`${e.parentPath ?? e.path}/${e.name}`, "utf8")).join("\n");

  const regras = [];
  for (const bloco of css.match(/@font-face\{[^}]*\}/gu) ?? []) {
    const familia = bloco.match(/font-family:\s*['"]?([^;'"]+)['"]?;/u)?.[1]?.trim();
    const arquivo = bloco.match(/src:url\([^)]*\/media\/([^)]+)\)/u)?.[1];
    const peso = bloco.match(/font-weight:\s*([^;]+);/u)?.[1]?.trim() ?? "400";
    if (!familia || !arquivo) continue;
    const caminho = `${raiz}.next/static/media/${arquivo}`;
    if (!existsSync(caminho)) continue;
    regras.push({ familia, peso, base64: readFileSync(caminho).toString("base64") });
  }

  for (const exigida of ["Manrope", "Inter"]) {
    if (!regras.some((r) => r.familia === exigida)) {
      throw new Error(`A fonte ${exigida} não está no build. O cartão não pode sair com tipografia trocada.`);
    }
  }
  return regras.map((r) =>
    `@font-face{font-family:"${r.familia}";font-weight:${r.peso};font-style:normal;`
    + `src:url(data:font/woff2;base64,${r.base64}) format("woff2");}`).join("\n");
}

/* -------------------------------------------------------------------------- */
/* O cartão                                                                    */
/* -------------------------------------------------------------------------- */

function cartao(fontes, logoBase64) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
${fontes}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${LARGURA}px;height:${ALTURA}px;overflow:hidden;
  font-family:"Inter",sans-serif;color:${marca.onBrandText};
  background:${marca.navyDeep};position:relative}

/* O brilho da marca: o mesmo azul vivo que o produto usa nas superfícies
   escuras, contido num canto para não competir com o texto. */
.glow{position:absolute;inset:0;
  background:
    radial-gradient(1100px 620px at 88% 8%, ${marca.blue}38, transparent 62%),
    radial-gradient(680px 460px at 96% 96%, ${marca.teal}2E, transparent 66%),
    linear-gradient(160deg, ${marca.navyDeep} 0%, ${marca.navy} 100%);}

/* Traço fino de acento na borda inferior — a "conexão" da marca, sem virar
   enfeite: é a única forma decorativa do cartão. */
.rule{position:absolute;left:0;right:0;bottom:0;height:8px;
  background:linear-gradient(90deg, ${marca.blue} 0%, ${marca.teal} 58%, transparent 100%);}

.card{position:relative;height:100%;display:flex;flex-direction:column;
  justify-content:space-between;align-items:flex-start;padding:70px 78px 76px}

/* O "align-items:flex-start" acima é o que impede o logotipo de esticar: num
   contêiner flex em coluna o eixo transversal é o horizontal, e o padrão
   "stretch" levava a imagem à largura inteira do cartão. Largura e altura saem
   da proporção real do arquivo, não de estimativa. */
.logo{display:block;height:52px;width:${Math.round(52 * logoRatio)}px}

h1{font-family:"Manrope",sans-serif;font-weight:800;font-size:76px;line-height:1.05;
  letter-spacing:-.03em;max-width:13ch}
p{margin-top:22px;font-size:25px;line-height:1.5;color:${marca.onBrandSoft};max-width:34ch}

.chips{display:flex;gap:11px;align-items:center}
.chips span{padding:9px 19px;border-radius:999px;border:1px solid ${marca.accentOnDark}4D;
  font-size:20px;font-weight:600;color:${marca.accentOnDark};white-space:nowrap}
</style></head><body>
<div class="glow"></div>
<div class="card">
  <img class="logo" src="data:image/png;base64,${logoBase64}" alt="Vinculato">
  <div>
    <h1>${marca.tagline}</h1>
    <p>${descricao}</p>
  </div>
  <div class="chips">${modulos.map((m) => `<span>${m}</span>`).join("")}</div>
</div>
<div class="rule"></div>
</body></html>`;
}

/* -------------------------------------------------------------------------- */

const logo = `${raiz}public${marca.logoLight}`;
if (!existsSync(logo)) throw new Error(`Logotipo oficial ausente em ${logo}.`);

const executavel = (() => {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(base)) return undefined;
  const pasta = readdirSync(base).find((e) => /^chromium-\d+$/u.test(e));
  return pasta ? `${base}/${pasta}/chrome-linux/chrome` : undefined;
})();

const browser = await chromium.launch(executavel ? { executablePath: executavel } : {});
const page = await browser.newPage({ viewport: { width: LARGURA, height: ALTURA }, deviceScaleFactor: 1 });
await page.setContent(cartao(fontesDaMarca(), readFileSync(logo).toString("base64")), { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

// Conferência antes de gravar: se a tipografia da marca não carregou, o cartão
// sai com outra letra e ninguém percebe até estar publicado.
const carregou = await page.evaluate(() =>
  document.fonts.check('800 82px Manrope') && document.fonts.check('600 21px Inter'));
if (!carregou) throw new Error("As fontes da marca não carregaram no cartão.");

const png = await page.screenshot({ type: "png" });
await browser.close();

/**
 * Sai em JPEG, e com nome novo.
 *
 * O peso importa: o cartão anterior tinha 1,4 MB, e o WhatsApp — o canal onde
 * um link de produto de DP realmente circula no Brasil — deixa de montar a
 * pré-visualização rica quando a imagem é grande demais. Um degradê liso em PNG
 * é justamente o pior caso de compressão sem perdas; em JPEG de qualidade alta
 * ele fica visualmente idêntico por uma fração do tamanho.
 *
 * O nome novo não é cosmético. Plataformas guardam a imagem de compartilhamento
 * em cache **pela URL**: mantendo `og.png`, o cartão "Fila DP" continuaria sendo
 * servido dos caches do WhatsApp, do LinkedIn e do Slack por tempo indefinido,
 * mesmo com o arquivo trocado. Endereço novo é o que garante o descarte.
 */
const jpeg = await sharp(png).jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
writeFileSync(`${raiz}${SAIDA}`, jpeg);

console.log(`${SAIDA} — ${LARGURA}×${ALTURA}, ${(jpeg.length / 1024).toFixed(0)} KB (PNG seria ${(png.length / 1024).toFixed(0)} KB)`);
console.log(`  marca: ${marca.navy} · ${marca.blue} · logotipo ${marca.logoLight}`);
console.log(`  texto: "${marca.tagline}"`);
if (jpeg.length > LIMITE_BYTES) {
  console.error(`\nAcima de ${(LIMITE_BYTES / 1024).toFixed(0)} KB — a pré-visualização rica deixa de montar em alguns aplicativos.`);
  process.exit(1);
}
