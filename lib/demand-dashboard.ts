import type { BoardList, Card } from "./fila-dp-types.ts";

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Date-only deadlines keep their day; timestamps follow the displayed local time. */
export function demandDeadlineDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? null : localDayKey(date);
}

export function isOpenDemand(card: Card): boolean {
  return !card.archived && !card.cancelledAt && card.slaStatus !== "completed";
}

export function summarizeDemands(cards: Card[], lists: Pick<BoardList, "id" | "slaBehavior">[], today = new Date()) {
  const waitingLists = new Set(lists.filter((list) => list.slaBehavior === "paused").map((list) => list.id));
  const day = localDayKey(today);
  const summary = { open: 0, overdue: 0, dueToday: 0, waiting: 0, completed: 0 };
  for (const card of cards) {
    if (card.archived || card.cancelledAt) continue;
    if (!isOpenDemand(card)) { summary.completed++; continue; }
    summary.open++;
    if (card.slaStatus === "overdue") summary.overdue++;
    if (demandDeadlineDay(card.dueAt) === day) summary.dueToday++;
    if (card.slaStatus === "paused" || waitingLists.has(card.listId)) summary.waiting++;
  }
  return summary;
}

const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
export function prioritizeDemands(cards: Card[]): Card[] {
  const due = (card: Card) => {
    const date = card.dueAt ? Date.parse(card.dueAt) : Number.NaN;
    return Number.isNaN(date) ? Number.MAX_SAFE_INTEGER : date;
  };
  return [...cards].sort((a, b) =>
    Number(!isOpenDemand(a)) - Number(!isOpenDemand(b)) ||
    Number(b.slaStatus === "overdue") - Number(a.slaStatus === "overdue") ||
    priorityOrder[a.priority] - priorityOrder[b.priority] || due(a) - due(b) || a.id.localeCompare(b.id));
}

/**
 * O que sobra quando a demanda não tem nada que diga o próximo passo.
 *
 * Exportado porque quem exibe precisa poder distinguir a frase derivada de um
 * fato — um item pendente, um motivo de espera — desta, que é só o texto de
 * reserva. No cartão do quadro, repetir "conferir os detalhes" em sessenta
 * demandas é uma linha de ruído por cartão; a frase vale a tela onde ela é a
 * única coisa escrita, não a que já tem título, empresa, prazo e etapa.
 */
export const DEMAND_NEXT_ACTION_FALLBACK = "Conferir os detalhes da demanda";

export function demandNextAction(card: Card): string {
  if (card.cancelledAt) return "Demanda cancelada";
  if (card.slaStatus === "completed") return "Processo finalizado";
  if (card.slaPausedReason.trim()) return card.slaPausedReason;
  return card.checklist.find((item) => !item.completed)?.title || DEMAND_NEXT_ACTION_FALLBACK;
}

export function demandAssigneeWorkload(cards: Card[]) {
  const groups = new Map<string, { id: string; name: string; open: number; waiting: number }>();
  for (const card of cards) {
    if (!isOpenDemand(card)) continue;
    const assignees = card.assignees.length ? card.assignees.map((person) => ({ id: person.userId, name: person.name }))
      : [{ id: card.assigneeName ? `legacy:${card.assigneeName}` : "unassigned", name: card.assigneeName || "Sem responsável" }];
    for (const person of new Map(assignees.map((person) => [person.id, person])).values()) {
      const entry = groups.get(person.id) ?? { ...person, open: 0, waiting: 0 };
      entry.open++;
      if (card.slaStatus === "paused") entry.waiting++;
      groups.set(person.id, entry);
    }
  }
  return [...groups.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name, "pt-BR"));
}

export function demandCalendarDays(cursor: Date, mode: "week" | "month"): Date[] {
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), mode === "month" ? 1 : cursor.getDate(), 12);
  const offset = (start.getDay() + 6) % 7;
  const count = mode === "week" ? 7 : Math.ceil((offset + new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()) / 7) * 7;
  start.setDate(start.getDate() - offset);
  return Array.from({ length: count }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index, 12));
}
