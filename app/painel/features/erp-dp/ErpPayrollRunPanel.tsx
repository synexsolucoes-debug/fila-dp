"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Calculator, ChevronDown, ChevronRight, Lock, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import { brl, type PayrollLine } from "@/lib/payroll-calc";
import styles from "./erp-record.module.css";

/**
 * Folha da competência do ERP DP — o PC00 do SAP: calcula a empresa inteira
 * com o que o Vinculato já registra (ponto aprovado, parcelas de Adiantamentos
 * e Descontos, vale-transporte, vale-refeição e diferença de retroativos),
 * grava o resultado de cada pessoa e fecha. Fechada, não muda mais.
 */

type CycleRow = {
  id: string; company_id: string; company_name: string; competence: string; status: string;
  run_id: string | null; run_status: string | null; employees_count: number | null; net_cents: number | null;
};
type Run = {
  id: string; competence: string; status: "calculated" | "closed"; calculationCount: number; employeesCount: number;
  earningsCents: number; deductionsCents: number; netCents: number; fgtsCents: number;
  skipped: Array<{ employeeId: string; name: string; registrationNumber: string; reason: string }>; calculatedAt: string; closedAt: string | null;
};
type Result = {
  id: string; employeeId: string; name: string; registrationNumber: string; salaryCents: number;
  earningsCents: number; deductionsCents: number; netCents: number; fgtsCents: number; lines: PayrollLine[]; notes: string[];
};
type Detail = { cycle: Record<string, unknown>; run: Run | null; results: Result[] };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

const cycleLabels: Record<string, string> = {
  open: "Aberta", pre_closing: "Pré-fechamento", processing: "Em processamento", post_closing: "Pós-fechamento", closed: "Encerrada",
};

export function ErpPayrollRunPanel({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const [cycles, setCycles] = useState<CycleRow[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CycleRow | null>(null);

  const loadCycles = useCallback(async () => {
    try {
      const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
      setCycles((await requestJson<{ cycles: CycleRow[] }>(`/api/erp-dp/payroll-runs${query}`)).cycles);
      setError("");
    } catch (cause) { setCycles([]); setError(cause instanceof Error ? cause.message : "Erro ao carregar as competências."); }
  }, [companyId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadCycles());
    return () => window.cancelAnimationFrame(frame);
  }, [loadCycles]);

  if (selected) return <RunDetail cycle={selected} canManage={canManage} onBack={() => { setSelected(null); void loadCycles(); }} />;

  return <div className={styles.employeePanel}>
    {error && <ErrorBanner title="Não foi possível carregar" message={error} />}
    {!cycles ? <LoadingState size="compact" title="Carregando competências" />
      : cycles.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <caption className="sr-only">Competências e folhas</caption>
        <thead><tr><th>Competência</th><th>Empresa</th><th>Competência no DP</th><th>Folha</th><th className={styles.num}>Líquido</th><th /></tr></thead>
        <tbody>{cycles.map((row) => <tr key={row.id}>
          <td data-label="Competência">{row.competence}</td>
          <td data-label="Empresa">{row.company_name}</td>
          <td data-label="Competência no DP"><StatusPill status={row.status} label={cycleLabels[row.status] ?? row.status} /></td>
          <td data-label="Folha">{row.run_status === "closed" ? <StatusPill status="active" label="Fechada" />
            : row.run_status ? <StatusPill status="warning" label={`Calculada · ${row.employees_count ?? 0} pessoas`} /> : "Não calculada"}</td>
          <td data-label="Líquido" className={styles.num}>{row.net_cents != null ? brl(Number(row.net_cents)) : ""}</td>
          <td><button type="button" className={styles.secondaryButton} onClick={() => setSelected(row)}>Abrir folha</button></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={Wallet} size="compact" title="Nenhuma competência"
        text="Abra a competência da empresa em Operação DP › Competências; a folha é calculada sobre ela." />}
  </div>;
}

function RunDetail({ cycle, canManage, onBack }: { cycle: CycleRow; canManage: boolean; onBack: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async () => {
    try { setData(await requestJson<Detail>(`/api/erp-dp/payroll-runs?cycleId=${encodeURIComponent(cycle.id)}`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar a folha."); }
  }, [cycle.id]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function calculate() {
    setBusy(true); setFeedback("");
    try {
      await requestJson("/api/erp-dp/payroll-runs", { method: "POST", body: JSON.stringify({ companyId: cycle.company_id, competence: cycle.competence }) });
      setFeedback("Folha calculada.");
      setError("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível calcular."); }
    finally { setBusy(false); }
  }

  async function close() {
    if (!data?.run) return;
    setBusy(true); setFeedback("");
    try {
      const payload = await requestJson<{ retroactivePosted: number }>(`/api/erp-dp/payroll-runs/${encodeURIComponent(data.run.id)}/close`, { method: "POST" });
      setFeedback(payload.retroactivePosted ? `Folha fechada. ${payload.retroactivePosted} retroativo(s) marcado(s) como lançado(s).` : "Folha fechada.");
      setConfirmClose(false);
      setError("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível fechar."); }
    finally { setBusy(false); }
  }

  const run = data?.run ?? null;
  const cycleClosed = String(data?.cycle.status ?? cycle.status) === "closed";
  const canCalculate = canManage && !cycleClosed && run?.status !== "closed";

  return <div className={styles.employeePanel}>
    <header className={styles.sectionTitle}><h3>Folha {cycle.competence} · {cycle.company_name}</h3>
      <button type="button" className={styles.secondaryButton} onClick={onBack}>Outra competência</button></header>
    {error && <ErrorBanner title="Atenção" message={error} />}
    {feedback && <p className={styles.infoNote}><Calculator aria-hidden="true" /><span><strong>{feedback}</strong>
      <small>As parcelas de Adiantamentos e Descontos continuam sendo confirmadas lá, depois do pagamento.</small></span></p>}
    {!data ? <LoadingState size="compact" title="Carregando a folha" /> : <>
      {run ? <div className={styles.historySnapshot} aria-label="Totais da folha">
        <article><small>Situação</small><strong>{run.status === "closed" ? "Fechada" : "Calculada"}</strong>
          <span>{run.calculationCount} cálculo(s){run.closedAt ? " · não muda mais" : ""}</span></article>
        <article><small>Pessoas</small><strong>{run.employeesCount}</strong><span>{run.skipped.length} fora da folha</span></article>
        <article><small>Proventos</small><strong>{brl(run.earningsCents)}</strong><span>Descontos {brl(run.deductionsCents)}</span></article>
        <article><small>Líquido</small><strong>{brl(run.netCents)}</strong><span>FGTS {brl(run.fgtsCents)}</span></article>
      </div> : <EmptyState icon={Calculator} size="compact" title="Folha ainda não calculada"
        text="O cálculo usa a remuneração vigente no fim do mês, o ponto aprovado, as parcelas de Adiantamentos e Descontos, VT, VR e as diferenças de retroativos abertos." />}
      <div className={styles.chips}>
        {canCalculate && <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void calculate()}>
          {busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : run ? <RefreshCw aria-hidden="true" /> : <Calculator aria-hidden="true" />}
          {run ? "Recalcular folha" : "Calcular folha"}</button>}
        {canManage && run?.status === "calculated" && !confirmClose && <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setConfirmClose(true)}>
          <Lock aria-hidden="true" /> Fechar folha</button>}
      </div>
      {confirmClose && <p className={styles.infoNote}><AlertTriangle aria-hidden="true" /><span>
        <strong>Fechar a folha {cycle.competence}?</strong>
        <small>O resultado não poderá mais ser recalculado. Mudanças depois disso entram como diferença retroativa numa próxima folha.</small>
        <span className={styles.chips}>
          <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void close()}>Confirmar fechamento</button>
          <button type="button" className={styles.secondaryButton} onClick={() => setConfirmClose(false)}>Cancelar</button>
        </span></span></p>}
      {cycleClosed && !run && <p className={styles.infoNote}><Lock aria-hidden="true" /><span><strong>Competência encerrada</strong>
        <small>Reabra em Operação DP › Competências para calcular a folha nela.</small></span></p>}
      {data.results.length > 0 && <div className={styles.tableWrap}><table className={styles.table}>
        <caption className="sr-only">Resultado por colaborador</caption>
        <thead><tr><th /><th>Matrícula</th><th>Colaborador</th><th className={styles.num}>Proventos</th><th className={styles.num}>Descontos</th><th className={styles.num}>Líquido</th></tr></thead>
        <tbody>{data.results.map((result) => <Fragment key={result.id}>
          <tr>
            <td><button type="button" className={styles.secondaryButton} aria-expanded={open === result.id}
              aria-label={`Rubricas de ${result.name}`} onClick={() => setOpen(open === result.id ? null : result.id)}>
              {open === result.id ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button></td>
            <td data-label="Matrícula">{result.registrationNumber}</td>
            <td data-label="Colaborador">{result.name}</td>
            <td data-label="Proventos" className={styles.num}>{brl(result.earningsCents)}</td>
            <td data-label="Descontos" className={styles.num}>{brl(result.deductionsCents)}</td>
            <td data-label="Líquido" className={styles.num}><strong>{brl(result.netCents)}</strong></td>
          </tr>
          {open === result.id && <tr><td colSpan={6}>
            <ul className={styles.notes}>
              {result.lines.filter((line) => line.kind !== "info").map((line) => <li key={line.code + line.label}>
                {line.code} · {line.label}{line.reference ? ` (${line.reference})` : ""}: {line.kind === "deduction" ? "−" : ""}{brl(line.amount)}</li>)}
              {result.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </td></tr>}
        </Fragment>)}</tbody>
      </table></div>}
      {run && run.skipped.length > 0 && <div className={styles.tableWrap}><table className={styles.table}>
        <caption className="sr-only">Fora da folha</caption>
        <thead><tr><th>Matrícula</th><th>Fora da folha</th><th>Motivo</th></tr></thead>
        <tbody>{run.skipped.map((item) => <tr key={item.employeeId}>
          <td data-label="Matrícula">{item.registrationNumber}</td><td data-label="Colaborador">{item.name}</td><td data-label="Motivo">{item.reason}</td>
        </tr>)}</tbody>
      </table></div>}
    </>}
  </div>;
}
