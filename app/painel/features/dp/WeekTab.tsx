"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState } from "../shared";
import { brDate, dpRequest, errorText, weekdayShort } from "./dp.api";
import styles from "./dp.module.css";

type WeekItem = { kind: "card" | "alert"; id: string; title: string; dueDay: string; detail: string; priority: string; recurring: boolean; href: string };
type WeekPayload = { today: string; monday: string; sunday: string; overdue: WeekItem[]; days: Array<{ day: string; items: WeekItem[] }> };

const shift = (date: string, days: number) => {
  const cursor = new Date(`${date}T12:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
};

function Item({ item }: { item: WeekItem }) {
  return <li>
    <div>
      <a href={item.href}>{item.title}</a>
      <small>{[item.detail, item.kind === "alert" ? "Alerta do DP" : item.recurring ? "Rotina do mês" : "Demanda"].filter(Boolean).join(" · ")}</small>
    </div>
    {item.priority === "urgent" || item.priority === "high"
      ? <span className={styles.badge} data-tone="warn">{item.priority === "urgent" ? "Urgente" : "Alta"}</span>
      : null}
  </li>;
}

/** Minha semana: o que vence em cada dia, com as atrasadas no topo. */
export function WeekTab() {
  const [start, setStart] = useState("");
  const [data, setData] = useState<WeekPayload | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await dpRequest<WeekPayload>(`/api/dp/week${start ? `?inicio=${start}` : ""}`));
      setError("");
    } catch (cause) { setError(errorText(cause, "Não foi possível carregar a semana.")); }
  }, [start]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (error) return <ErrorBanner message={error} onDismiss={() => setError("")} />;
  if (!data) return <LoadingState title="Carregando sua semana" size="compact" />;
  const total = data.overdue.length + data.days.reduce((sum, day) => sum + day.items.length, 0);

  return <section className={styles.card} aria-label="Minha semana">
    <header className={styles.cardHeader}>
      <div><h3>Semana de {brDate(data.monday)} a {brDate(data.sunday)}</h3><p>Demandas e alertas atribuídos a você. Atrasadas primeiro.</p></div>
      <div className={styles.toolbar}>
        <button type="button" className={styles.ghostButton} onClick={() => setStart(shift(data.monday, -7))} aria-label="Semana anterior"><ChevronLeft aria-hidden="true" /></button>
        <button type="button" className={styles.ghostButton} onClick={() => setStart("")}>Esta semana</button>
        <button type="button" className={styles.ghostButton} onClick={() => setStart(shift(data.monday, 7))} aria-label="Próxima semana"><ChevronRight aria-hidden="true" /></button>
        <button type="button" className={styles.ghostButton} onClick={() => void load()}><RefreshCw aria-hidden="true" /> Atualizar</button>
      </div>
    </header>
    {total === 0 && <EmptyState icon={CalendarCheck} title="Nada vencendo nesta semana" text="Quando uma demanda ou alerta for atribuído a você com prazo na semana, ele aparece aqui." size="compact" />}
    {data.overdue.length > 0 && <div className={`${styles.dayGroup} ${styles.overdue}`}>
      <h4>Atrasadas ({data.overdue.length})</h4>
      <ul className={styles.list}>{data.overdue.map((item) => <Item key={`${item.kind}-${item.id}`} item={item} />)}</ul>
    </div>}
    {total > 0 && data.days.map((day) => <div key={day.day} className={styles.dayGroup} data-today={day.day === data.today}>
      <h4>{weekdayShort[new Date(`${day.day}T12:00:00Z`).getUTCDay()]}, {brDate(day.day)}{day.day === data.today ? " · hoje" : ""} ({day.items.length})</h4>
      {day.items.length ? <ul className={styles.list}>{day.items.map((item) => <Item key={`${item.kind}-${item.id}`} item={item} />)}</ul> : null}
    </div>)}
  </section>;
}
