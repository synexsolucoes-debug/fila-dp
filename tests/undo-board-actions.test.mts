import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Mover e atribuir demanda podem ser desfeitos pelo aviso.
 *
 * Defeito pego no navegador durante a construção: o primeiro "Desfazer"
 * chamava `moveCard` de novo, que lia o retrato do quadro guardado no
 * fechamento — com a demanda ainda na coluna de origem — e concluía que não
 * havia nada a mover. O botão aparecia e não fazia nada. Desfazer vai direto
 * ao servidor.
 */
const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
const toast = await readFile(new URL("../app/painel/features/shared/CenterToast.tsx", import.meta.url), "utf8");

test("o aviso central aceita uma ação", () => {
  assert.match(toast, /action\?: \{ label: string; onClick: \(\) => void \}/u);
  assert.match(toast, /className="center-toast-action"/u);
});

test("desfazer mover e atribuir chamam o servidor, não a função com retrato antigo", () => {
  assert.match(app, /run: \(\) => void mutate\(`\/api\/cards\/\$\{cardId\}\/move`, \{ method: "POST", body: JSON\.stringify\(\{ toListId: origem \}\) \}, "Movimentação desfeita\."\)/u);
  assert.match(app, /run: \(\) => void mutate\(`\/api\/cards\/\$\{cardId\}\/assignee`, \{ method: "POST", body: JSON\.stringify\(\{ assigneeIds: anteriores \}\) \}, "Atribuição desfeita\."\)/u);
  // O arrasto do quadro novo devolve à coluna e ao lugar de antes, também direto no servidor.
  assert.match(app, /run: \(\) => void mutate\(`\/api\/cards\/\$\{card\.id\}\/move`, \{ method: "POST", body: JSON\.stringify\(volta\) \}, "Movimentação desfeita\."\)/u);
  assert.doesNotMatch(app, /run: \(\) => void moveCard\(/u);
  assert.doesNotMatch(app, /run: \(\) => void assignCard\(/u);
});

test("o desfazer só vale para o aviso de que nasceu", () => {
  assert.match(app, /const undoAtual = undo && undo\.message === toast \? undo : null;/u);
  assert.match(app, /action=\{undoAtual \? \{ label: "Desfazer"/u);
});

test("o atalho de teclado é anunciado só no cartão que o tem", async () => {
  // O quadro por situação mora em KanbanBoard.tsx; lá Alt+↑/↓ também reordena na coluna.
  const kanban = await readFile(new URL("../app/painel/features/board/KanbanBoard.tsx", import.meta.url), "utf8");
  assert.match(kanban, /aria-keyshortcuts=\{props\.canEdit \? "Alt\+ArrowLeft Alt\+ArrowRight Alt\+ArrowUp Alt\+ArrowDown" : undefined\}/u);
  const card = await readFile(new URL("../app/painel/features/board/DemandCard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(card, /aria-keyshortcuts/u, "Equipe e Minha fila não movem entre colunas");
});
