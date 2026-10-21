"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, FileDown, LoaderCircle, Palmtree } from "lucide-react";
import styles from "./portal.module.css";

/**
 * O portal do colaborador: os holerites das folhas fechadas para baixar, o
 * saldo de férias de cada período e o pedido de férias, que vai para o DP
 * aprovar. Os mesmos estados dos outros portais: carregando, link inválido,
 * link encerrado e conteúdo.
 */

type Period = { acquisitiveStart: string; acquisitiveEnd: string; concessiveEnd: string; balance: number; status: string };
type Schedule = { id: string; startDate: string; restDays: number; soldDays: number; status: string };
type Portal = {
  employeeName: string; registrationNumber: string; companyName: string; expiresAt: string; today: string;
  payslips: Array<{ runId: string; competence: string; netCents: number }>;
  periods: Period[]; schedules: Schedule[];
};
type Status = "active" | "revoked" | "expired";

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const br = (date: string) => { const [y, m, d] = date.slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
const months = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const competence = (value: string) => { const [y, m] = value.split("-").map(Number); return `${months[m - 1]} de ${y}`; };
const scheduleLabels: Record<string, string> = { planned: "Pedida — aguardando o DP", approved: "Aprovada", taken: "Gozada", canceled: "Cancelada" };
const periodLabels: Record<string, string> = {
  acquiring: "Em aquisição", available: "Disponível", expiring: "Vence em breve", overdue: "Vencida", settled: "Quitada",
};

export function EmployeePortal({ token }: { token: string }) {
  const [portal, setPortal] = useState<Portal | null>(null);
  const [status, setStatus] = useState<Status>("active");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const endpoint = `/api/portal/colaborador/${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { portal?: Portal; status?: Status; message?: string; error?: string };
      if (!response.ok) { setLoadError(payload.error || payload.message || "Este link não é válido."); return; }
      setStatus(payload.status ?? "active");
      setPortal(payload.portal ?? null);
      setLoadError("");
    } catch {
      setLoadError("Não foi possível carregar. Confira sua conexão e tente de novo.");
    } finally { setLoading(false); }
  }, [endpoint]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true); setError(""); setDone("");
    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: form.get("startDate"), restDays: Number(form.get("restDays")), soldDays: Number(form.get("soldDays") || 0) }),
      });
      const payload = await response.json().catch(() => ({})) as { portal?: Portal; requested?: { end: string; returnDate: string }; error?: string; message?: string };
      if (!response.ok) { setError(payload.error || payload.message || "Não foi possível enviar o pedido."); return; }
      if (payload.portal) setPortal(payload.portal);
      setDone(payload.requested ? `Pedido enviado: férias até ${br(payload.requested.end)}, retorno em ${br(payload.requested.returnDate)}. O DP vai aprovar.` : "Pedido enviado.");
    } catch {
      setError("Não foi possível enviar. Confira sua conexão e tente de novo.");
    } finally { setSending(false); }
  }

  if (loading) {
    return <main className={styles.page}><section className={styles.card}>
      <p className={styles.loading} role="status"><LoaderCircle aria-hidden="true" className={styles.spin} /> Carregando…</p>
    </section></main>;
  }
  if (loadError || (status === "active" && !portal)) {
    return <main className={styles.page}><section className={styles.card}>
      <div className={styles.alert} role="alert"><AlertTriangle aria-hidden="true" /><p>{loadError || "Este link não é válido."}</p></div>
    </section></main>;
  }
  if (status !== "active" || !portal) {
    return <main className={styles.page}><section className={styles.card}>
      <div className={styles.alert} role="status"><AlertTriangle aria-hidden="true" />
        <p>{status === "revoked" ? "Este link foi cancelado pela empresa. Peça um novo ao DP." : "O prazo deste link terminou. Peça um novo ao DP."}</p></div>
    </section></main>;
  }

  const open = portal.periods.filter((period) => period.balance > 0 && period.status !== "acquiring");
  return <main className={styles.page}>
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.eyebrow}>PORTAL DO COLABORADOR · {portal.companyName}</span>
        <h1>Olá, {portal.employeeName}</h1>
        <p>Seus holerites e suas férias. Este link vale até {br(portal.expiresAt)}.</p>
      </header>

      <h2 className={styles.sectionTitle}>Holerites</h2>
      {portal.payslips.length ? <ul className={styles.list}>{portal.payslips.map((payslip) => <li key={payslip.runId}>
        <span><strong>{competence(payslip.competence)}</strong><small>Líquido {money(payslip.netCents)}</small></span>
        <a className={styles.download} href={`${endpoint}/holerite?runId=${encodeURIComponent(payslip.runId)}`} download>
          <FileDown aria-hidden="true" /> Baixar</a>
      </li>)}</ul> : <p className={styles.footnote}>Nenhuma folha fechada ainda.</p>}

      <h2 className={styles.sectionTitle}>Férias</h2>
      <ul className={styles.list}>{[...portal.periods].reverse().map((period) => <li key={period.acquisitiveStart}>
        <span><strong>{br(period.acquisitiveStart)} a {br(period.acquisitiveEnd)}</strong>
          <small>{periodLabels[period.status] ?? period.status} · saldo {period.balance} dias · gozar até {br(period.concessiveEnd)}</small></span>
        <Palmtree aria-hidden="true" />
      </li>)}</ul>
      {portal.schedules.length > 0 && <ul className={styles.list}>{portal.schedules.map((schedule) => <li key={schedule.id}>
        <span><strong>{br(schedule.startDate)} · {schedule.restDays} dias{schedule.soldDays ? ` + ${schedule.soldDays} vendidos` : ""}</strong>
          <small>{scheduleLabels[schedule.status] ?? schedule.status}</small></span>
        <CalendarDays aria-hidden="true" />
      </li>)}</ul>}

      {done && <div className={styles.success} role="status"><CheckCircle2 aria-hidden="true" /><div><p>{done}</p></div></div>}
      {open.length > 0 ? <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <h2 className={styles.sectionTitle}>Pedir férias</h2>
        {error && <div className={styles.alert} role="alert"><AlertTriangle aria-hidden="true" /><p>{error}</p></div>}
        <div className={styles.grid}>
          <label><span>Início</span><input name="startDate" type="date" required min={portal.today} /></label>
          <label><span>Dias de descanso</span><input name="restDays" type="number" min={5} max={30} defaultValue={30} required /></label>
          <label><span>Dias para vender (até 10)</span><input name="soldDays" type="number" min={0} max={10} defaultValue={0} /></label>
        </div>
        <button className={styles.submit} disabled={sending}>
          {sending ? <LoaderCircle aria-hidden="true" className={styles.spin} /> : <CalendarDays aria-hidden="true" />} Enviar pedido ao DP</button>
        <p className={styles.footnote}>As férias não começam na sexta nem no sábado, e o DP confirma o pedido.</p>
      </form> : <p className={styles.footnote}>Sem saldo de férias disponível para pedir agora.</p>}
    </section>
  </main>;
}
