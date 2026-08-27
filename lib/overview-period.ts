/**
 * Recorte de período da Visão geral (§13).
 *
 * Mora aqui, e não dentro de `WorkspaceApp.tsx`, porque é regra — não
 * apresentação. Dentro do componente ela só poderia ser verificada por leitura
 * do código-fonte; fora, os casos que importam (sem prazo, atrasado, borda do
 * dia) viram teste de comportamento.
 *
 * A janela é sempre **para frente**, a partir do início de hoje: a Visão geral
 * responde "o que vem", e o passado entra por outra porta — a das
 * movimentações, que olham para trás.
 */

export type OverviewPeriod = "all" | "today" | "week" | "month";

export const overviewPeriods: ReadonlyArray<{ key: OverviewPeriod; label: string; days: number }> = [
  { key: "all", label: "Todo o período", days: 0 },
  { key: "today", label: "Hoje", days: 1 },
  { key: "week", label: "Próximos 7 dias", days: 7 },
  { key: "month", label: "Próximos 30 dias", days: 30 },
];

export function overviewPeriodLabel(period: OverviewPeriod) {
  return overviewPeriods.find((item) => item.key === period)?.label ?? "";
}

export function overviewPeriodDays(period: OverviewPeriod) {
  return overviewPeriods.find((item) => item.key === period)?.days ?? 0;
}

/**
 * Fim da janela em milissegundos, ou `null` quando não há janela.
 *
 * Ancorado na meia-noite local de hoje, não em `now`: com a âncora móvel,
 * "próximos 7 dias" às 9h e às 17h do mesmo dia devolveriam conjuntos
 * diferentes, e o indicador mudaria sozinho ao longo do expediente.
 */
export function periodWindowEnd(period: OverviewPeriod, now: Date = new Date()): number | null {
  const days = overviewPeriodDays(period);
  if (!days) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return start + days * 24 * 60 * 60 * 1000;
}

/**
 * Um prazo cabe no período escolhido?
 *
 * Duas decisões que valem explicação:
 *
 * 1. **Sem prazo entra sempre.** Uma demanda sem `dueAt` não pode ser excluída
 *    por uma janela de datas — sumir com ela transformaria o filtro em
 *    esconderijo de trabalho real, e o contador diria menos do que existe.
 * 2. **Atrasado entra sempre.** O que venceu antes da janela continua sendo o
 *    que mais precisa de atenção hoje; filtrá-lo para fora é o contrário do que
 *    a tela existe para fazer. Por isso o teste é só o limite superior.
 */
export function withinPeriod(dueAt: string | null | undefined, windowEnd: number | null): boolean {
  if (windowEnd === null || !dueAt) return true;
  const due = Date.parse(dueAt);
  // Data ilegível não é motivo para esconder a demanda: o defeito está no dado,
  // e escondê-lo do operador é o pior dos dois resultados possíveis.
  return Number.isNaN(due) || due < windowEnd;
}

/**
 * Piso da janela retrospectiva das movimentações (§19), em milissegundos.
 *
 * `null` quando não há recorte — e aí vale a janela que o snapshot já traz.
 */
export function periodWindowStart(period: OverviewPeriod, now: Date = new Date()): number | null {
  const days = overviewPeriodDays(period);
  if (!days) return null;
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}
