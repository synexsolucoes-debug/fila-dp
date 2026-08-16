import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectionStatusLabel, connectionTone, lastSyncLabel } from "../app/painel/features/shared/connection-status.ts";

/**
 * §31 e §57: o diagrama de conexões não pode desenhar linha para conector que
 * não conecta.
 *
 * O mockup que originou este desenho trazia **eSocial, FGTS Digital e
 * Pontotel** como conectados, ligados à marca no centro. Nenhum dos três
 * existe no produto: o catálogo real tem API pública e webhooks disponíveis,
 * Sankhya e Sólides parciais, Teams/e-mail/WhatsApp em implantação assistida,
 * e o resto preparado.
 *
 * Desenhar os três seria pior que anunciá-los no site — é dentro do produto,
 * para quem já é cliente e vai confiar no desenho para saber o que está ligado.
 */

const painel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
const codigo = semComentarios(painel);

/**
 * Só o componente do diagrama.
 *
 * A primeira versão procurava os nomes inventados no arquivo inteiro e acusou
 * `FGTS` — que aparece no formulário de folha como **encargo patronal**, um
 * conceito real do produto e sem relação com o "FGTS Digital" do mockup.
 * Detector largo demais reprova código correto, e é a quinta vez nesta
 * auditoria que isso acontece; a correção é sempre estreitar o alvo, nunca
 * afrouxar a regra.
 */
const mapa = (() => {
  const inicio = codigo.indexOf("function ConnectionMap(");
  assert.ok(inicio >= 0, "não achei o componente do diagrama");
  const fim = codigo.indexOf("\nfunction ", inicio + 1);
  return codigo.slice(inicio, fim > 0 ? fim : undefined);
})();

function semComentarios(fonte: string) {
  return fonte.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

test("o diagrama lê os conectores do grupo, não uma lista escrita à mão", () => {
  assert.match(codigo, /<ConnectionMap integrations=\{integrations\}/u);
  assert.match(codigo, /integrations=\{snapshot\.integrations\}/u);
  // Nome de conector escrito no componente seria enfeite: o grupo que não tem
  // aquele conector veria a linha assim mesmo.
  for (const inventado of ["eSocial", "FGTS", "Pontotel"]) {
    assert.doesNotMatch(mapa, new RegExp(inventado, "u"),
      `${inventado} não existe no produto e não pode aparecer no diagrama`);
  }
  // Contraprova do recorte: se `mapa` estivesse vazio, o laço acima passaria
  // sem medir nada — que é o defeito que esta auditoria mais encontrou.
  assert.ok(mapa.length > 400, "o recorte do componente ficou vazio");
  assert.match(mapa, /connectionTone\(item\.status\)/u);
});

test("estado sem conector é dito, não desenhado vazio", () => {
  // Um hub com a marca no centro e nenhuma linha em volta parece defeito de
  // renderização. O estado vazio precisa dizer o que está acontecendo.
  assert.match(codigo, /if \(!integrations\.length\)/u);
  assert.match(painel, /Nenhum conector configurado neste grupo/u);
});

test("o desenho é uma lista por baixo", () => {
  // Um SVG de linhas seria ilegível para leitor de tela — e é justamente a
  // informação que o diagrama existe para dar. O arranjo é apresentação.
  assert.match(codigo, /<ul>[\s\S]{0,400}integrations\.map/u);
  assert.match(codigo, /aria-label="Conexões"/u);
  assert.match(codigo, /connection-map-hub[^>]*aria-hidden="true"/u);
});

test("sem credencial e com erro não são a mesma coisa", () => {
  // Sem credencial é trabalho de implantação; com erro é algo que funcionava e
  // parou. Fundir os dois num "atenção" apagaria a distinção justamente na
  // tela feita para mostrá-la.
  assert.equal(connectionTone("connected"), "ok");
  assert.equal(connectionTone("error"), "bad");
  assert.equal(connectionTone("needs_credentials"), "warn");
  assert.equal(connectionTone("paused"), "idle");
});

test("o painel e o console falam a mesma língua sobre conexão", async () => {
  // As palavras já existiam no filtro do console da plataforma. Escrever
  // outras faria as duas telas nomearem o mesmo registro de jeitos diferentes.
  const console_ = await readFile(new URL("../app/plataforma/features/IntegrationsFeature.tsx", import.meta.url), "utf8");
  assert.match(console_, /value="needs_credentials">Sem credencial</u);
  assert.match(console_, /value="error">Com erro</u);
  assert.equal(connectionStatusLabel("needs_credentials"), "Sem credencial");
  assert.equal(connectionStatusLabel("error"), "Com erro");
  assert.equal(connectionStatusLabel("connected"), "Conectada");
});

test("a última sincronização é relativa e aguenta ausência", () => {
  assert.equal(lastSyncLabel(null), "nunca sincronizou");
  assert.equal(lastSyncLabel("não é data"), "nunca sincronizou");
  assert.match(lastSyncLabel(new Date(Date.now() - 8 * 60_000).toISOString()), /há 8 min/u);
  assert.match(lastSyncLabel(new Date(Date.now() - 3 * 3_600_000).toISOString()), /há 3 h/u);
  assert.match(lastSyncLabel(new Date(Date.now() - 2 * 86_400_000).toISOString()), /há 2 d/u);
});

test("a semente exercita os quatro estados", async () => {
  // Com um conector só, ou todos iguais, a conferência de contraste mediria um
  // estado dos quatro — o mesmo buraco que escondeu o rótulo de processo em
  // 4,37:1 e o cabeçalho do ciclo em 2,42:1.
  const semente = await readFile(new URL("../scripts/seed-ui-fixture.mjs", import.meta.url), "utf8");
  for (const estado of ["connected", "needs_credentials", "error"]) {
    assert.match(semente, new RegExp(`"${estado}"`, "u"), `a semente precisa de um conector ${estado}`);
  }
});
