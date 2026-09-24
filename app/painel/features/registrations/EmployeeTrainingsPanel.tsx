"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, GraduationCap, LoaderCircle, Plus, RefreshCw, XCircle } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import styles from "./registrations.module.css";

type TrainingRecord = {
  id: string;
  trainingName: string;
  completedOn: string;
  validUntil: string | null;
  providerName: string;
  certificateNumber: string;
  notes: string;
};

type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);
const nullableText = (value: unknown) => { const result = text(value); return result || null; };

function normalizeTraining(row: Row): TrainingRecord {
  return {
    id: text(row.id), trainingName: text(row.trainingName), completedOn: text(row.completedOn),
    validUntil: nullableText(row.validUntil), providerName: text(row.providerName),
    certificateNumber: text(row.certificateNumber), notes: text(row.notes),
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

/** A mesma régua de `epi_ca_expiry`: vencido, vencendo em 60 dias, ou no prazo. */
function validityTone(validUntil: string | null) {
  if (!validUntil) return "neutral";
  const today = new Date().toISOString().slice(0, 10);
  if (validUntil < today) return "danger";
  const limit = new Date(new Date(today).getTime() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return validUntil <= limit ? "warning" : "active";
}

/**
 * A aba de treinamentos obrigatórios (NR) dentro do cadastro do colaborador.
 *
 * Mesmo desenho de `EmployeeExamsPanel`: o produto não fecha o vocabulário do
 * treinamento (NR-35, NR-33, brigada de incêndio variam por cliente), então o
 * nome é texto livre — só a validade é estruturada, porque é ela que responde
 * "está em dia?".
 */
export function EmployeeTrainingsPanel({ employeeId, companyId, canManage }: { employeeId: string; companyId: string; canManage: boolean }) {
  const [trainings, setTrainings] = useState<TrainingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<{ trainings?: Row[] }>(`/api/trainings?employeeId=${encodeURIComponent(employeeId)}`);
      setTrainings((payload.trainings ?? []).map(normalizeTraining));
      setError("");
    } catch (cause) {
      setTrainings([]);
      setError(cause instanceof Error ? cause.message : "Erro ao carregar os treinamentos.");
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (loading) {
    return <div className={styles.employeePanel}><LoadingState size="compact" title="Carregando treinamentos" text="Buscando o histórico de treinamentos obrigatórios do colaborador…" /></div>;
  }
  if (error) {
    return <div className={styles.employeePanel}>
      <ErrorBanner title="Não foi possível carregar os treinamentos" message={error} />
      <EmptyState icon={AlertTriangle} size="compact" title="Treinamentos indisponíveis"
        text="Isso pode ser falta de permissão para o módulo, ou uma falha momentânea."
        action={<button className={styles.secondaryButton} onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />
    </div>;
  }

  return <div className={styles.employeePanel}>
    <header className={styles.sectionTitle}><h3>Treinamentos obrigatórios (NR)</h3><span>{trainings.length} registro(s)</span></header>
    {canManage && (creating
      ? <TrainingEditor employeeId={employeeId} companyId={companyId} onCancel={() => setCreating(false)}
          onSaved={async () => { setCreating(false); await load(); }} />
      : <button className={styles.secondaryButton} onClick={() => setCreating(true)}><Plus aria-hidden="true" /> Registrar treinamento</button>)}
    {trainings.length ? <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr><th>Treinamento</th><th>Conclusão</th><th>Validade</th><th>Certificado/entidade</th></tr></thead>
        <tbody>{trainings.map((item) => <tr key={item.id}>
          <td data-label="Treinamento">{item.trainingName}</td>
          <td data-label="Conclusão">{dateLabel(item.completedOn)}</td>
          <td data-label="Validade">{item.validUntil
            ? <StatusPill status={validityTone(item.validUntil)} label={dateLabel(item.validUntil)} />
            : <span>Sem vencimento</span>}</td>
          <td data-label="Certificado/entidade">{[item.providerName, item.certificateNumber].filter(Boolean).join(" · ") || "—"}</td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={GraduationCap} size="compact" title="Nenhum treinamento registrado para este colaborador"
      text="Registre o treinamento de NR concluído para acompanhar o vencimento da validade." />}
  </div>;
}

function TrainingEditor({ employeeId, companyId, onCancel, onSaved }: {
  employeeId: string; companyId: string; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const [trainingName, setTrainingName] = useState("");
  const [completedOn, setCompletedOn] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [providerName, setProviderName] = useState("");
  const [certificateNumber, setCertificateNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await requestJson("/api/trainings", {
        method: "POST",
        body: JSON.stringify({
          companyId, employeeId, trainingName, completedOn,
          validUntil: validUntil || null, providerName, certificateNumber, notes,
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível registrar o treinamento.");
    } finally {
      setBusy(false);
    }
  }

  return <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
    <header><div><span>NOVO TREINAMENTO</span><h3>Registrar treinamento obrigatório</h3></div>
      <button type="button" className={styles.closeButton} onClick={onCancel} aria-label="Cancelar"><XCircle aria-hidden="true" /></button></header>
    {error && <ErrorBanner title="Não foi possível registrar o treinamento" message={error} />}
    <div className={styles.formGrid}>
      <label className={styles.spanTwo}><span>Treinamento *</span>
        <input required value={trainingName} onChange={(event) => setTrainingName(event.target.value)} placeholder="Ex.: NR-35 — Trabalho em altura" /></label>
      <label><span>Conclusão *</span><input required type="date" value={completedOn} onChange={(event) => setCompletedOn(event.target.value)} /></label>
      <label><span>Validade</span><input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} placeholder="Deixe em branco se não vencer" /></label>
      <label><span>Entidade/instrutor</span><input value={providerName} onChange={(event) => setProviderName(event.target.value)} /></label>
      <label><span>Certificado</span><input value={certificateNumber} onChange={(event) => setCertificateNumber(event.target.value)} /></label>
      <label className={styles.spanTwo}><span>Observações</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    </div>
    <footer><span /><button type="button" className={styles.secondaryButton} onClick={onCancel}>Cancelar</button>
      <button className={styles.primaryButton} disabled={busy || !trainingName || !completedOn}>{busy ? <LoaderCircle className={styles.spin} /> : <Check />} Salvar treinamento</button></footer>
  </form>;
}
