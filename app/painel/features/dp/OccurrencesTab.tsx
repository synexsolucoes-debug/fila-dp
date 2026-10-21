"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ClipboardX } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState } from "../shared";
import { brDate, dpRequest, errorText } from "./dp.api";
import styles from "./dp.module.css";

type ReportRow = { area: string; total: number; open: number; outside: number; outsidePercent: number };
type Occurrence = { id: string; occurredOn: string; area: string; companyName: string; fact: string; impact: string; origin: string; daysLate: number | null; cardId: string | null; registeredBy: string };
type Payload = { from: string; to: string; byArea: ReportRow[]; byType: ReportRow[]; occurrences: Occurrence[] };

function ReportTable({ rows, label }: { rows: ReportRow[]; label: string }) {
  if (!rows.length) return <p className={styles.hint} style={{ padding: "12px 16px" }}>Nenhuma demanda com regra de corte no período.</p>;
  return <div className={styles.tableWrap}><table className={styles.table}>
    <thead><tr><th>{label}</th><th className={styles.num}>Total</th><th className={styles.num}>Em aberto</th><th className={styles.num}>Fora do corte</th><th className={styles.num}>% fora</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.area}>
      <td>{row.area}</td><td className={styles.num}>{row.total}</td><td className={styles.num}>{row.open}</td>
      <td className={styles.num}>{row.outside}</td>
      <td className={styles.num}><span className={styles.badge} data-tone={row.outsidePercent >= 30 ? "danger" : row.outsidePercent > 0 ? "warn" : "ok"}>{row.outsidePercent.toLocaleString("pt-BR")}%</span></td>
    </tr>)}</tbody>
  </table></div>;
}

/** Ocorrências e o relatório por área: o que chegou fora do prazo de corte, e de onde. */
export function OccurrencesTab({ canManage }: { canManage: boolean }) {
  const [range, setRange] = useState({ from: "", to: "" });
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ occurredOn: "", area: "", fact: "", impact: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const query = new URLSearchParams();
    if (range.from) query.set("de", range.from);
    if (range.to) query.set("ate", range.to);
    try { setData(await dpRequest<Payload>(`/api/dp/occurrences?${query}`)); setError(""); }
    catch (cause) { setError(errorText(cause, "Não foi possível carregar as ocorrências.")); }
  }, [range]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await dpRequest("/api/dp/occurrences", { method: "POST", body: JSON.stringify(form) });
      setNotice("Ocorrência registrada.");
      setForm({ occurredOn: "", area: "", fact: "", impact: "" });
      await load();
    } catch (cause) { setError(errorText(cause, "Não foi possível registrar.")); }
    finally { setBusy(false); }
  }

  return <div className={styles.root}>
    <div className={styles.toolbar}>
      <label>De<input type="date" value={range.from || data?.from || ""} onChange={(event) => setRange({ ...range, from: event.target.value })} /></label>
      <label>Até<input type="date" value={range.to || data?.to || ""} onChange={(event) => setRange({ ...range, to: event.target.value })} /></label>
    </div>
    {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {!data ? <LoadingState title="Carregando o relatório" size="compact" /> : <>
      <div className={styles.split}>
        <section className={styles.card}><header className={styles.cardHeader}><div><h3>Por área</h3><p>Quem pediu fora do prazo de corte no período.</p></div></header><ReportTable rows={data.byArea} label="Área" /></section>
        <section className={styles.card}><header className={styles.cardHeader}><div><h3>Por tipo de processo</h3><p>Total, em aberto e % fora do corte.</p></div></header><ReportTable rows={data.byType} label="Tipo" /></section>
      </div>
      <section className={styles.card}>
        <header className={styles.cardHeader}><div><h3>Ocorrências</h3><p>Automáticas (fora do corte) e registradas à mão.</p></div></header>
        {canManage && <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <label>Data<input type="date" value={form.occurredOn} onChange={(event) => setForm({ ...form, occurredOn: event.target.value })} /></label>
          <label>Área<input value={form.area} maxLength={120} placeholder="Comercial, Operações…" onChange={(event) => setForm({ ...form, area: event.target.value })} /></label>
          <label className={styles.grow}>Fato<input required value={form.fact} maxLength={1000} onChange={(event) => setForm({ ...form, fact: event.target.value })} /></label>
          <label className={styles.grow}>Impacto<input value={form.impact} maxLength={1000} onChange={(event) => setForm({ ...form, impact: event.target.value })} /></label>
          <button type="submit" className={styles.primaryButton} disabled={busy || !form.fact.trim()}>Registrar ocorrência</button>
        </form>}
        {!data.occurrences.length ? <EmptyState icon={ClipboardX} size="compact" title="Nenhuma ocorrência no período" text="Demanda que chega fora do prazo de corte gera ocorrência automática." />
          : <div className={styles.tableWrap}><table className={styles.table}>
            <thead><tr><th>Data</th><th>Área</th><th>Empresa</th><th>Fato</th><th>Impacto</th><th className={styles.num}>Atraso</th><th>Origem</th></tr></thead>
            <tbody>{data.occurrences.map((item) => <tr key={item.id}>
              <td>{brDate(item.occurredOn)}</td><td>{item.area || "—"}</td><td>{item.companyName || "—"}</td>
              <td>{item.cardId ? <a href={`/painel/demandas/${encodeURIComponent(item.cardId)}`}>{item.fact}</a> : item.fact}</td>
              <td>{item.impact || "—"}</td><td className={styles.num}>{item.daysLate === null ? "—" : `${item.daysLate} d`}</td>
              <td><span className={styles.badge} data-tone={item.origin === "automatica" ? "warn" : undefined}>{item.origin === "automatica" ? "Automática" : `Manual · ${item.registeredBy}`}</span></td>
            </tr>)}</tbody>
          </table></div>}
      </section>
    </>}
  </div>;
}
