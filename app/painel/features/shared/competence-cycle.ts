/**
 * As etapas do ciclo de folha, em um lugar só.
 *
 * `cycleStages` vivia dentro de `OperationsView.tsx`, privado dela. Quando a
 * Visão geral passou a mostrar o fluxo da competência, copiar a lista teria
 * criado a segunda definição — e este repositório já pagou por isso: o
 * cabeçalho de painel estava definido três vezes, o selo de status cinco e o
 * aviso de erro dez, dois deles sem `role="alert"`.
 *
 * Os estados são os que o servidor aceita em `lib/operations.ts`
 * (`cycleStatuses`), nesta ordem — trocar a ordem aqui muda o desenho do
 * fluxo, então ela não é decorativa.
 */
export const cycleStages = [
  { status: "open", label: "Aberta", note: "Receber entradas" },
  { status: "pre_closing", label: "Pré-fechamento", note: "Validar gates" },
  { status: "processing", label: "Processamento", note: "Executar folha" },
  { status: "post_closing", label: "Pós-fechamento", note: "Conciliar saídas" },
  { status: "closed", label: "Concluída", note: "Ciclo protegido" },
] as const;

export type CycleStatus = (typeof cycleStages)[number]["status"];

/** Posição da etapa na sequência; -1 para estado desconhecido. */
export function stageIndex(status: string) {
  return cycleStages.findIndex((stage) => stage.status === status);
}

/** "2026-08" → "ago / 2026". Competência é mês, e mês se lê por extenso. */
export function competenceLabel(competence: string) {
  const match = /^(\d{4})-(\d{2})$/u.exec(competence);
  if (!match) return competence;
  const mes = new Date(`${competence}-01T12:00:00`).toLocaleDateString("pt-BR", { month: "short" });
  return `${mes.replace(".", "")} / ${match[1]}`;
}

/**
 * Onde a operação está, olhando todos os ciclos da competência.
 *
 * O avanço é o do ciclo **menos adiantado**: com três empresas, duas fechadas
 * e uma ainda aberta, a competência do grupo não está fechada. Dizer que está
 * seria a mesma classe de mentira que o seletor de empresa cometia quando
 * ignorava o recorte — um número que parece responder e responde outra coisa.
 */
export function cycleProgress(cycles: ReadonlyArray<{ status: string }>) {
  if (!cycles.length) return null;
  const indices = cycles.map((cycle) => stageIndex(cycle.status)).filter((index) => index >= 0);
  if (!indices.length) return null;
  const atual = Math.min(...indices);
  const concluidos = cycles.filter((cycle) => cycle.status === "closed").length;
  return {
    /** Índice da etapa em que a operação está, do ciclo menos adiantado. */
    atual,
    /** Quantos ciclos já fecharam, dos que existem na competência. */
    concluidos,
    total: cycles.length,
    /** Todos fecharam. */
    completa: concluidos === cycles.length,
  };
}
