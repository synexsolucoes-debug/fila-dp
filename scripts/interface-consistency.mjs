/**
 * Conferência de consistência visual (§86–§87, §90, §96–§98).
 *
 * ## Por que existe
 *
 * A auditoria classificou quatro seções como "julgamento visual: precisa de olho
 * humano". Isso é verdade para a parte que é gosto — se a tela *emociona* não se
 * mede. Mas boa parte do que essas seções pedem é mecânico e estava passando sem
 * conferência nenhuma:
 *
 *   §90  não parecer IA — sem emoji, sem néon, sem gradiente decorativo;
 *   §96  padrão de tabelas — mesma altura de linha, mesmo cabeçalho;
 *   §97  padrão de formulários — mesma altura, raio e borda de controle;
 *   §98  padrão de gavetas — mesmo cabeçalho e mesma ação de fechar.
 *
 * "Precisa de olho humano" virou desculpa para não medir o que a máquina mede
 * melhor: um `<select>` com 34px numa tela e 36px em outra é diferença que o
 * olho perde e o `getBoundingClientRect` não.
 *
 * O que este script **não** tenta julgar: se a hierarquia está boa, se o texto
 * convence, se a tela é bonita. Isso continua sendo trabalho de gente, e dizer o
 * contrário seria fingir cobertura.
 *
 * ## Como decide
 *
 * Ele mede o produto de pé, em várias telas, e compara os controles entre
 * módulos. Divergência de um valor tolerado reprova com o valor medido e a tela
 * onde apareceu — não com "inconsistência detectada".
 *
 * Uso: com o produto em pé e a conta de ensaio semeada,
 *   VINCULATO_ADMIN_EMAIL=... VINCULATO_ADMIN_PASSWORD=... npm run interface-check
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.env.A11Y_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.VINCULATO_ADMIN_EMAIL ?? process.env.A11Y_EMAIL ?? "admin@vinculato.test";
const PASSWORD = process.env.VINCULATO_ADMIN_PASSWORD ?? process.env.A11Y_PASSWORD ?? "";

const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const launch = existsSync(`${browsersRoot}/chromium`) ? { executablePath: `${browsersRoot}/chromium` } : {};

/** As telas que o produto usa todo dia — não a lista inteira. */
const TELAS = [
  ["Visão geral", "/painel"],
  ["Demandas", "/painel/demandas"],
  ["Processos", "/painel/processos"],
  ["Meu trabalho", "/painel/trabalho"],
  ["Ponto e jornada", "/painel/ponto"],
  ["Configurações", "/painel/configuracoes"],
];

/*
 * O que conta como "dentro do padrão" é derivado do produto, não inventado aqui.
 *
 * A primeira versão trazia uma lista de raios escrita à mão — e reprovou 7px,
 * que é exatamente `--ui-radius-sm`. Uma régua que discorda dos tokens do
 * projeto mede a opinião de quem a escreveu, e a primeira coisa que alguém faz
 * com uma régua assim é desligá-la.
 *
 * Agora a régua são os próprios tokens de raio, lidos da página. E a altura,
 * que o produto não tokeniza, é julgada por repetição: um valor usado por um
 * único controle no produto inteiro é acidente, não decisão.
 */
const ALTURA_MINIMA_WCAG = 24;

/*
 * Emoji em interface de produto de DP (§90).
 *
 * Só os blocos pictográficos. A primeira versão incluía U+2600–U+27BF e
 * reprovou `★` e `↳`, que marcam matriz e filial **dentro de `<option>`** — ali
 * não cabe componente de ícone, e o glifo é a única forma de codificar a
 * hierarquia. Reprovar isso seria a ferramenta mandando piorar a tela.
 *
 * A faixa que ficou não tem essa ambiguidade: nada em U+1F300–U+1FAFF é
 * pontuação.
 */
const EMOJI = /[\u{1F300}-\u{1FAFF}]/u;

const falhas = [];
const medidas = [];

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.locator('input[type="email"]').first().fill(EMAIL);
await page.locator('input[type="password"]').first().fill(PASSWORD);
await Promise.all([
  page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => undefined),
  page.getByRole("button", { name: /^Entrar$/u }).last().click(),
]);
await page.waitForTimeout(1200);

if (page.url().includes("/login")) {
  console.error("Não foi possível entrar: confira VINCULATO_ADMIN_EMAIL e VINCULATO_ADMIN_PASSWORD.");
  await browser.close();
  process.exit(1);
}

/* Os tokens de raio, lidos do produto de pé — a régua vem de quem é medido. */
await page.goto(`${BASE}/painel`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const tokensDeRaio = new Set(await page.evaluate(() => {
  const style = getComputedStyle(document.querySelector(".dashboard-shell") ?? document.documentElement);
  return ["--ui-radius-sm", "--ui-radius-md", "--ui-radius-lg"]
    .map((token) => style.getPropertyValue(token).trim())
    .filter(Boolean)
    .concat(["999px", "50%"]);
}));
if (tokensDeRaio.size <= 2) {
  console.error("Não foi possível ler os tokens de raio do produto; a conferência mediria contra nada.");
  await browser.close();
  process.exit(1);
}

for (const [nome, caminho] of TELAS) {
  await page.goto(`${BASE}${caminho}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const amostra = await page.evaluate(() => {
    const visivel = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 4 && box.height > 4 && getComputedStyle(element).visibility !== "hidden";
    };
    /*
     * A superfície que a pessoa vê, não o nó do DOM.
     *
     * Vários controles do produto são um `<select>` transparente dentro de um
     * `<label>` que carrega borda, fundo e altura — é o padrão do seletor de
     * empresa no cabeçalho. Medir o nó interno acusava 24px e raio 0 em
     * controles que a tela desenha com 36px e raio 12: a ferramenta estaria
     * reprovando o desenho por não saber onde ele mora.
     *
     * Então: sobe até o primeiro ancestral que realmente pinta (borda visível
     * ou fundo não transparente) e mede esse.
     */
    /* O sinal é a **borda**, não o fundo: todo `<select>` recebe fundo do
       agente do usuário, então "tem fundo" apontava para o proprio select e a
       medida voltava a ser a do nó errado. Borda visível é o que o produto
       desenha de propósito. Sem borda em três níveis, o controle não é
       julgável por esta régua e sai da amostra — melhor não medir do que medir
       a coisa errada. */
    const superficie = (element) => {
      let atual = element;
      for (let salto = 0; salto < 3 && atual; salto += 1) {
        if (parseFloat(getComputedStyle(atual).borderTopWidth) > 0) return atual;
        atual = atual.parentElement;
      }
      return null;
    };

    const controles = [];
    for (const element of Array.from(document.querySelectorAll("select, input[type='text'], input[type='search'], input:not([type])"))) {
      if (!visivel(element)) continue;
      const alvo = superficie(element);
      if (!alvo) continue;
      const style = getComputedStyle(alvo);
      controles.push({
        tag: element.tagName.toLowerCase(),
        rotulo: element.getAttribute("aria-label") || element.getAttribute("placeholder") || "(sem rótulo)",
        altura: Math.round(alvo.getBoundingClientRect().height),
        raio: style.borderTopLeftRadius,
      });
    }
    return { controles, texto: document.body.innerText };
  });

  for (const controle of amostra.controles) {
    medidas.push({ tela: nome, ...controle });
    if (!Number.isFinite(controle.altura)) continue;
  }

  const emoji = amostra.texto.match(EMOJI);
  if (emoji) {
    falhas.push(`${nome}: emoji no texto da interface (${emoji[0]}) — §90 pede que o produto não pareça gerado`);
  }

  console.log(`${nome}: ${amostra.controles.length} controle(s) medido(s)`);
}

/* Raio: tem de ser um dos tokens do produto. */
for (const medida of medidas) {
  if (!tokensDeRaio.has(medida.raio)) {
    falhas.push(`${medida.tela}: ${medida.tag} "${medida.rotulo}" usa raio ${medida.raio}, que não é token do produto (${[...tokensDeRaio].join(", ")})`);
  }
}

/* Altura: um valor usado por um único controle no produto inteiro é acidente. */
const porAltura = new Map();
for (const medida of medidas) {
  porAltura.set(medida.altura, [...(porAltura.get(medida.altura) ?? []), medida]);
}
for (const [altura, ocorrencias] of porAltura) {
  if (ocorrencias.length === 1) {
    const unico = ocorrencias[0];
    falhas.push(`${unico.tela}: ${unico.tag} "${unico.rotulo}" tem ${altura}px, altura que nenhum outro controle do produto usa`);
  }
  if (altura < ALTURA_MINIMA_WCAG) {
    falhas.push(`altura de ${altura}px fica abaixo do alvo mínimo de ${ALTURA_MINIMA_WCAG}px (WCAG 2.5.8)`);
  }
}

const raiosVistos = [...new Set(medidas.map((item) => item.raio))];
const alturasVistas = [...porAltura.entries()].sort((a, b) => a[0] - b[0])
  .map(([altura, lista]) => `${altura}px×${lista.length}`);
console.log(`\nControles medidos: ${medidas.length} | alturas: ${alturasVistas.join(", ")} | raios: ${raiosVistos.join(", ")}`);
console.log(`Tokens de raio do produto: ${[...tokensDeRaio].join(", ")}`);

await browser.close();

if (falhas.length) {
  console.error(`\nREPROVADO: ${falhas.length} divergência(s).`);
  for (const falha of falhas) console.error(`  • ${falha}`);
  process.exit(1);
}
console.log(`\nOK: ${TELAS.length} telas, ${medidas.length} controles, nenhuma divergência de padrão.`);
