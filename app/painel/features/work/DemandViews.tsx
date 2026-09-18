"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, Clock3, Inbox, ListChecks, Users } from "lucide-react";
import type { Card, WorkspaceSnapshot } from "@/lib/fila-dp-types";
import { PRIORITY_LABELS } from "@/lib/work-items";
import { demandAssigneeWorkload, demandCalendarDays, demandDeadlineDay, demandNextAction, isOpenDemand, localDayKey, prioritizeDemands } from "@/lib/demand-dashboard";
import styles from "./DemandViews.module.css";

function deadline(card: Card) {
  if (!card.dueAt) return "Sem prazo";
  const date = new Date(card.dueAt.includes("T") ? card.dueAt : `${card.dueAt.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "Sem prazo" : date.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

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

export function DemandPriorityView({ cards, lists, onOpen, onWaiting, renderAreaFlow }: {
  cards: Card[]; lists: WorkspaceSnapshot["lists"]; onOpen: (card: Card) => void; onWaiting: () => void; renderAreaFlow: (card: Card) => ReactNode;
}) {
  const ordered = useMemo(() => prioritizeDemands(cards), [cards]);
  const workload = useMemo(() => demandAssigneeWorkload(cards), [cards]);
  const listNames = useMemo(() => new Map(lists.map((list) => [list.id, list.name])), [lists]);
  const open = cards.filter(isOpenDemand).length;
  const waiting = cards.filter((card) => isOpenDemand(card) && (card.slaStatus === "paused" || lists.some((list) => list.id === card.listId && list.slaBehavior === "paused"))).length;
  return <div className={styles.central}>
    <section className={styles.queue} aria-label="Fila de prioridades">
      <header className={styles.sectionHead}><div><h2>Fila de prioridades</h2><span>{cards.length} demandas nos filtros atuais</span></div><span className={styles.hint}>Atrasos primeiro</span></header>
      {ordered.length ? <ul className={styles.rows}>{ordered.map((card) => <li key={card.id}>
        <button type="button" className={styles.row} onClick={() => onOpen(card)}>
          <span className={styles.rowContent}><span className={styles.cardMeta}>{card.referenceNumber != null ? `#DM-${card.referenceNumber} · ` : ""}{card.processType || "Demanda"}</span><strong>{card.title}</strong><span>{card.company || "Sem empresa informada"}</span>{renderAreaFlow(card)}<small>{demandNextAction(card)}</small></span>
          <span className={styles.rowState}><span className={styles.status} data-status={card.slaStatus}>{status(card, listNames.get(card.listId))}</span><span><Clock3 aria-hidden="true" />{deadline(card)}</span></span>
          <span className={styles.rowOwner}><span>{card.assignees.map((person) => person.name).join(", ") || card.assigneeName || "Sem responsável"}</span><small>{PRIORITY_LABELS[card.priority]}</small></span>
          <ArrowRight className={styles.openArrow} aria-hidden="true" />
        </button>
      </li>)}</ul> : <div className={styles.empty}><Inbox aria-hidden="true" /><strong>Nenhuma demanda neste filtro</strong><span>Ajuste os filtros para ampliar a consulta.</span></div>}
    </section>
    <aside className={styles.workload} aria-label="Distribuição de trabalho">
      <h2><Users aria-hidden="true" />Demandas por responsável</h2>
      <p>Abertas no recorte atual</p>
      {workload.map((person) => <div className={styles.person} key={person.id}>
        <div><strong>{person.name}</strong><b>{person.open}</b></div><div className={styles.track} aria-hidden="true"><span style={{ width: `${open ? person.open / open * 100 : 0}%` }} /></div>
        <small>{person.waiting ? `${person.waiting} aguardando retorno` : "Sem demandas em espera"}</small>
      </div>)}
      {!workload.length && <p>Nenhuma demanda aberta neste recorte.</p>}
      {cards.some((card) => isOpenDemand(card) && card.assignees.length > 1) && <p className={styles.sharedNote}>Demandas compartilhadas aparecem para cada responsável.</p>}
      {waiting > 0 && <div className={styles.waiting}><ListChecks aria-hidden="true" /><strong>Retornos pendentes</strong><p>{waiting} demandas aguardam retorno para continuar.</p><button type="button" onClick={onWaiting}>Ver pendências <ArrowRight aria-hidden="true" /></button></div>}
    </aside>
  </div>;
}

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
