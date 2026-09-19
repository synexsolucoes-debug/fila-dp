export { BoardIndicators } from "./BoardIndicators";
export { BoardToolbar } from "./BoardToolbar";
export { BulkBar, type BulkAction } from "./BulkBar";
/* `DemandCard` não é publicado aqui de propósito: ele é peça interna do quadro,
   desenhado por `TeamBoard` e `QueueBoard`. Exportá-lo anunciaria uma tela que
   ninguém de fora renderiza — e a verificação de alcance do painel cobra
   exatamente isso. */
export { QueueBoard } from "./QueueBoard";
export { TeamBoard } from "./TeamBoard";
export * from "./board.model";
