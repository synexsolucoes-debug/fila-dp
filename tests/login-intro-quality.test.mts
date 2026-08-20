import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import test from "node:test";
import { inflateSync } from "node:zlib";

/**
 * A abertura do sistema já foi um MP4 de 1920x1080 a 30 quadros em 321 KB —
 * cerca de 850 kbps. Num plano quase todo escuro com uma marca clara de borda
 * dura, esse bitrate devolve halo e serrilhado em volta do símbolo, e era isso
 * que o usuário via ao entrar. Reencodar não resolvia: o arquivo entregue já
 * era o resultado comprimido.
 *
 * Estes testes guardam a correção em dois níveis. O primeiro é o óbvio: não
 * pode voltar quadro comprimido para a abertura. O segundo é o que costuma
 * apodrecer em silêncio — a geometria da revelação é medida no canal alfa do
 * arquivo oficial da marca, e o teste refaz a medição a cada rodada. Trocar o
 * PNG da marca sem reajustar o CSS passaria despercebido a olho nu num
 * navegador e desalinharia a abertura em produção.
 */

const LOCKUP = new URL("../public/brand/vinculato-logo-light.png", import.meta.url);

type Png = { width: number; height: number; pixels: Buffer };

/**
 * Decodificador mínimo de PNG RGBA de 8 bits, sem interlace.
 *
 * O repositório não tem dependência de imagem e não vale a pena adicionar uma
 * para ler um arquivo. O que o teste precisa é só do canal alfa, e desfazer os
 * cinco filtros do PNG cabe em poucas linhas.
 */
function decodePng(file: Buffer): Png {
  assert.equal(file.subarray(1, 4).toString("latin1"), "PNG", "arquivo não é um PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts: Buffer[] = [];

  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString("latin1");
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data.readUInt8(8), 8, "o decodificador só trata profundidade de 8 bits");
      assert.equal(data.readUInt8(9), 6, "o decodificador só trata RGBA");
      assert.equal(data.readUInt8(12), 0, "o decodificador não trata PNG entrelaçado");
    } else if (type === "IDAT") {
      parts.push(Buffer.from(data));
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  let read = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    raw.copy(line, 0, read, read + stride);
    read += stride;
    const previous = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? line[x - bytesPerPixel] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      if (filter === 1) line[x] = (line[x] + left) & 255;
      else if (filter === 2) line[x] = (line[x] + up) & 255;
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 255;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dl = Math.abs(estimate - left);
        const du = Math.abs(estimate - up);
        const dul = Math.abs(estimate - upLeft);
        const predictor = dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
        line[x] = (line[x] + predictor) & 255;
      } else assert.equal(filter, 0, `filtro PNG desconhecido: ${filter}`);
    }
  }

  return { width, height, pixels };
}

/** Colunas em que o arquivo tem tinta, para achar o símbolo e o vão até o logotipo. */
function inkedColumns({ width, height, pixels }: Png): boolean[] {
  const columns: boolean[] = [];
  for (let x = 0; x < width; x += 1) {
    let inked = false;
    for (let y = 0; y < height && !inked; y += 1) {
      if (pixels[(y * width + x) * 4 + 3] > 16) inked = true;
    }
    columns.push(inked);
  }
  return columns;
}

async function measureLockup() {
  const image = decodePng(await readFile(LOCKUP));
  const columns = inkedColumns(image);

  const markEnd = columns.indexOf(false);
  assert.ok(markEnd > 0, "o símbolo precisa ocupar as primeiras colunas do arquivo");
  let wordmarkStart = markEnd;
  while (wordmarkStart < columns.length && !columns[wordmarkStart]) wordmarkStart += 1;
  assert.ok(wordmarkStart < columns.length, "o arquivo precisa conter o logotipo depois do símbolo");

  return {
    width: image.width,
    /** Meio do vão entre símbolo e logotipo: onde o primeiro momento corta. */
    splitPercent: ((markEnd - 1 + wordmarkStart) / 2 / image.width) * 100,
    /** Quanto deslocar para o centro do símbolo cair no centro da tela. */
    offsetPercent: 50 - (((markEnd - 1) / 2 / image.width) * 100),
  };
}

/** Lê um número percentual de dentro do CSS, para comparar com a medição. */
function percentIn(css: string, pattern: RegExp) {
  const found = css.match(pattern);
  assert.ok(found, `padrão ausente no CSS: ${pattern}`);
  return Number(found[1].replace(",", "."));
}

test("a abertura não depende mais de um quadro comprimido", async () => {
  const intro = await readFile(new URL("../app/components/LoginIntroMotion.tsx", import.meta.url), "utf8");
  // Nem o vídeo antigo, nem um substituto: qualquer codec com perdas repõe o
  // halo que motivou a troca.
  assert.doesNotMatch(intro, /\.mp4|\.webm|<video/u, "a abertura voltou a usar vídeo");

  await assert.rejects(
    access(new URL("../public/brand/vinculato-intro-dark.mp4", import.meta.url)),
    "o vídeo comprimido continua publicado em public/brand",
  );
});

test("a abertura desenha o arquivo oficial da marca, sem reencode", async () => {
  const intro = await readFile(new URL("../app/components/LoginIntroMotion.tsx", import.meta.url), "utf8");
  // O arquivo oficial recortado, servido inteiro. `unoptimized` importa: o
  // otimizador do Next devolveria WebP com perdas e, num traço chapado sobre
  // fundo escuro, é justamente aí que a franja aparece.
  assert.match(intro, /VINCULATO_BRAND\.logoLightSource/u);
  assert.match(intro, /unoptimized/u);
  assert.doesNotMatch(intro, /<path\s/u, "a marca é o arquivo original, não um redesenho");
});

test("a geometria da revelação bate com o arquivo medido agora", async () => {
  const measured = await measureLockup();
  const css = await readFile(new URL("../app/access.css", import.meta.url), "utf8");

  const split = percentIn(css, /clip-path:\s*inset\(0\s+([\d.]+)%\s+0\s+0\)/u);
  const offset = percentIn(css, /translate3d\(([\d.]+)%,\s*0,\s*0\)/u);

  // O corte é escrito como sobra à direita; a medição dá a borda à esquerda.
  assert.ok(
    Math.abs(100 - split - measured.splitPercent) < 0.5,
    `o corte do símbolo (${(100 - split).toFixed(2)}%) não bate com o arquivo (${measured.splitPercent.toFixed(2)}%)`,
  );
  assert.ok(
    Math.abs(offset - measured.offsetPercent) < 0.5,
    `o deslocamento (${offset}%) não centraliza o símbolo do arquivo (${measured.offsetPercent.toFixed(2)}%)`,
  );
});

test("a medição enxerga mesmo o vão entre símbolo e logotipo", async () => {
  // Contraprova: se `inkedColumns` estivesse cega, o teste acima passaria
  // comparando dois números inventados com os do CSS.
  const measured = await measureLockup();
  assert.ok(measured.width >= 960, "o arquivo da marca encolheu");
  assert.ok(measured.splitPercent > 5 && measured.splitPercent < 45, "o vão medido saiu de faixa plausível");
  assert.ok(measured.offsetPercent > measured.splitPercent, "centralizar o símbolo desloca mais do que o corte");
});

test("a abertura nunca pede à marca mais pixel do que o arquivo tem", async () => {
  const { width } = await measureLockup();
  const css = await readFile(new URL("../app/access.css", import.meta.url), "utf8");
  const cap = percentIn(css, /width:\s*min\(\d+vw,\s*(\d+)px\)/u);
  // A maior ampliação do primeiro momento, que é onde o símbolo aparece sozinho.
  const frames = css.match(/@keyframes vin-intro-reveal \{[\s\S]*?\n\}/u);
  assert.ok(frames, "a animação da revelação sumiu do CSS");
  const scales = [...frames[0].matchAll(/scale\(([\d.]+)\)/gu)].map((found) => Number(found[1]));
  assert.ok(scales.length > 0, "a animação não declara ampliação alguma");
  const peak = Math.max(...scales);

  // Esta é a regra que o vídeo quebrava: ele esticava a mesma arte de 960px
  // para perto de 1570px numa tela de 1920 — e ainda por cima comprimida. Aqui
  // a maior largura que a arte chega a ocupar continua abaixo da largura de
  // origem, então o traço nunca é inventado por interpolação.
  assert.ok(cap <= width, `o teto de ${cap}px passa da largura de origem (${width}px)`);
  assert.ok(
    cap * peak <= width,
    `no pico da animação a arte ocupa ${Math.round(cap * peak)}px contra ${width}px de origem`,
  );
  // E a ampliação precisa existir de verdade: sem ela o símbolo abre do tamanho
  // que terá dentro do logotipo completo, e o primeiro momento perde a presença
  // que o vídeo tinha.
  assert.ok(peak > 1.2, `o símbolo abre sem destaque (pico de ${peak})`);
});

test("quem já autenticou nunca fica preso na abertura", async () => {
  const intro = await readFile(new URL("../app/components/LoginIntroMotion.tsx", import.meta.url), "utf8");
  // Sem vídeo não há mais `onEnded`, então o encerramento passou a ter duas
  // fontes: o fim da animação e um temporizador. A segunda cobre o caso em que
  // o sistema operacional desliga animações e `animationend` nunca chega —
  // seria uma tela de logotipo eterna depois de um login bem-sucedido.
  assert.match(intro, /onAnimationEnd=\{finish\}/u);
  assert.match(intro, /setTimeout\(finish, INTRO_DURATION_MS\)/u);
  assert.match(intro, /window\.location\.assign\(destination\)/u);
  // E a falha de carregamento da imagem também precisa destravar a sequência.
  assert.match(intro, /onError=\{\(\) => setStarted\(true\)\}/u);
  // Uma navegação só: `animationend` e temporizador podem chegar juntos.
  assert.match(intro, /if \(navigated\.current\) return;/u);
});

test("preferência por menos movimento não deixa a abertura parada no símbolo", async () => {
  const css = await readFile(new URL("../app/access.css", import.meta.url), "utf8");
  const block = css.split("@media (prefers-reduced-motion: reduce)").at(-1) ?? "";
  // Sem animação, o recorte do primeiro momento congelaria o logotipo cortado
  // ao meio. A regra devolve a peça inteira e parada.
  assert.match(block, /\.vin-intro-lockup \{[^}]*clip-path: none/u);
  assert.match(block, /\.vin-intro-lockup \{[^}]*opacity: 1/u);
});

test("a marca deixou de ser reencodada com perdas nas demais telas", async () => {
  const [config, logo] = await Promise.all([
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/VinculatoLogo.tsx", import.meta.url), "utf8"),
  ]);
  // A qualidade padrão do otimizador é 75, e é ela que franjava o logotipo na
  // barra lateral e no próprio login. Pedir 100 exige a lista no config: sem
  // ela o Next recusa o valor e a imagem nem chega a ser servida.
  assert.match(logo, /const BRAND_IMAGE_QUALITY = 100;/u);
  assert.match(config, /qualities:\s*\[75,\s*100\]/u);
  const quality = logo.match(/quality=\{BRAND_IMAGE_QUALITY\}/gu) ?? [];
  assert.equal(quality.length, 2, "o símbolo e o logotipo horizontal precisam pedir a qualidade da marca");
});
