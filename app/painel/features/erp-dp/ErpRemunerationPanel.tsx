"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Banknote, Check, LoaderCircle, RefreshCw } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import {
  monthlySalaryOf, parseMoney, remunerationReasonLabels, salaryKindLabels,
  type Remuneration, type RemunerationReason, type SalaryKind,
} from "@/lib/remuneration";
import { brl } from "@/lib/payroll-calc";
import { ErpBankAccountForm } from "./ErpObligationsPanel";
import styles from "./erp-record.module.css";

type Payload = { admissionDate: string; records: Remuneration[]; current: Remuneration | null; currentMonthlySalary: number | null; gaps: string[] };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function dateLabel(value: string | null) {
  if (!value || value === "9999-12-31") return "em aberto";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR").format(date);
}

const centsToInput = (cents: number) => (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A aba "Remuneração" da Ficha funcional do ERP DP — o infotipo 0008 do SAP:
 * salário com vigência, tipo (mensalista ou horista), horas do contrato,
 * dependentes do IRRF e adicional de insalubridade ou periculosidade. É a
 * base de todo cálculo do menu Cálculos.
 */
export function ErpRemunerationPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await requestJson<Payload>(`/api/employees/${encodeURIComponent(employeeId)}/remuneration`)); setError(""); }
    catch (cause) { setData(null); setError(cause instanceof Error ? cause.message : "Erro ao carregar a remuneração."); }
    finally { setLoading(false); }
  }, [employeeId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (loading && !data) return <div className={styles.employeePanel}><LoadingState size="compact" title="Carregando a remuneração" /></div>;
  if (error || !data) {
    return <div className={styles.employeePanel}>
      <ErrorBanner title="Não foi possível carregar a remuneração" message={error} />
      <EmptyState icon={AlertTriangle} size="compact" title="Remuneração indisponível" text="Isso pode ser falta de permissão ou uma falha momentânea."
        action={<button className={styles.secondaryButton} onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />
    </div>;
  }

  const current = data.current;
  return <div className={styles.employeePanel}>
    <header className={styles.sectionTitle}><h3>Remuneração</h3><span>Admissão em {dateLabel(data.admissionDate)}</span></header>
    {current ? <div className={styles.historySnapshot} aria-label="Remuneração vigente">
      <article><small>Salário mensal vigente</small><strong>{brl(data.currentMonthlySalary ?? 0)}</strong>
        <span>{salaryKindLabels[current.salaryKind]}{current.salaryKind === "hourly" ? ` · ${brl(current.amountCents)}/h × ${current.monthlyHours} h` : ""}</span></article>
      <article><small>Jornada</small><strong>{current.monthlyHours} h/mês</strong><span>Desde {dateLabel(current.validFrom)}</span></article>
      <article><small>Dependentes IRRF</small><strong>{current.irrfDependents}</strong><span>Dedução por dependente na base</span></article>
      <article><small>Vale-transporte</small><strong>{current.transportVoucherCents ? brl(current.transportVoucherCents) : "Não usa"}</strong>
        <span>{current.transportVoucherCents ? "Desconto de até 6% do salário-base" : "—"}</span></article>
      <article><small>Adicional</small><strong>{current.hazardous ? "Periculosidade 30%" : current.unhealthyPercent ? `Insalubridade ${current.unhealthyPercent}%` : "Nenhum"}</strong>
        <span>{current.hazardous ? "Sobre o salário-base" : current.unhealthyPercent ? "Sobre o salário mínimo" : "—"}</span></article>
    </div> : <EmptyState icon={Banknote} size="compact" title="Sem remuneração vigente"
      text="Cadastre o salário a partir da admissão para calcular folha, férias, 13º e rescisão." />}
    {data.gaps.length > 0 && <p className={styles.infoNote}><AlertTriangle aria-hidden="true" /><span><strong>Há períodos sem salário</strong>
      <small>{data.gaps.join("; ")}. Um cálculo nessas datas usa o salário da admissão.</small></span></p>}
    {data.records.length > 0 && <div className={styles.tableWrap}><table className={styles.table}>
      <caption className="sr-only">Histórico de remuneração</caption>
      <thead><tr><th>Vigência</th><th>Salário</th><th>Tipo</th><th>Motivo</th><th>Dependentes</th></tr></thead>
      <tbody>{data.records.map((record) => <tr key={record.id}>
        <td data-label="Vigência">{dateLabel(record.validFrom)} a {dateLabel(record.validTo)}</td>
        <td data-label="Salário"><strong>{brl(monthlySalaryOf(record))}</strong></td>
        <td data-label="Tipo">{salaryKindLabels[record.salaryKind]}</td>
        <td data-label="Motivo">{record.id === current?.id ? <StatusPill status="active" label={remunerationReasonLabels[record.reason]} /> : remunerationReasonLabels[record.reason]}</td>
        <td data-label="Dependentes">{record.irrfDependents}</td>
      </tr>)}</tbody>
    </table></div>}
    {canManage && <RemunerationEditor employeeId={employeeId} admissionDate={data.admissionDate} current={current} first={data.records.length === 0} onSaved={load} />}
    <ErpBankAccountForm employeeId={employeeId} canManage={canManage} />
  </div>;
}

function RemunerationEditor({ employeeId, admissionDate, current, first, onSaved }: {
  employeeId: string; admissionDate: string; current: Remuneration | null; first: boolean; onSaved: () => Promise<void>;
}) {
  const [validFrom, setValidFrom] = useState(first ? admissionDate : "");
  const [salaryKind, setSalaryKind] = useState<SalaryKind>(current?.salaryKind ?? "monthly");
  const [amount, setAmount] = useState(current ? centsToInput(current.amountCents) : "");
  const [monthlyHours, setMonthlyHours] = useState(String(current?.monthlyHours ?? 220));
  const [irrfDependents, setIrrfDependents] = useState(String(current?.irrfDependents ?? 0));
  const [additional, setAdditional] = useState(current?.hazardous ? "hazardous" : String(current?.unhealthyPercent ?? 0));
  const [transportVoucher, setTransportVoucher] = useState(current?.transportVoucherCents ? centsToInput(current.transportVoucherCents) : "");
  const [mealVoucherDiscount, setMealVoucherDiscount] = useState(current?.mealVoucherDiscountCents ? centsToInput(current.mealVoucherDiscountCents) : "");
  const [reason, setReason] = useState<RemunerationReason>(first ? "admission" : "raise");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const cents = parseMoney(amount);
  const preview = cents ? monthlySalaryOf({ salaryKind, amountCents: cents, monthlyHours: Number(monthlyHours) || 0 }) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setSaved("");
    try {
      const payload = await requestJson<{ mode: "correct" | "insert" }>(`/api/employees/${encodeURIComponent(employeeId)}/remuneration`, {
        method: "PUT",
        body: JSON.stringify({
          validFrom, salaryKind, amount, monthlyHours: Number(monthlyHours), irrfDependents: Number(irrfDependents),
          unhealthyPercent: additional === "hazardous" ? 0 : Number(additional), hazardous: additional === "hazardous",
          transportVoucher, mealVoucherDiscount, reason, notes,
        }),
      });
      setError("");
      setSaved(payload.mode === "correct" ? "Registro corrigido." : "Nova vigência gravada; a anterior termina na véspera.");
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a remuneração.");
    } finally { setBusy(false); }
  }

  return <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
    <header><div><span>INFOTIPO 0008</span><h3>{first ? "Salário de admissão" : "Nova vigência ou correção"}</h3></div></header>
    {error && <ErrorBanner title="A remuneração não foi salva" message={error} />}
    {saved && <p className={styles.infoNote}><Check aria-hidden="true" /><span><strong>Remuneração salva</strong><small>{saved}</small></span></p>}
    <div className={styles.formGrid}>
      <label><span>Início da vigência *</span>
        <input type="date" required value={validFrom} min={admissionDate} onChange={(event) => setValidFrom(event.target.value)} /></label>
      <label><span>Motivo *</span>
        <select value={reason} onChange={(event) => setReason(event.target.value as RemunerationReason)}>
          {(Object.keys(remunerationReasonLabels) as RemunerationReason[]).map((key) => <option key={key} value={key}>{remunerationReasonLabels[key]}</option>)}
        </select></label>
      <label><span>Tipo de salário</span>
        <select value={salaryKind} onChange={(event) => setSalaryKind(event.target.value as SalaryKind)}>
          {(Object.keys(salaryKindLabels) as SalaryKind[]).map((key) => <option key={key} value={key}>{salaryKindLabels[key]}</option>)}
        </select></label>
      <label><span>{salaryKind === "hourly" ? "Valor da hora (R$) *" : "Salário mensal (R$) *"}</span>
        <input required inputMode="decimal" value={amount} placeholder="3.500,00" onChange={(event) => setAmount(event.target.value)} /></label>
      <label><span>Horas mensais do contrato</span>
        <input type="number" min={1} max={744} value={monthlyHours} onChange={(event) => setMonthlyHours(event.target.value)} /></label>
      <label><span>Dependentes para o IRRF</span>
        <input type="number" min={0} max={30} value={irrfDependents} onChange={(event) => setIrrfDependents(event.target.value)} /></label>
      <label><span>Adicional</span>
        <select value={additional} onChange={(event) => setAdditional(event.target.value)}>
          <option value="0">Nenhum</option>
          <option value="10">Insalubridade grau mínimo (10%)</option>
          <option value="20">Insalubridade grau médio (20%)</option>
          <option value="40">Insalubridade grau máximo (40%)</option>
          <option value="hazardous">Periculosidade (30%)</option>
        </select></label>
      <label><span>Custo mensal do vale-transporte (R$)</span>
        <input inputMode="decimal" value={transportVoucher} placeholder="0,00" onChange={(event) => setTransportVoucher(event.target.value)} /></label>
      <label><span>Coparticipação do vale-refeição (R$)</span>
        <input inputMode="decimal" value={mealVoucherDiscount} placeholder="0,00" onChange={(event) => setMealVoucherDiscount(event.target.value)} /></label>
      {preview !== null && <p className={styles.infoNote}><Banknote aria-hidden="true" /><span>
        <strong>Salário mensal para o cálculo: {brl(preview)}</strong>
        <small>Mesma data de início de um registro existente corrige aquele registro; data nova abre outra vigência.</small></span></p>}
      <label className={styles.spanTwo}><span>Observações</span><textarea value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} /></label>
    </div>
    <footer><span /><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} /> : <Check />} Salvar remuneração</button></footer>
  </form>;
}
