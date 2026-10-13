"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarDays, Check, LoaderCircle, Palmtree, Users } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import {
  periodStatusLabels, validateSchedule, vacationStatusLabels,
  type PeriodStatus, type VacationPeriod, type VacationSchedule, type VacationStatus,
} from "@/lib/vacation-balance";
import { vacationDaysByAbsences } from "@/lib/payroll-calc";
import styles from "./erp-record.module.css";

/**
 * Férias do ERP DP — a cota 2006 do SAP: o período que mais aperta de cada
 * pessoa, a programação com as regras da CLT conferidas enquanto se digita
 * (o servidor confere de novo) e as férias coletivas.
 */

type Item = {
  employeeId: string; name: string; registrationNumber: string; companyName: string; admissionDate: string;
  period: VacationPeriod | null; overduePeriods: number; nextSchedule: VacationSchedule | null;
};
type Upcoming = VacationSchedule & { employeeId: string; name: string; registrationNumber: string };
type Overview = { today: string; items: Item[]; upcoming: Upcoming[] };
type Detail = { admissionDate: string; today: string; periods: VacationPeriod[]; schedules: Array<VacationSchedule & { notes: string }> };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}
const br = (date: string | null | undefined) => {
  if (!date) return "—";
  const [y, m, d] = date.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const tone: Record<PeriodStatus, string> = { acquiring: "neutral", available: "active", expiring: "warning", overdue: "critical", settled: "neutral" };

export function ErpVacationsPanel({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await requestJson<Overview>(`/api/erp-dp/vacations${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}`));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar as férias."); }
  }, [companyId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (selected) return <EmployeeVacations item={selected} canManage={canManage} onBack={() => { setSelected(null); void load(); }} />;

  const overdue = data?.items.filter((item) => item.period?.status === "overdue").length ?? 0;
  const expiring = data?.items.filter((item) => item.period?.status === "expiring").length ?? 0;

  return <div className={styles.employeePanel}>
    {error && <ErrorBanner title="Não foi possível carregar" message={error} />}
    {!data ? <LoadingState size="compact" title="Carregando férias" /> : <>
      <div className={styles.historySnapshot} aria-label="Resumo das férias">
        <article><small>Vencidas</small><strong>{overdue}</strong><span>Concessivo passou: em dobro (art. 137)</span></article>
        <article><small>Vencendo em 60 dias</small><strong>{expiring}</strong><span>Programe antes do fim do concessivo</span></article>
        <article><small>Começam em 60 dias</small><strong>{data.upcoming.length}</strong><span>Aviso com 30 dias (art. 135)</span></article>
      </div>
      {canManage && companyId && <CollectiveForm companyId={companyId} onDone={load} />}
      {canManage && !companyId && <p className={styles.infoNote}><Users aria-hidden="true" /><span><strong>Férias coletivas</strong>
        <small>Escolha uma empresa no topo para programar férias coletivas.</small></span></p>}
      {data.items.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <caption className="sr-only">Férias por colaborador</caption>
        <thead><tr><th>Matrícula</th><th>Colaborador</th><th>Período aquisitivo</th><th>Gozar até</th><th>Saldo</th><th>Situação</th><th>Próximas</th><th /></tr></thead>
        <tbody>{data.items.map((item) => <tr key={item.employeeId}>
          <td data-label="Matrícula">{item.registrationNumber}</td>
          <td data-label="Colaborador">{item.name}</td>
          <td data-label="Período">{item.period ? `${br(item.period.acquisitiveStart)} a ${br(item.period.acquisitiveEnd)}` : "Em aquisição"}</td>
          <td data-label="Gozar até">{br(item.period?.concessiveEnd)}</td>
          <td data-label="Saldo">{item.period ? `${item.period.balance} dias` : "—"}</td>
          <td data-label="Situação">{item.period ? <StatusPill status={tone[item.period.status]} label={periodStatusLabels[item.period.status]} /> : "—"}
            {item.overduePeriods > 1 && <small> ({item.overduePeriods} vencidos)</small>}</td>
          <td data-label="Próximas">{item.nextSchedule ? `${br(item.nextSchedule.startDate)} · ${item.nextSchedule.restDays} dias` : "—"}</td>
          <td><button type="button" className={styles.secondaryButton} onClick={() => setSelected(item)}>{canManage ? "Programar" : "Ver"}</button></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={Palmtree} size="compact" title="Ninguém com vínculo" text="Cadastre colaboradores para controlar as férias." />}
    </>}
  </div>;
}

function CollectiveForm({ companyId, onDone }: { companyId: string; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [restDays, setRestDays] = useState("20");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ planned: number; skipped: Array<{ name: string; reason: string }> } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setResult(null);
    try {
      setResult(await requestJson("/api/erp-dp/vacations/collective", { method: "POST", body: JSON.stringify({ companyId, startDate, restDays: Number(restDays), notes }) }));
      setError("");
      await onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível programar."); }
    finally { setBusy(false); }
  }

  if (!open) return <div><button type="button" className={styles.secondaryButton} onClick={() => setOpen(true)}><Users aria-hidden="true" /> Férias coletivas</button></div>;
  return <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
    <header><div><span>CLT ARTS. 139 A 141</span><h3>Férias coletivas da empresa</h3></div></header>
    {error && <ErrorBanner title="Não programado" message={error} />}
    {result && <p className={styles.infoNote}><Check aria-hidden="true" /><span><strong>{result.planned} pessoa(s) programada(s)</strong>
      <small>{result.skipped.length ? `Fora: ${result.skipped.map((item) => `${item.name} (${item.reason})`).join("; ")}` : "Todos couberam nas regras."}</small></span></p>}
    <div className={styles.formGrid}>
      <label><span>Início *</span><input type="date" required value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
      <label><span>Dias (mínimo 10) *</span><input type="number" min={10} max={30} required value={restDays} onChange={(event) => setRestDays(event.target.value)} /></label>
      <label className={styles.spanTwo}><span>Observações</span><textarea value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} /></label>
    </div>
    <footer><button type="button" className={styles.secondaryButton} onClick={() => setOpen(false)}>Fechar</button><span />
      <button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Check aria-hidden="true" />} Programar coletivas</button></footer>
  </form>;
}

function EmployeeVacations({ item, canManage, onBack }: { item: Item; canManage: boolean; onBack: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [acquisitiveStart, setAcquisitiveStart] = useState("");
  const [startDate, setStartDate] = useState("");
  const [restDays, setRestDays] = useState("30");
  const [soldDays, setSoldDays] = useState("0");
  const [absences, setAbsences] = useState("0");

  const load = useCallback(async () => {
    try {
      const payload = await requestJson<Detail>(`/api/employees/${encodeURIComponent(item.employeeId)}/vacations`);
      setData(payload);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar."); }
  }, [item.employeeId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const open = data?.periods.filter((period) => period.balance > 0 && period.status !== "settled") ?? [];
  const chosen = acquisitiveStart || open.find((period) => period.status !== "acquiring")?.acquisitiveStart || open[0]?.acquisitiveStart || "";

  // Prévia com as mesmas regras do servidor.
  const preview = (() => {
    if (!data || !startDate) return null;
    const period = data.periods.find((candidate) => candidate.acquisitiveStart === chosen) ?? null;
    try {
      return { ok: validateSchedule({ acquisitiveStart: chosen, startDate, restDays: Number(restDays), soldDays: Number(soldDays), entitledDays: vacationDaysByAbsences(Number(absences)) },
        period && startDate > data.today && period.status === "acquiring" && period.acquisitiveEnd < startDate ? { ...period, status: "available" } : period,
        data.schedules, data.today) };
    } catch (cause) { return { error: cause instanceof Error ? cause.message : "Fora das regras." }; }
  })();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setFeedback("");
    try {
      const payload = await requestJson<{ warnings: string[] }>(`/api/employees/${encodeURIComponent(item.employeeId)}/vacations`, {
        method: "POST", body: JSON.stringify({ acquisitiveStart: chosen, startDate, restDays: Number(restDays), soldDays: Number(soldDays), absences: Number(absences) }),
      });
      setFeedback(payload.warnings.length ? `Programada. ${payload.warnings.join(" ")}` : "Programada.");
      setError("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível programar."); }
    finally { setBusy(false); }
  }

  async function move(id: string, status: VacationStatus) {
    setBusy(true); setFeedback("");
    try {
      await requestJson(`/api/erp-dp/vacations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setFeedback(`Marcada como ${vacationStatusLabels[status].toLowerCase()}.`);
      setError("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar."); }
    finally { setBusy(false); }
  }

  return <div className={styles.employeePanel}>
    <header className={styles.sectionTitle}><h3>{item.registrationNumber} · {item.name}</h3>
      <button type="button" className={styles.secondaryButton} onClick={onBack}>Voltar à lista</button></header>
    {error && <ErrorBanner title="Atenção" message={error} />}
    {feedback && <p className={styles.infoNote}><Check aria-hidden="true" /><span><strong>{feedback}</strong></span></p>}
    {!data ? <LoadingState size="compact" title="Carregando períodos" /> : <>
      <div className={styles.tableWrap}><table className={styles.table}>
        <caption className="sr-only">Períodos aquisitivos</caption>
        <thead><tr><th>Período aquisitivo</th><th>Gozar até</th><th>Direito</th><th>Gozados</th><th>Programados</th><th>Saldo</th><th>Situação</th></tr></thead>
        <tbody>{[...data.periods].reverse().map((period) => <tr key={period.acquisitiveStart}>
          <td data-label="Período">{br(period.acquisitiveStart)} a {br(period.acquisitiveEnd)}</td>
          <td data-label="Gozar até">{br(period.concessiveEnd)}</td>
          <td data-label="Direito">{period.entitledDays}</td>
          <td data-label="Gozados">{period.usedDays}</td>
          <td data-label="Programados">{period.scheduledDays}</td>
          <td data-label="Saldo"><strong>{period.balance}</strong></td>
          <td data-label="Situação"><StatusPill status={tone[period.status]} label={periodStatusLabels[period.status]} /></td>
        </tr>)}</tbody>
      </table></div>
      {data.schedules.length > 0 && <div className={styles.tableWrap}><table className={styles.table}>
        <caption className="sr-only">Programações</caption>
        <thead><tr><th>Início</th><th>Gozo</th><th>Abono</th><th>Período</th><th>Estado</th><th /></tr></thead>
        <tbody>{data.schedules.map((schedule) => <tr key={schedule.id}>
          <td data-label="Início">{br(schedule.startDate)}{schedule.collective ? " · coletivas" : ""}</td>
          <td data-label="Gozo">{schedule.restDays} dias</td>
          <td data-label="Abono">{schedule.soldDays} dias</td>
          <td data-label="Período">{br(schedule.acquisitiveStart)}</td>
          <td data-label="Estado">{vacationStatusLabels[schedule.status]}</td>
          <td>{canManage && <span className={styles.chips}>
            {schedule.status === "planned" && <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void move(schedule.id, "approved")}>Aprovar</button>}
            {schedule.status === "approved" && <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void move(schedule.id, "taken")}>Marcar gozada</button>}
            {(schedule.status === "planned" || schedule.status === "approved") && <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void move(schedule.id, "canceled")}>Cancelar</button>}
          </span>}</td>
        </tr>)}</tbody>
      </table></div>}
      {canManage && (open.length ? <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
        <header><div><span>CLT ARTS. 134, 135 E 143</span><h3>Programar férias</h3></div></header>
        <div className={styles.formGrid}>
          <label><span>Período aquisitivo</span>
            <select value={chosen} onChange={(event) => setAcquisitiveStart(event.target.value)}>
              {open.map((period) => <option key={period.acquisitiveStart} value={period.acquisitiveStart}>
                {br(period.acquisitiveStart)} a {br(period.acquisitiveEnd)} · saldo {period.balance}</option>)}
            </select></label>
          <label><span>Início do gozo *</span><input type="date" required value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
          <label><span>Dias de gozo *</span><input type="number" min={5} max={30} required value={restDays} onChange={(event) => setRestDays(event.target.value)} /></label>
          <label><span>Dias de abono (venda)</span><input type="number" min={0} max={10} value={soldDays} onChange={(event) => setSoldDays(event.target.value)} /></label>
          <label><span>Faltas injustificadas no período</span><input type="number" min={0} value={absences} onChange={(event) => setAbsences(event.target.value)} /></label>
          {preview && ("error" in preview
            ? <p className={`${styles.infoNote} ${styles.spanTwo}`}><AlertTriangle aria-hidden="true" /><span><strong>Fora das regras</strong><small>{preview.error}</small></span></p>
            : <p className={`${styles.infoNote} ${styles.spanTwo}`}><CalendarDays aria-hidden="true" /><span>
              <strong>Gozo até {br(preview.ok.end)} · retorno em {br(preview.ok.returnDate)}</strong>
              <small>Aviso até {br(preview.ok.noticeDeadline)} · pagamento até {br(preview.ok.paymentDue)}. {preview.ok.warnings.join(" ")}</small></span></p>)}
        </div>
        <footer><span /><button className={styles.primaryButton} disabled={busy || Boolean(preview && "error" in preview)}>
          {busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Check aria-hidden="true" />} Programar</button></footer>
      </form> : <EmptyState icon={Palmtree} size="compact" title="Sem saldo para programar" text="Os períodos estão quitados ou ainda em aquisição." />)}
    </>}
  </div>;
}
