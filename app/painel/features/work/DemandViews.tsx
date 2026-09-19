"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays } from "lucide-react";
import type { Card, WorkspaceSnapshot } from "@/lib/fila-dp-types";
import { demandCalendarDays, demandDeadlineDay, localDayKey, prioritizeDemands } from "@/lib/demand-dashboard";
import styles from "./DemandViews.module.css";

function status(card: Card, listName?: string) {
  if (card.cancelledAt) return "Cancelada";
  if (card.slaStatus === "completed") return "Concluída";
  if (card.slaStatus === "overdue") return "Prazo vencido";
  if (card.slaStatus === "paused") return "Aguardando retorno";
  return listName || "Em andamento";
}

function DemandPreview({ card, listName, onOpen }: { card: Card; listName?: string; onOpen: (card: Card) => void }) {
  return <button type="button" className={styles.calendarCard} data-status={card.slaStatus} onClick={() => onOpen(card)}>
    <span className={styles.cardMeta}>{card.processType || "Demanda"}{card.referenceNumber != null && <small>#DM-{card.referenceNumber}</small>}</span>
    <strong>{card.title}</strong><span>{card.company || "Sem empresa informada"}</span>
    <span className={styles.cardFooter}><span>{status(card, listName)}</span><span>{card.assignees[0]?.name || card.assigneeName || "Sem responsável"}</span></span>
  </button>;
}

/* `DemandPriorityView` saiu com a chegada do quadro por responsável.
   Ela respondia "o que é mais urgente e quem está com o quê" numa lista
   ordenada; o quadro responde a mesma pergunta com a pessoa como coluna, e
   manter as duas deixaria uma tela construída sem ninguém que a renderize —
   que é exatamente o que a verificação de alcance do painel existe para
   acusar. O que ela usava de `lib/demand-dashboard.ts` continua vivo: a
   ordenação e a carga alimentam o quadro, e o próximo passo derivado é o
   texto de reserva do cartão quando a demanda ainda não tem um escrito. */
export function DemandDeadlineView({ cards, lists, onOpen }: { cards: Card[]; lists: WorkspaceSnapshot["lists"]; onOpen: (card: Card) => void }) {
  const [cursor, setCursor] = useState(() => new Date());
  const [mode, setMode] = useState<"week" | "month">("week");
  const days = useMemo(() => demandCalendarDays(cursor, mode), [cursor, mode]);
  const listNames = useMemo(() => new Map(lists.map((list) => [list.id, list.name])), [lists]);
  const { byDay, undated } = useMemo(() => {
    const byDay = new Map<string, Card[]>(), undated: Card[] = [];
    for (const card of prioritizeDemands(cards)) {
      const key = demandDeadlineDay(card.dueAt);
      if (!key) { undated.push(card); continue; }
      const bucket = byDay.get(key);
      if (bucket) bucket.push(card); else byDay.set(key, [card]);
    }
    return { byDay, undated };
  }, [cards]);
  const today = localDayKey(new Date());
  const dayFormat = (day: Date) => day.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  const periodLabel = mode === "week" ? `${dayFormat(days[0])} – ${dayFormat(days[6])}` : cursor.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const total = days.reduce((sum, day) => sum + (byDay.get(localDayKey(day))?.length ?? 0), 0);
  function move(direction: number) {
    setCursor((current) => mode === "week" ? new Date(current.getFullYear(), current.getMonth(), current.getDate() + direction * 7, 12) : new Date(current.getFullYear(), current.getMonth() + direction, 1, 12));
  }
  return <section className={styles.calendar} aria-label="Calendário de prazos">
    <header className={styles.calendarHead}><div><h2><CalendarDays aria-hidden="true" />{periodLabel}</h2><span>{total} prazos neste período</span></div><div className={styles.calendarControls}>
      <div role="group" aria-label="Período do calendário"><button type="button" aria-pressed={mode === "week"} onClick={() => setMode("week")}>Semana</button><button type="button" aria-pressed={mode === "month"} onClick={() => setMode("month")}>Mês</button></div>
      <button type="button" aria-label={mode === "week" ? "Semana anterior" : "Mês anterior"} onClick={() => move(-1)}><ArrowLeft aria-hidden="true" /></button><button type="button" onClick={() => setCursor(new Date())}>Hoje</button><button type="button" aria-label={mode === "week" ? "Próxima semana" : "Próximo mês"} onClick={() => move(1)}><ArrowRight aria-hidden="true" /></button>
    </div></header>
    <div className={styles.days} data-mode={mode}>{days.map((day) => {
      const key = localDayKey(day), bucket = byDay.get(key) ?? [];
      return <section className={styles.day} key={key} data-today={key === today} data-outside={mode === "month" && day.getMonth() !== cursor.getMonth()} aria-label={dayFormat(day)}>
        <header><span>{day.toLocaleDateString("pt-BR", { weekday: "short" })}</span><strong>{day.getDate()}</strong>{key === today && <small>Hoje</small>}<span className={styles.dayCount}>{bucket.length || ""}</span></header>
        {bucket.map((card) => <DemandPreview key={card.id} card={card} listName={listNames.get(card.listId)} onOpen={onOpen} />)}
        {!bucket.length && <p className={styles.dayEmpty}>Sem prazos</p>}
      </section>;
    })}</div>
    {undated.length > 0 && <details className={styles.undated}><summary>Sem prazo definido <b>{undated.length}</b></summary><div>{undated.map((card) => <DemandPreview key={card.id} card={card} listName={listNames.get(card.listId)} onOpen={onOpen} />)}</div></details>}
  </section>;
}
