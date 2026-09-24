"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, ClipboardCheck, LoaderCircle, Plus, RefreshCw, XCircle } from "lucide-react";
import { examResultLabels, examTypeLabels, type ExamResult, type ExamType } from "@/lib/occupational-exams";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import styles from "./registrations.module.css";

type ExamRecord = {
  id: string;
  examType: ExamType;
  examDate: string;
  result: ExamResult;
  restrictionNotes: string;
  nextDueDate: string | null;
  clinicName: string;
  doctorName: string;
  notes: string;
};

type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);
const nullableText = (value: unknown) => { const result = text(value); return result || null; };

function normalizeExam(row: Row): ExamRecord {
  return {
    id: text(row.id), examType: text(row.examType) as ExamType, examDate: text(row.examDate),
    result: text(row.result) as ExamResult, restrictionNotes: text(row.restrictionNotes),
    nextDueDate: nullableText(row.nextDueDate), clinicName: text(row.clinicName),
    doctorName: text(row.doctorName), notes: text(row.notes),
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, cache: "no-store", headers });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function dateLabel(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function resultTone(result: ExamResult) {
  if (result === "unfit") return "danger";
  if (result === "fit_with_restriction") return "warning";
  return "active";
}

/**
 * A aba de exames ocupacionais (ASO) dentro do cadastro do colaborador.
 *
 * Diferente do Controle de EPI, o ASO ainda não tem um módulo próprio: a
 * ficha do colaborador é hoje a única tela do produto, e por isso ela lista
 * e registra no mesmo lugar — quando (e se) o módulo crescer para uma tela
 * própria, esta continua sendo a mesma fonte de leitura.
 */
export function EmployeeExamsPanel({ employeeId, companyId, canManage }: { employeeId: string; companyId: string; canManage: boolean }) {
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<{ exams?: Row[] }>(`/api/occupational-exams?employeeId=${encodeURIComponent(employeeId)}`);
      setExams((payload.exams ?? []).map(normalizeExam));
      setError("");
    } catch (cause) {
      setExams([]);
      setError(cause instanceof Error ? cause.message : "Erro ao carregar os exames ocupacionais.");
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (loading) {
    return <div className={styles.employeePanel}><LoadingState size="compact" title="Carregando exames" text="Buscando o histórico de ASO do colaborador…" /></div>;
  }
  if (error) {
    return <div className={styles.employeePanel}>
      <ErrorBanner title="Não foi possível carregar os exames" message={error} />
      <EmptyState icon={AlertTriangle} size="compact" title="Exames indisponíveis"
        text="Isso pode ser falta de permissão para o módulo, ou uma falha momentânea."
        action={<button className={styles.secondaryButton} onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />
    </div>;
  }

  return <div className={styles.employeePanel}>
    <header className={styles.sectionTitle}><h3>Exames ocupacionais (ASO)</h3><span>{exams.length} registro(s)</span></header>
    {canManage && (creating
      ? <ExamEditor employeeId={employeeId} companyId={companyId} onCancel={() => setCreating(false)}
          onSaved={async () => { setCreating(false); await load(); }} />
      : <button className={styles.secondaryButton} onClick={() => setCreating(true)}><Plus aria-hidden="true" /> Registrar exame</button>)}
    {exams.length ? <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr><th>Tipo</th><th>Data</th><th>Resultado</th><th>Próximo vencimento</th><th>Clínica/médico</th></tr></thead>
        <tbody>{exams.map((item) => <tr key={item.id}>
          <td data-label="Tipo">{examTypeLabels[item.examType]}</td>
          <td data-label="Data">{dateLabel(item.examDate)}</td>
          <td data-label="Resultado"><StatusPill status={resultTone(item.result)} label={examResultLabels[item.result]} />
            {item.restrictionNotes && <small>{item.restrictionNotes}</small>}</td>
          <td data-label="Próximo vencimento">{dateLabel(item.nextDueDate)}</td>
          <td data-label="Clínica/médico">{[item.clinicName, item.doctorName].filter(Boolean).join(" · ") || "—"}</td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={ClipboardCheck} size="compact" title="Nenhum exame registrado para este colaborador"
      text="Registre o exame admissional, periódico ou de retorno ao trabalho para acompanhar o vencimento." />}
  </div>;
}

function ExamEditor({ employeeId, companyId, onCancel, onSaved }: {
  employeeId: string; companyId: string; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const [examType, setExamType] = useState<ExamType>("periodic");
  const [examDate, setExamDate] = useState("");
  const [result, setResult] = useState<ExamResult>("fit");
  const [restrictionNotes, setRestrictionNotes] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [clinicName, setClinicName] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await requestJson("/api/occupational-exams", {
        method: "POST",
        body: JSON.stringify({
          companyId, employeeId, examType, examDate, result,
          restrictionNotes: result === "fit_with_restriction" ? restrictionNotes : "",
          nextDueDate: nextDueDate || null, clinicName, doctorName, notes,
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível registrar o exame.");
    } finally {
      setBusy(false);
    }
  }

  return <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
    <header><div><span>NOVO EXAME</span><h3>Registrar exame ocupacional</h3></div>
      <button type="button" className={styles.closeButton} onClick={onCancel} aria-label="Cancelar"><XCircle aria-hidden="true" /></button></header>
    {error && <ErrorBanner title="Não foi possível registrar o exame" message={error} />}
    <div className={styles.formGrid}>
      <label><span>Tipo *</span><select required value={examType} onChange={(event) => setExamType(event.target.value as ExamType)}>
        {(Object.keys(examTypeLabels) as ExamType[]).map((key) => <option key={key} value={key}>{examTypeLabels[key]}</option>)}
      </select></label>
      <label><span>Data do exame *</span><input required type="date" value={examDate} onChange={(event) => setExamDate(event.target.value)} /></label>
      <label><span>Resultado *</span><select required value={result} onChange={(event) => setResult(event.target.value as ExamResult)}>
        {(Object.keys(examResultLabels) as ExamResult[]).map((key) => <option key={key} value={key}>{examResultLabels[key]}</option>)}
      </select></label>
      <label><span>Próximo vencimento</span><input type="date" value={nextDueDate} onChange={(event) => setNextDueDate(event.target.value)} /></label>
      {result === "fit_with_restriction" && <label className={styles.spanTwo}>
        <span>Restrição funcional</span>
        <input value={restrictionNotes} onChange={(event) => setRestrictionNotes(event.target.value)} placeholder="Ex.: não pode carregar peso acima de 10kg" />
      </label>}
      <label><span>Clínica</span><input value={clinicName} onChange={(event) => setClinicName(event.target.value)} /></label>
      <label><span>Médico(a)</span><input value={doctorName} onChange={(event) => setDoctorName(event.target.value)} /></label>
      <label className={styles.spanTwo}><span>Observações</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    </div>
    <footer><span /><button type="button" className={styles.secondaryButton} onClick={onCancel}>Cancelar</button>
      <button className={styles.primaryButton} disabled={busy || !examDate}>{busy ? <LoaderCircle className={styles.spin} /> : <Check />} Salvar exame</button></footer>
  </form>;
}
