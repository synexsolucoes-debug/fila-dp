import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * O foco de um diálogo é assunto da abertura, não de cada render.
 *
 * Defeito real, medido no navegador com o produto de pé: no lançamento de
 * evento PJ, a lista do `<select>` de Prestador — e a de Rubrica — fechava
 * sozinha poucos segundos depois de aberta, antes de dar tempo de escolher.
 *
 * A trilha de foco mostrou o caminho inteiro:
 *
 *     t=  693ms  foco no <select>       (a pessoa abre a lista)
 *     t= 1199ms  GET /api/realtime      (verificação periódica do painel)
 *     t= 1222ms  GET /api/workspace     (um colega mexeu: recarrega o grupo)
 *     t= 1267ms  foco volta ao botão de origem, depois vai ao primeiro rádio
 *
 * `setSnapshot` renderiza o painel de novo, a tela de pagamentos junto, e o
 * `onClose={() => setEntryOpen(false)}` escrito no JSX nasce com identidade
 * nova. Com ele na lista de dependências do efeito de foco, o efeito era
 * desmontado e remontado: a limpeza devolvia o foco a quem o tinha antes da
 * janela abrir, e o corpo dava foco ao primeiro controle dela.
 *
 * A lista de um `<select>` é desenhada pelo navegador e existe enquanto o
 * elemento tem o foco — tirar o foco fecha a lista. Não é um detalhe do PJ:
 * `useDialogFocus` é o foco de toda janela e gaveta do painel, e o intervalo
 * padrão de atualização é de 30 segundos, com 5 disponível nas configurações.
 *
 * Os outros diálogos do produto já resolviam isso por referência; era este que
 * faltava. Os testes abaixo guardam a forma, porque a lista de dependências
 * volta sozinha em qualquer conserto automático de `exhaustive-deps`.
 */

const motion = await readFile(new URL("../app/painel/features/shared/motion.tsx", import.meta.url), "utf8");

function hook() {
  const de = motion.indexOf("export function useDialogFocus");
  assert.notEqual(de, -1, "useDialogFocus sumiu de motion.tsx");
  const ate = motion.indexOf("\n  return ref;\n}", de);
  assert.notEqual(ate, -1, "não achei o fim de useDialogFocus");
  return motion.slice(de, ate);
}

test("o efeito de foco depende só de o diálogo estar aberto", () => {
  const trecho = hook();
  /* `busy` e `onClose` na lista fazem o efeito remontar a cada render do pai —
     e remontar significa mexer no foco de quem está usando a janela. */
  assert.match(trecho, /\n {2}\}, \[active\]\);/u,
    "o efeito de foco voltou a depender de algo além de `active`");
  assert.doesNotMatch(trecho, /\}, \[active, busy, onClose\]\)/u);
});

test("a tecla continua enxergando o `onClose` e o `busy` do momento", () => {
  /* Tirar da lista de dependências sem a referência congelaria os dois no
     valor da abertura: Esc chamaria o fechamento de um render velho, e fecharia
     a janela no meio de uma ação já enviada — que é justamente o que o
     `busy` existe para impedir. */
  const trecho = hook();
  assert.match(trecho, /const atual = useRef\(\{ onClose, busy \}\)/u);
  assert.match(trecho, /useEffect\(\(\) => \{ atual\.current = \{ onClose, busy \}; \}\);/u,
    "a referência precisa ser atualizada a cada render, sem lista de dependências");
  assert.match(trecho, /event\.key === "Escape" && !atual\.current\.busy/u);
  assert.match(trecho, /atual\.current\.onClose\(\)/u);
  assert.ok(!/(?<!atual\.current\.)\bonClose\(\)/u.test(trecho),
    "sobrou uma chamada direta a onClose(), que fica presa no render da abertura");
});

test("o primeiro controle recebe o foco na abertura, e uma vez só", () => {
  /* O foco inicial continua acontecendo — é ele que faz o teclado entrar na
     janela em vez de continuar na tela atrás dela. O que mudou foi a
     frequência: uma vez por abertura, não uma por render. */
  const trecho = hook();
  assert.match(trecho, /focusables\(\)\[0\]\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(trecho, /previous\?\.focus\?\.\(\)/u, "a devolução do foco ao fechar sumiu");
});

test("as janelas e a gaveta do painel usam este mesmo foco", () => {
  /* Se alguma delas passasse a ter o seu próprio, o conserto valeria para uma
     tela só e o defeito voltaria pela outra. */
  for (const componente of ["AnimatedModal", "AnimatedDrawer"]) {
    const de = motion.indexOf(`export function ${componente}`);
    assert.notEqual(de, -1, `${componente} sumiu`);
    assert.match(motion.slice(de, de + 1400), /useDialogFocus\(mounted && state === "open", onClose\)/u,
      `${componente} deixou de usar useDialogFocus`);
  }
});

test("o diálogo de lançamento PJ continua sendo uma dessas janelas", async () => {
  /* É a tela do defeito relatado. Se ela passasse a montar o próprio diálogo,
     o conserto acima não a alcançaria — e os dois `<select>` do relato são
     exatamente os que estão aqui. */
  const entrada = await readFile(
    new URL("../app/painel/features/payments/ContractorEntryDialog.tsx", import.meta.url), "utf8");
  assert.match(entrada, /<AnimatedModal open=\{open\} onClose=\{onClose\}/u);
  assert.match(entrada, /<select value=\{componentType\}/u, "o seletor de Rubrica sumiu");
  assert.match(entrada, /<select value=\{providerId\}/u, "o seletor de Prestador sumiu");
});
