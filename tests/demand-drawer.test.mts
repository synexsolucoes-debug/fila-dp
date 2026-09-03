import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PRIORITY_LABELS } from "../lib/work-items.ts";

/**
 * A demanda como gaveta (maquete 4).
 *
 * A modal centralizada tapava o quadro. Quem trabalha uma fila abre demanda
 * atrás de demanda comparando com a coluna de origem, e era justamente essa
 * coluna que a modal cobria. A gaveta encosta à direita e deixa o quadro
 * visível — sem abrir mão de ser um diálogo de verdade para teclado e leitor
 * de tela.
 */

const painel = (await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
const css = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
const processoPanel = await readFile(new URL("../app/painel/features/work/CardProcessPanel.tsx", import.meta.url), "utf8");

function bloco(inicio: string, fim: string) {
  const de = painel.indexOf(inicio);
  assert.notEqual(de, -1, `não achei "${inicio}" no painel`);
  const ate = painel.indexOf(fim, de);
  assert.notEqual(ate, -1, `não achei o fim "${fim}" a partir de "${inicio}"`);
  return painel.slice(de, ate + fim.length);
}

/* ── A gaveta ─────────────────────────────────────────────────────────────── */

test("a gaveta continua sendo um diálogo, e não virou um painel qualquer", () => {
  /* Mudar de posição não pode custar o comportamento: `role="dialog"` e
     `aria-modal` são o que prende o foco dentro e fazem Esc fechar. Um
     `<aside>` encostado à direita pareceria igual e deixaria quem navega por
     teclado preso no quadro atrás. */
  assert.match(painel,
    /className="workspace-modal card-modal demand-detail-modal demand-drawer" role="dialog" aria-modal="true" aria-labelledby="card-modal-title"/u);
  assert.match(painel, /className="workspace-modal-backdrop demand-drawer-backdrop"/u);
});

test("a gaveta encosta à direita e ocupa a altura da janela", () => {
  assert.match(css, /\.demand-drawer-backdrop \{[^}]*justify-content: flex-end/u);
  assert.match(css, /\.demand-drawer \{[^}]*height: 100vh/u);
  /* O corpo é quem rola. Sem isso o painel inteiro rolaria e o rodapé de ações
     sairia da tela — que é o defeito que ele existe para corrigir. */
  assert.match(css, /\.demand-drawer > \.card-modal-body \{ flex: 1; min-height: 0; overflow-y: auto; \}/u);
  assert.match(css, /\.demand-drawer-actions \{[^}]*flex: 0 0 auto/u);
});

test("o movimento da gaveta vem da direita, e desliga com menos movimento", () => {
  // Uma gaveta que sobe do chão mente sobre a própria posição.
  assert.match(css, /@keyframes gavetaIn \{ from \{ opacity: 0; transform: translateX\(/u);
  const reduzido = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reduzido.includes(".demand-drawer"), "a animação da gaveta não é desligada");
});

/* ── Progresso da demanda ─────────────────────────────────────────────────── */

test("a barra de progresso lê o fluxo que o snapshot já traz", () => {
  /* Uma consulta por demanda aberta repetiria o que `processFlows` já resolveu
     no servidor, com o mesmo recorte de empresa. */
  const faixa = bloco('aria-label="Progresso da demanda"', "</section>");
  assert.match(painel, /const fluxo = flowByCard\.get\(selectedCard\.id\)/u);
  assert.ok(!/fetch\(|requestJson/u.test(faixa), "a faixa passou a buscar o progresso por conta própria");
  // O denominador é o que a VERSÃO prevê, e não o que já foi materializado.
  assert.match(faixa, /\$\{fluxo\.tasksDone\} de \$\{fluxo\.tasksTotal\} tarefas · \$\{fluxo\.progress\}%/u);
});

test("sem tarefa prevista, barra nenhuma é desenhada", () => {
  /* Barra vazia se lê como "0% concluído" — afirmar progresso onde não há nem
     denominador. O texto diz a verdade no lugar dela. */
  const faixa = bloco('aria-label="Progresso da demanda"', "</section>");
  assert.match(faixa, /\{fluxo && fluxo\.tasksTotal > 0 && <div className="demand-progress-bar"/u);
  assert.match(faixa, /"Sem tarefas previstas"/u);
  /* E a demanda avulsa — que nunca nasceu de processo — cai no checklist, que é
     o progresso que ela realmente tem. */
  assert.match(faixa, /itens do checklist/u);
});

/* ── Os campos da maquete ─────────────────────────────────────────────────── */

test("os campos da maquete saem de campos reais da demanda", () => {
  const campos = bloco('<dl className="demand-fields">', "</dl>");
  for (const [rotulo, fonte] of [
    ["Responsável", "selectedCard.assignees"],
    ["Prazo", "selectedCard.dueAt"],
    ["Criada em", "selectedCard.createdAt"],
    ["Competência", "selectedCard.competence"],
    ["Prioridade", "selectedCard.priority"],
    ["Tipo", "selectedCard.processType"],
  ] as const) {
    assert.match(campos, new RegExp(`<dt>${rotulo}</dt>`, "u"), `o campo ${rotulo} sumiu da grade`);
    assert.ok(campos.includes(fonte), `o campo ${rotulo} deixou de ler ${fonte}`);
  }
  // A etapa vem do fluxo, e leva à aba onde ela pode ser avançada.
  assert.match(campos, /<dt>Etapa atual<\/dt>/u);
  assert.match(campos, /onClick=\{\(\) => setCardTab\("process"\)\}/u);
  // Nenhum valor escrito à mão na grade.
  const fixos = [...campos.matchAll(/<dd>"([^"]+)"<\/dd>/gu)].map((m) => m[1]);
  assert.deepEqual(fixos, []);
});

test("'próxima etapa' não é adivinhada na grade", () => {
  /* A maquete traz o campo. As transições possíveis dependem de bloqueios que
     só o servidor avalia, e elas já são carregadas — com o motivo de cada
     bloqueio — na aba Processo. Repetir o rótulo aqui, sem o bloqueio junto,
     prometeria um avanço que pode não estar liberado. */
  const campos = bloco('<dl className="demand-fields">', "</dl>");
  assert.ok(!/Próxima etapa/u.test(campos),
    "a próxima etapa entrou na grade sem os bloqueios que decidem se ela é possível");
  // E o painel que as carrega continua existindo, com os bloqueios.
  assert.match(processoPanel, /blockers/u);
});

/* ── Checklist ────────────────────────────────────────────────────────────── */

test("o item que falta diz que falta, além de ter a caixa desmarcada", () => {
  /* A caixa desmarcada já diz que falta — mas só pela ausência de um traço de
     8px, e quem percorre dez itens procurando o que falta acaba contando
     caixas. A palavra dá um alvo de leitura. */
  assert.match(painel, /\{!item\.completed && <b className="checklist-pendente">Pendente<\/b>\}/u);
  assert.match(painel, /data-pendente=\{item\.completed \? "false" : "true"\}/u);
  assert.match(css, /\.checklist-pendente \{/u);
  // A contagem X/Y da aba continua, que é o "3/8" da maquete.
  assert.match(painel, /Checklist <b>\{selectedCard\.checklist\.filter\(\(item\) => item\.completed\)\.length\}\/\{selectedCard\.checklist\.length\}<\/b>/u);
});

/* ── O rodapé ─────────────────────────────────────────────────────────────── */

test("o rodapé fica fora do corpo que rola", () => {
  /* Antes estas ações moravam na faixa de resumo, no topo: ao rolar até o
     checklist ou os comentários — que é onde se decide avançar — elas ficavam
     duas telas acima. */
  const gaveta = bloco('<footer className="demand-drawer-actions">', "</footer>");
  for (const acao of ["Avançar etapa", "Reatribuir", "Solicitar documento", "Concluir"]) {
    assert.ok(gaveta.includes(acao), `a ação "${acao}" sumiu do rodapé`);
  }
  /* "Avançar etapa" só aparece para demanda que tem processo: numa demanda
     avulsa ele prometeria uma etapa que não existe. */
  assert.match(gaveta, /flowByCard\.has\(selectedCard\.id\) && <button/u);
  // E o rodapé é irmão do corpo, não filho: filho rolaria junto.
  const corpo = painel.indexOf('<div className="card-modal-body single">');
  const fecha = painel.indexOf("            </div>\n\n            {/* O rodapé de ações", corpo);
  assert.notEqual(fecha, -1, "o rodapé voltou para dentro do corpo rolável");
});

/* ── O tipo da demanda ────────────────────────────────────────────────────── */

test("o tipo vigente entra no seletor quando não é do catálogo", () => {
  /* Defeito real, visto na tela: a demanda criada a partir de um processo
     recebe o CÓDIGO do processo como tipo (`EPI_ENTREGA`), que não é nenhum dos
     sete rótulos do catálogo. O `<select>` sem opção correspondente caía na
     primeira, e a gaveta mostrava "CONCILIAÇÃO CADASTRAL" logo abaixo de um
     campo que dizia "EPI_ENTREGA" — dois valores para o mesmo dado na mesma
     tela. Pior: salvar dali gravava a primeira opção por cima do tipo real. */
  assert.match(painel,
    /\{cardForm\.processType && !processTypeOptions\.includes\(cardForm\.processType\)\s*\n?\s*&& <optgroup label="Tipo vigente desta demanda"><option>\{cardForm\.processType\}<\/option><\/optgroup>\}/u);
  // A lista mora fora do JSX, senão não há como perguntar se um valor é dela.
  assert.match(painel, /const processTypeOptions = \["CONCILIAÇÃO CADASTRAL"/u);
  assert.match(painel, /\{processTypeOptions\.map\(\(tipo\) => <option key=\{tipo\}>\{tipo\}<\/option>\)\}/u);
  // E as sete opções escritas à mão não podem voltar.
  assert.doesNotMatch(painel, /<option>CONCILIAÇÃO CADASTRAL<\/option><option>RESCISÃO<\/option>/u);
});

test("os nomes das prioridades vêm de um lugar só", () => {
  /* Estavam escritos duas vezes: no item de trabalho e à mão nas `<option>` do
     formulário. Duas cópias das mesmas quatro palavras divergem sem ninguém
     notar. */
  assert.deepEqual(Object.keys(PRIORITY_LABELS).sort(), ["high", "low", "normal", "urgent"]);
  assert.match(painel, /import \{ PRIORITY_LABELS \} from "@\/lib\/work-items"/u);
  assert.match(painel, /\{PRIORITY_LABELS\[selectedCard\.priority\] \?\? selectedCard\.priority\}/u);
  assert.match(painel, /\{\["low", "normal", "high", "urgent"\]\.map\(\(nivel\) => <option key=\{nivel\} value=\{nivel\}>\{PRIORITY_LABELS\[nivel\]\}<\/option>\)\}/u);
  assert.doesNotMatch(painel, /<option value="low">Baixa<\/option>/u);
});
