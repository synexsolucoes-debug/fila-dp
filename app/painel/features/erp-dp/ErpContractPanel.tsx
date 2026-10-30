"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Check, FileSignature, LoaderCircle, RefreshCw } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import { contractKindLabels, noticeDays, noticeEnd, noticeKindLabels, type ContractKind, type NoticeKind } from "@/lib/contract-terms-rules";
import styles from "./erp-record.module.css";

type Terms = {
  contractKind: ContractKind;
  experienceFirstEnd: string | null;
  contractEnd: string | null;
  noticeKind: NoticeKind | null;
  noticeStart: string | null;
  noticeDays: number | null;
  noticeEnd: string | null;
  notes: string;
};
type Deadline = { kind: string; date: string; label: string; action: string };
type Payload = { admissionDate: string; terms: Terms | null; deadlines: Deadline[] };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function dateLabel(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR").format(date);
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function deadlineTone(date: string) {
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return "critical";
  return date <= addDays(today, 15) ? "warning" : "active";
}

/**
 * A aba "Contrato" da Ficha funcional do ERP DP (passo 3 — IT0016 e
 * IT0019 do SAP HCM): tipo de contrato, fim da experiência ou do prazo
 * determinado e aviso prévio. Os dias do aviso são calculados pela Lei
 * 12.506/2011 enquanto a pessoa digita — e o servidor recalcula ao salvar,
 * para a tela nunca ser a fonte da regra.
 */
export function ErpContractPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await requestJson<Payload>(`/api/employees/${encodeURIComponent(employeeId)}/contract-terms`)); setError(""); }
    catch (cause) { setData(null); setError(cause instanceof Error ? cause.message : "Erro ao carregar o contrato."); }
    finally { setLoading(false); }
  }, [employeeId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (loading && !data) return <div className={styles.employeePanel}><LoadingState size="compact" title="Carregando o contrato" /></div>;
  if (error || !data) {
    return <div className={styles.employeePanel}>
      <ErrorBanner title="Não foi possível carregar o contrato" message={error} />
      <EmptyState icon={AlertTriangle} size="compact" title="Contrato indisponível" text="Isso pode ser falta de permissão ou uma falha momentânea."
        action={<button className={styles.secondaryButton} onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />
    </div>;
  }

  return <div className={styles.employeePanel}>
    <header className={styles.sectionTitle}><h3>Contrato e aviso prévio</h3><span>Admissão em {dateLabel(data.admissionDate)}</span></header>
    {data.deadlines.length > 0 ? <div className={styles.historySnapshot} aria-label="Prazos do contrato">
      {data.deadlines.map((deadline) => <article key={deadline.kind}>
        <small>{deadline.label}</small>
        <strong><StatusPill status={deadlineTone(deadline.date)} label={dateLabel(deadline.date)} /></strong>
        <span>{deadline.action}</span>
      </article>)}
    </div> : <EmptyState icon={CalendarClock} size="compact" title="Nenhum prazo contratual"
      text="Contrato por prazo indeterminado e sem aviso prévio em curso." />}
    {canManage
      ? <ContractEditor employeeId={employeeId} admissionDate={data.admissionDate} terms={data.terms} onSaved={load} />
      : data.terms && <p className={styles.infoNote}><FileSignature aria-hidden="true" /><span><strong>{contractKindLabels[data.terms.contractKind]}</strong>
        <small>{data.terms.noticeKind ? `${noticeKindLabels[data.terms.noticeKind]}: ${data.terms.noticeDays} dias, de ${dateLabel(data.terms.noticeStart)} a ${dateLabel(data.terms.noticeEnd)}.` : "Sem aviso prévio em curso."}</small></span></p>}
  </div>;
}

function ContractEditor({ employeeId, admissionDate, terms, onSaved }: { employeeId: string; admissionDate: string; terms: Terms | null; onSaved: () => Promise<void> }) {
  const [contractKind, setContractKind] = useState<ContractKind>(terms?.contractKind ?? "indefinite");
  const [experienceFirstEnd, setExperienceFirstEnd] = useState(terms?.experienceFirstEnd ?? "");
  const [contractEnd, setContractEnd] = useState(terms?.contractEnd ?? "");
  const [noticeKind, setNoticeKind] = useState<NoticeKind | "">(terms?.noticeKind ?? "");
  const [noticeStart, setNoticeStart] = useState(terms?.noticeStart ?? "");
  const [notes, setNotes] = useState(terms?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Prévia da Lei 12.506/2011 — a mesma função que o servidor usa.
  const preview = useMemo(() => {
    if (!noticeKind || !noticeStart || noticeStart < admissionDate) return null;
    const days = noticeDays(admissionDate, noticeStart);
    return { days, end: noticeEnd(noticeStart, days) };
  }, [admissionDate, noticeKind, noticeStart]);

  function suggestExperience(first: number, total: number) {
    setContractKind("experience");
    setExperienceFirstEnd(first < total ? addDays(admissionDate, first - 1) : "");
    setContractEnd(addDays(admissionDate, total - 1));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setSaved(false);
    try {
      await requestJson(`/api/employees/${encodeURIComponent(employeeId)}/contract-terms`, {
        method: "PUT",
        body: JSON.stringify({
          contractKind, experienceFirstEnd: experienceFirstEnd || null, contractEnd: contractEnd || null,
          noticeKind: noticeKind || null, noticeStart: noticeStart || null, notes,
        }),
      });
      setError(""); setSaved(true);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar o contrato.");
    } finally { setBusy(false); }
  }

  return <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
    <header><div><span>Elementos do contrato</span><h3>Tipo de contrato e aviso prévio</h3></div></header>
    {error && <ErrorBanner title="O contrato não foi salvo" message={error} />}
    {saved && <p className={styles.infoNote}><Check aria-hidden="true" /><span><strong>Contrato salvo</strong><small>Os prazos aparecem em Prazos contratuais, no menu do ERP.</small></span></p>}
    <div className={styles.formGrid}>
      <label><span>Tipo de contrato</span>
        <select value={contractKind} onChange={(event) => setContractKind(event.target.value as ContractKind)}>
          {(Object.keys(contractKindLabels) as ContractKind[]).map((kind) => <option key={kind} value={kind}>{contractKindLabels[kind]}</option>)}
        </select></label>
      {contractKind === "experience" && <div className={styles.spanTwo}>
        <span className={styles.fieldHint}>Atalhos (a partir da admissão):</span>{" "}
        <button type="button" className={styles.secondaryButton} onClick={() => suggestExperience(45, 90)}>45 + 45 dias</button>{" "}
        <button type="button" className={styles.secondaryButton} onClick={() => suggestExperience(30, 90)}>30 + 60 dias</button>{" "}
        <button type="button" className={styles.secondaryButton} onClick={() => suggestExperience(90, 90)}>90 dias</button>
      </div>}
      {contractKind === "experience" && <label><span>Fim do 1º período (se houver prorrogação)</span>
        <input type="date" value={experienceFirstEnd} min={admissionDate} onChange={(event) => setExperienceFirstEnd(event.target.value)} /></label>}
      {contractKind !== "indefinite" && <label><span>{contractKind === "experience" ? "Fim da experiência" : "Fim do prazo determinado"} *</span>
        <input type="date" required value={contractEnd} min={admissionDate} onChange={(event) => setContractEnd(event.target.value)} /></label>}
      <label><span>Aviso prévio</span>
        <select value={noticeKind} onChange={(event) => setNoticeKind(event.target.value as NoticeKind | "")}>
          <option value="">Sem aviso prévio em curso</option>
          {(Object.keys(noticeKindLabels) as NoticeKind[]).map((kind) => <option key={kind} value={kind}>{noticeKindLabels[kind]}</option>)}
        </select></label>
      {noticeKind && <label><span>Início do aviso *</span>
        <input type="date" required value={noticeStart} min={admissionDate} onChange={(event) => setNoticeStart(event.target.value)} /></label>}
      {preview && <p className={`${styles.infoNote} ${styles.spanTwo}`}><CalendarClock aria-hidden="true" /><span>
        <strong>{preview.days} dias de aviso — termina em {dateLabel(preview.end)}</strong>
        <small>Lei 12.506/2011: 30 dias, mais 3 por ano completo de serviço até o início do aviso, no máximo 90. O valor do aviso indenizado sai em Cálculos › Rescisão.</small></span></p>}
      <label className={styles.spanTwo}><span>Observações</span><textarea value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} /></label>
    </div>
    <footer><span /><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} /> : <Check />} Salvar contrato</button></footer>
  </form>;
}
