"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, RefreshCw } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState } from "../shared";
import { brDate, dpRequest, errorText } from "./dp.api";
import styles from "./dp.module.css";

type Alert = {
  id: string; type: string; typeLabel: string; severity: string; severityLabel: string; title: string; detail: string;
  dueDate: string | null; employeeId: string | null; companyName: string; assignedName: string | null; managerEmail: string;
  decision: string | null; decisionNote: string; decisionSource: string | null; decidedAt: string | null;
};
type SummaryRow = { key: string; label: string; total: number; overdue: number; urgent: number };
type Payload = { status: "open" | "answered"; alerts: Alert[]; byType: SummaryRow[]; byHolder: SummaryRow[] };

const tone = (severity: string) => severity === "overdue" ? "danger" : severity === "urgent" ? "warn" : undefined;

function Summary({ title, rows }: { title: string; rows: SummaryRow[] }) {
  return <section className={styles.card}>
    <header className={styles.cardHeader}><div><h3>{title}</h3></div></header>
    {!rows.length ? <p className={styles.hint} style={{ padding: "12px 16px" }}>Nenhum alerta.</p>
      : <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>{title.replace("Por ", "")}</th><th className={styles.num}>Total</th><th className={styles.num}>Urgentes</th><th className={styles.num}>Vencidos</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key}><td>{row.label}</td><td className={styles.num}>{row.total}</td><td className={styles.num}>{row.urgent}</td><td className={styles.num}>{row.overdue}</td></tr>)}</tbody>
      </table></div>}
  </section>;
}

/**
 * Alertas de experiência, férias e cadastro, com a contagem por tipo e por
 * titular. Cada alerta abre a ficha do colaborador; experiência recebe a
 * decisão do gestor (pelo Teams ou anotada aqui).
 */
export function AlertsTab({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<"abertos" | "respondidos">("abertos");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await dpRequest<Payload>(`/api/dp/alerts?situacao=${status}`)); setError(""); }
    catch (cause) { setError(errorText(cause, "Não foi possível carregar os alertas.")); }
  }, [status]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function refresh() {
    setBusy(true);
    try {
      const result = await dpRequest<{ open: number }>("/api/dp/alerts/refresh", { method: "POST" });
      setNotice(`Alertas recalculados: ${result.open} aberto(s).`);
      await load();
    } catch (cause) { setError(errorText(cause, "Não foi possível recalcular.")); }
    finally { setBusy(false); }
  }

  async function decide(alert: Alert, decision: string) {
    setBusy(true);
    try {
      await dpRequest(`/api/dp/alerts/${encodeURIComponent(alert.id)}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
      setNotice(`Decisão registrada: ${decision}.`);
      await load();
    } catch (cause) { setError(errorText(cause, "Não foi possível registrar a decisão.")); }
    finally { setBusy(false); }
  }

  const counts = data ? {
    total: data.alerts.length,
    overdue: data.alerts.filter((alert) => alert.severity === "overdue").length,
    urgent: data.alerts.filter((alert) => alert.severity === "urgent").length,
  } : null;

  return <div className={styles.root}>
    <div className={styles.toolbar}>
      <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value as "abertos" | "respondidos")}>
        <option value="abertos">Abertos</option><option value="respondidos">Experiências respondidas</option>
      </select></label>
      {canManage && <button type="button" className={styles.ghostButton} disabled={busy} onClick={() => void refresh()}><RefreshCw aria-hidden="true" /> Recalcular agora</button>}
    </div>
    {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {!data || !counts ? <LoadingState title="Carregando os alertas" size="compact" /> : <>
      <section className={styles.metrics} aria-label="Resumo dos alertas">
        <article><span>Alertas</span><strong>{counts.total}</strong></article>
        <article data-tone={counts.urgent ? "warn" : undefined}><span>Urgentes</span><strong>{counts.urgent}</strong></article>
        <article data-tone={counts.overdue ? "danger" : undefined}><span>Vencidos</span><strong>{counts.overdue}</strong></article>
      </section>
      <div className={styles.split}><Summary title="Por tipo" rows={data.byType} /><Summary title="Por titular" rows={data.byHolder} /></div>
      <section className={styles.card}>
        <header className={styles.cardHeader}><div><h3>{status === "abertos" ? "Alertas abertos" : "Experiências respondidas"}</h3>
          <p>Férias: calculadas pela admissão e pelas férias registradas como movimentação, até a tabela de férias do Sankhya entrar na sincronização.</p></div></header>
        {!data.alerts.length ? <EmptyState icon={BellRing} size="compact" title="Nenhum alerta" text="Experiências, férias e cadastros estão em dia." />
          : <ul className={styles.list}>{data.alerts.map((alert) => <li key={alert.id}>
            <div>
              {alert.employeeId ? <a className={styles.titleLink} href={`/painel/cadastros/${encodeURIComponent(alert.employeeId)}`}>{alert.title}</a> : <strong>{alert.title}</strong>}
              <small>{alert.typeLabel} · {alert.detail}{alert.assignedName ? ` · Responsável: ${alert.assignedName}` : " · Sem responsável"}{alert.managerEmail ? ` · Gestor: ${alert.managerEmail}` : ""}</small>
              {alert.decision && <small>Decisão: <strong>{alert.decision}</strong> ({alert.decisionSource === "teams" ? "pelo Teams" : "no painel"}{alert.decidedAt ? `, ${brDate(alert.decidedAt)}` : ""}){alert.decisionNote ? ` — ${alert.decisionNote}` : ""}</small>}
            </div>
            <div className={styles.toolbar}>
              <span className={styles.badge} data-tone={tone(alert.severity)}>{alert.severityLabel}{alert.dueDate ? ` · ${brDate(alert.dueDate)}` : ""}</span>
              {canManage && status === "abertos" && alert.type.startsWith("experience_") && ["efetivar", "prorrogar", "desligar"].map((decision) =>
                <button key={decision} type="button" className={styles.linkButton} disabled={busy} onClick={() => void decide(alert, decision)}>{decision[0].toUpperCase() + decision.slice(1)}</button>)}
            </div>
          </li>)}</ul>}
      </section>
    </>}
  </div>;
}
