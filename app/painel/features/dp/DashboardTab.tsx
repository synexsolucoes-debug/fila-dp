"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Download, Send } from "lucide-react";
import { ErrorBanner, LoadingState } from "../shared";
import { dpRequest, errorText } from "./dp.api";
import styles from "./dp.module.css";

type ReportRow = { area: string; total: number; open: number; outside: number; outsidePercent: number };
type Holder = { userId: string; name: string; companies: number; employeesClt: number; contractorsPj: number; openCards: number; overdueCards: number; alerts: number };
type Payload = {
  from: string; to: string; holders: Holder[]; byArea: ReportRow[]; byType: ReportRow[];
  totals: { openCards: number; overdueCards: number; unassignedCards: number; alerts: number; occurrences: number };
};

function Breakdown({ title, rows }: { title: string; rows: ReportRow[] }) {
  return <section className={styles.card}>
    <header className={styles.cardHeader}><div><h3>{title}</h3><p>Demandas com regra de corte no período.</p></div></header>
    {!rows.length ? <p className={styles.hint} style={{ padding: "12px 16px" }}>Sem demandas com regra de corte no período.</p>
      : <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>{title.replace("Demandas por ", "")}</th><th className={styles.num}>Total</th><th className={styles.num}>Em aberto</th><th className={styles.num}>% fora do corte</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.area}><td>{row.area}</td><td className={styles.num}>{row.total}</td><td className={styles.num}>{row.open}</td>
          <td className={styles.num}><span className={styles.badge} data-tone={row.outsidePercent >= 30 ? "danger" : row.outsidePercent > 0 ? "warn" : "ok"}>{row.outsidePercent.toLocaleString("pt-BR")}%</span></td></tr>)}</tbody>
      </table></div>}
  </section>;
}

/** Painel da gestão e relatório mensal (PDF por e-mail). */
export function DashboardTab({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState(() => {
    const now = new Date();
    now.setUTCDate(1); now.setUTCMonth(now.getUTCMonth() - 1);
    return now.toISOString().slice(0, 7);
  });
  const [recipients, setRecipients] = useState("");

  const load = useCallback(async () => {
    try {
      const [dashboard, settings] = await Promise.all([
        dpRequest<Payload>("/api/dp/dashboard"),
        dpRequest<{ reportRecipients: string; tenantTaskOwnerUserId: string | null }>("/api/dp/settings"),
      ]);
      setData(dashboard);
      setRecipients(settings.reportRecipients);
      setError("");
    } catch (cause) { setError(errorText(cause, "Não foi possível carregar o painel.")); }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function saveRecipients(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const current = await dpRequest<{ tenantTaskOwnerUserId: string | null }>("/api/dp/settings");
      const saved = await dpRequest<{ reportRecipients: string }>("/api/dp/settings", {
        method: "PATCH", body: JSON.stringify({ reportRecipients: recipients, tenantTaskOwnerUserId: current.tenantTaskOwnerUserId }),
      });
      setRecipients(saved.reportRecipients);
      setNotice("Destinatários do relatório salvos.");
    } catch (cause) { setError(errorText(cause, "Não foi possível salvar.")); }
    finally { setBusy(false); }
  }

  async function sendNow() {
    setBusy(true);
    try {
      const result = await dpRequest<{ recipients: number }>("/api/dp/report", { method: "POST", body: JSON.stringify({ competencia: period }) });
      setNotice(`Relatório de ${period.slice(5)}/${period.slice(0, 4)} enviado para ${result.recipients} destinatário(s).`);
    } catch (cause) { setError(errorText(cause, "Não foi possível enviar.")); }
    finally { setBusy(false); }
  }

  if (!data) return error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : <LoadingState title="Carregando o painel" size="compact" />;
  return <div className={styles.root}>
    {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <section className={styles.metrics} aria-label="Resumo do DP">
      <article><span>Demandas abertas</span><strong>{data.totals.openCards}</strong></article>
      <article data-tone={data.totals.overdueCards ? "danger" : undefined}><span>Atrasadas</span><strong>{data.totals.overdueCards}</strong></article>
      <article data-tone={data.totals.unassignedCards ? "warn" : undefined}><span>Sem responsável</span><strong>{data.totals.unassignedCards}</strong></article>
      <article data-tone={data.totals.alerts ? "warn" : undefined}><span>Alertas abertos</span><strong>{data.totals.alerts}</strong></article>
      <article><span>Ocorrências no mês</span><strong>{data.totals.occurrences}</strong></article>
    </section>
    <section className={styles.card}>
      <header className={styles.cardHeader}><div><h3>Carga por titular</h3><p>Empresas da carteira, pessoas ativas (CLT) e prestadores PJ, demandas e alertas de cada analista.</p></div></header>
      {!data.holders.length ? <p className={styles.hint} style={{ padding: "12px 16px" }}>A carteira ainda não tem titulares. Defina em Operação DP › Carteira.</p>
        : <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>Titular</th><th className={styles.num}>Empresas</th><th className={styles.num}>Ativos CLT</th><th className={styles.num}>PJ</th><th className={styles.num}>Abertas</th><th className={styles.num}>Atrasadas</th><th className={styles.num}>Alertas</th></tr></thead>
          <tbody>{data.holders.map((holder) => <tr key={holder.userId}>
            <td>{holder.name}</td><td className={styles.num}>{holder.companies}</td><td className={styles.num}>{holder.employeesClt}</td><td className={styles.num}>{holder.contractorsPj}</td>
            <td className={styles.num}>{holder.openCards}</td><td className={styles.num}>{holder.overdueCards ? <span className={styles.badge} data-tone="danger">{holder.overdueCards}</span> : 0}</td>
            <td className={styles.num}>{holder.alerts}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    <div className={styles.split}><Breakdown title="Demandas por área" rows={data.byArea} /><Breakdown title="Demandas por tipo" rows={data.byType} /></div>
    <section className={styles.card}>
      <header className={styles.cardHeader}><div><h3>Relatório mensal</h3><p>PDF com volume entregue, atrasos e origem, riscos e carga por titular. O job diário envia o do mês anterior até o dia 5.</p></div></header>
      <div className={styles.form}>
        <label>Competência<input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
        <a className={styles.ghostButton} href={`/api/dp/report?competencia=${period}`}><Download aria-hidden="true" /> Baixar PDF</a>
        {canManage && <button type="button" className={styles.primaryButton} disabled={busy || !recipients.trim()} onClick={() => void sendNow()}><Send aria-hidden="true" /> Enviar agora</button>}
      </div>
      {canManage && <form className={styles.form} onSubmit={(event) => void saveRecipients(event)}>
        <label className={styles.grow}>Destinatários (gestão), separados por vírgula<input value={recipients} maxLength={2000} placeholder="diretoria@empresa.com.br" onChange={(event) => setRecipients(event.target.value)} /></label>
        <button type="submit" className={styles.ghostButton} disabled={busy}>Salvar destinatários</button>
      </form>}
    </section>
  </div>;
}
