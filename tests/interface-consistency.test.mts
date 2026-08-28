import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §86–§87, §90, §96–§98: a parte do visual que a máquina mede.
 *
 * A auditoria marcou quatro seções como "julgamento visual: precisa de olho
 * humano". A parte que é gosto continua sendo — se a tela emociona não se mede.
 * Mas altura de controle, raio, token e emoji em texto de interface são
 * mecânicos, e estavam passando sem conferência nenhuma: "precisa de olho
 * humano" tinha virado desculpa para não medir o que a máquina mede melhor.
 *
 * Estes testes protegem as propriedades que fazem a conferência valer alguma
 * coisa. Uma régua que discorda dos tokens do projeto mede a opinião de quem a
 * escreveu — e a primeira coisa que alguém faz com uma régua assim é desligá-la.
 */

const script = await readFile(new URL("../scripts/interface-consistency.mjs", import.meta.url), "utf8");

test("a régua vem dos tokens do produto, não de uma lista escrita à mão", async () => {
  /* A primeira versão trazia raios fixos e reprovou 7px — que era exatamente
     `--ui-radius-sm` na época. Medir contra número inventado produz falha que
     não é defeito, e falha que não é defeito ensina a ignorar o verificador. */
  assert.match(script, /--ui-radius-sm/u);
  assert.match(script, /getPropertyValue\(token\)/u);
  assert.ok(!/const RAIOS = new Set\(\["8px"/u.test(script),
    "os raios voltaram a ser lista fixa em vez de token lido do produto");
});

test("sem conseguir ler os tokens, o verificador para em vez de aprovar", async () => {
  // Medir contra conjunto vazio aprovaria qualquer coisa e assinaria embaixo.
  assert.match(script, /a conferência mediria contra nada/u);
});

test("a superfície medida é a que a pessoa vê", async () => {
  /* Vários controles são um `<select>` transparente dentro de um `<label>` que
     carrega borda e altura. Medir o nó interno acusava 24px em controle que a
     tela desenha com 36 — o verificador reprovando o desenho por não saber onde
     ele mora. O sinal é a borda, não o fundo: todo select recebe fundo do
     agente do usuário. */
  assert.match(script, /borderTopWidth\) > 0/u);
  assert.match(script, /const superficie = \(element\)/u);
});

test("altura sem token é julgada por repetição, não por lista", async () => {
  // O produto não tokeniza altura. O que denuncia acidente é o valor único:
  // uma altura usada por um só controle no produto inteiro não foi decidida.
  assert.match(script, /altura que nenhum outro controle do produto usa/u);
});

test("a varredura de emoji não reprova glifo que carrega informação", async () => {
  /* `★` e `↳` marcam matriz e filial dentro de `<option>`, onde não cabe
     componente de ícone. Reprová-los seria a ferramenta mandando piorar a tela.
     A faixa que ficou é só pictográfica. */
  assert.match(script, /\\u\{1F300\}-\\u\{1FAFF\}/u);
  assert.ok(!/\\u\{2600\}-\\u\{27BF\}/u.test(script),
    "a faixa voltou a incluir símbolos tipográficos, que são pontuação e não decoração");
});

test("a conferência não promete julgar o que não julga", async () => {
  // Dizer que cobre "o design" seria a mesma mentira que este projeto persegue
  // nas outras ferramentas.
  assert.match(script, /não\*{0,2} tenta julgar/u);
  assert.match(script, /continua sendo trabalho de gente/u);
});

test("a CI roda a conferência com o produto de pé", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm run interface-check/u);
  // Depois de subir o produto, junto de a11y-check e browser-check: medir estilo
  // computado exige navegador com a página carregada, não leitura de CSS.
  assert.ok(workflow.indexOf("npm run build") < workflow.indexOf("npm run interface-check"));
});

test("o cartão de erro do painel usa a marca atual", async () => {
  /* Achado desta rodada: o cartão dizia "FILA DP" — a renomeação nunca chegou
     ao limite de erro do painel, e o guard de identidade era `case-sensitive`,
     então não via caixa alta. Um guard que só pega uma grafia dá a impressão de
     cobertura que ele não tem. */
  const boundary = await readFile(new URL("../app/painel/error.tsx", import.meta.url), "utf8");
  assert.match(boundary, /VINCULATO/u);
  const identidade = await readFile(new URL("../tests/vinculato-identity.test.mts", import.meta.url), "utf8");
  assert.match(identidade, /\/Fila\\s\*DP\|FilaDP\|Fila\\s\*<\(\?:strong\|b\)>\\s\*DP\/iu/u,
    "a varredura de marca voltou a ser sensível a caixa");
});
