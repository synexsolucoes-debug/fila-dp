import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { LIMITE_BYTES, SAIDA } from "../scripts/generate-og-image.mjs";

/**
 * §45: a imagem de compartilhamento.
 *
 * O defeito que este arquivo existe para impedir foi o mais duradouro que a
 * auditoria encontrou, e o mais fácil de não ver.
 *
 * O site foi remarcado de Fila DP para Vinculato — nome, paleta, tipografia,
 * posicionamento. `browser-check` confere, a cada execução, que "Fila DP" não
 * aparece na página inicial e que o posicionamento anterior saiu. Passava.
 *
 * A imagem de compartilhamento não. Ela dizia "Fila DP", em verde, com
 * "Toda demanda na fila certa." — e era ela, não a página, que aparecia toda
 * vez que alguém enviava um link do produto no WhatsApp, no LinkedIn ou no
 * Slack. Ao lado dela, no mesmo bloco de metadados, o `alt` dizia
 * "Vinculato — Sua operação, conectada.". O texto certo, com a figura
 * contradizendo o texto.
 *
 * Nenhuma verificação pegava porque a imagem é um binário referenciado só nos
 * metadados: ninguém a renderiza, então ninguém a lê. É a mesma classe de
 * defeito que esta auditoria já encontrou seis vezes — a conferência cobria o
 * que conseguia enxergar.
 *
 * A saída não é ler o PNG. É tirar do cartão a possibilidade de divergir:
 * ele passou a ser *gerado* a partir do logotipo oficial, das cores `--vin-*`
 * e de `VINCULATO_TAGLINE`. Este teste guarda essa ligação — e as duas outras
 * coisas que estavam erradas junto.
 */

const raiz = new URL("../", import.meta.url);
const layout = await readFile(new URL("app/layout.tsx", raiz), "utf8");
const gerador = await readFile(new URL("scripts/generate-og-image.mjs", raiz), "utf8");

test("o cartão declarado no layout é o arquivo que existe no disco", async () => {
  const declarado = layout.match(/images: \[\{ url: `\$\{origin\}\/([^`]+)`/u)?.[1];
  assert.ok(declarado, "o layout precisa declarar a imagem de compartilhamento");
  assert.equal(`public/${declarado}`, SAIDA, "o layout aponta para um arquivo que o gerador não produz");
  await assert.doesNotReject(stat(new URL(SAIDA, raiz)), `${SAIDA} não existe — rode npm run og:generate`);
});

test("as dimensões declaradas são as do arquivo, não uma lembrança delas", async () => {
  // O cartão anterior era declarado como 1792×917 e media 1731×909. Quem
  // recorta a pré-visualização confia no número declarado: errado, a imagem sai
  // esticada ou com tarja. Ninguém compara os dois à mão — então compara aqui.
  const bytes = await readFile(new URL(SAIDA, raiz));
  const { largura, altura } = dimensoesJpeg(bytes);
  const declarada = layout.match(/width: (\d+), height: (\d+), alt:/u);
  assert.ok(declarada, "o layout precisa declarar largura e altura");
  assert.equal(Number(declarada[1]), largura, "largura declarada difere do arquivo");
  assert.equal(Number(declarada[2]), altura, "altura declarada difere do arquivo");

  // 1200×630 é a proporção que WhatsApp, LinkedIn, Slack e X recortam sem cortar.
  assert.equal(largura, 1200);
  assert.equal(altura, 630);
});

test("o cartão é leve o bastante para a pré-visualização montar", async () => {
  // O anterior tinha 1,4 MB. Acima de algumas centenas de KB, aplicativo de
  // mensagem desiste da pré-visualização rica e mostra só o link — perdendo
  // justamente a peça que existe para converter.
  const { size } = await stat(new URL(SAIDA, raiz));
  assert.ok(size <= LIMITE_BYTES,
    `${(size / 1024).toFixed(0)} KB excede o teto de ${(LIMITE_BYTES / 1024).toFixed(0)} KB`);
});

test("o endereço do cartão mudou junto com a marca", () => {
  // Plataformas guardam a imagem em cache pela URL. Reaproveitar `/og.png`
  // manteria o cartão "Fila DP" vivo nos caches do WhatsApp e do LinkedIn por
  // tempo indeterminado, mesmo com o arquivo trocado no servidor.
  //
  // Comparar contra o código, não contra o arquivo: o comentário que explica
  // essa decisão no layout cita o endereço antigo, e a primeira versão deste
  // teste reprovou por causa da própria explicação.
  assert.doesNotMatch(semComentarios(layout), /\/og\.png/u,
    "voltar ao endereço antigo revive o cartão antigo nos caches");
});

test("o cartão deriva da marca, em vez de repeti-la", () => {
  // É este vínculo que impede o defeito de voltar: se o cartão fosse desenhado
  // à parte, trocar a marca de novo o deixaria para trás de novo — que é
  // exatamente o que aconteceu.
  assert.match(gerador, /--vin-navy:/u, "as cores precisam vir de globals.css");
  assert.match(gerador, /--vin-blue-vivid:/u);
  assert.match(gerador, /VINCULATO_TAGLINE = "\(\[\^"\]\+\)"/u, "o texto precisa vir do mesmo lugar que o h1 da home");
  assert.match(gerador, /logoLightSource: "\(\[\^"\]\+\)"/u, "o logotipo precisa ser o arquivo oficial");
  assert.match(gerador, /openGraph:\[\\s\\S\]\*\?description: "\(\[\^"\]\+\)"/u,
    "a descrição precisa ser a mesma que acompanha a imagem no compartilhamento");

  // E o gerador não pode aceitar tipografia trocada em silêncio: um cartão que
  // cai na fonte do sistema é o mesmo defeito com outra roupa.
  assert.match(gerador, /não carregaram no cartão/u);
  assert.match(gerador, /A fonte \$\{exigida\} não está no build/u);
});

test("o nome antigo não sobrevive em lugar nenhum do compartilhamento", () => {
  const metadados = semComentarios(layout);
  assert.doesNotMatch(metadados, /Fila DP/u);
  assert.doesNotMatch(metadados, /fila certa/iu);
  assert.match(metadados, /siteName: "Vinculato"/u);
});

/** O comentário que explica um defeito costuma citá-lo; medir o código. */
function semComentarios(fonte: string) {
  return fonte.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

/** Lê largura e altura do primeiro marcador SOFn de um JPEG. */
function dimensoesJpeg(bytes: Buffer) {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marcador = bytes[i + 1];
    // SOF0–SOF3 e SOF5–SOF15 carregam as dimensões; os demais são pulados pelo
    // comprimento do próprio segmento.
    if (marcador >= 0xc0 && marcador <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marcador)) {
      return { altura: bytes.readUInt16BE(i + 5), largura: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error("não encontrei as dimensões no JPEG");
}
