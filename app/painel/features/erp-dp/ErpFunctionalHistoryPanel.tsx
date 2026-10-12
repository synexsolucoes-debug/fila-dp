"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, Info, RefreshCw } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import styles from "./erp-record.module.css";

type RecordType = "situation" | "assignment" | "schedule";

type HistoryRecord = {
  id: string;
  recordType: RecordType;
  validFrom: string;
  validTo: string;
  reason: string;
  movementId: string | null;
  employmentStatus: string | null;
  companyName: string | null;
  establishmentName: string | null;
  departmentName: string | null;
  positionName: string | null;
  costCenterName: string | null;
  workScheduleName: string | null;
};

type Divergence = { recordType: RecordType; field: string };

type Payload = {
  at: string;
  today: string;
  records: HistoryRecord[];
  snapshot: Record<RecordType, HistoryRecord | null>;
  divergences: Divergence[];
  gaps: string[];
};

const HIGH_DATE = "9999-12-31";

const typeLabels: Record<RecordType, string> = { situation: "Situação do vínculo", assignment: "Lotação", schedule: "Jornada" };
const reasonLabels: Record<string, string> = {
  baseline: "Situação na implantação do histórico",
  leave: "Afastamento",
  return_to_work: "Retorno de afastamento",
  termination: "Desligamento",
  transfer: "Transferência",
  registration_edit: "Alteração no cadastro",
  integration_sync: "Sincronização com a origem (Sankhya)",
};
const statusLabels: Record<string, string> = { active: "Ativo", on_leave: "Afastado", terminated: "Desligado" };
const fieldLabels: Record<string, string> = {
  employmentStatus: "situação", companyId: "empresa", establishmentId: "unidade", departmentId: "departamento",
  positionId: "cargo", costCenterId: "centro de custo", workScheduleId: "jornada",
};

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function dateLabel(value: string) {
  if (value === HIGH_DATE) return "em aberto";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function describe(record: HistoryRecord) {
  if (record.recordType === "situation") return <StatusPill status={record.employmentStatus ?? ""} label={statusLabels[record.employmentStatus ?? ""] ?? "—"} />;
  if (record.recordType === "schedule") return record.workScheduleName || "Sem jornada";
  return [record.companyName, record.establishmentName, record.departmentName, record.positionName, record.costCenterName]
    .filter(Boolean).join(" · ") || "Sem lotação";
}

/**
 * A aba "Vida funcional" da Ficha funcional do ERP DP (§4.27).
 *
 * Desenho tirado do PA20 do SAP HCM: a ficha lida numa data-base, e abaixo a
 * linha do tempo de cada tipo de registro com início e fim de validade. Só
 * leitura — o histórico é escrito pelas mudanças de vínculo, nunca à mão.
 */
export function ErpFunctionalHistoryPanel({ employeeId }: { employeeId: string }) {
  const [at, setAt] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = at ? `?at=${encodeURIComponent(at)}` : "";
      setData(await requestJson<Payload>(`/api/employees/${encodeURIComponent(employeeId)}/functional-history${query}`));
      setError("");
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Erro ao carregar o histórico funcional.");
    } finally {
      setLoading(false);
    }
  }, [employeeId, at]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (loading && !data) {
    return <div className={styles.employeePanel}><LoadingState size="compact" title="Carregando histórico funcional" text="Montando a linha do tempo do vínculo…" /></div>;
  }
  if (error || !data) {
    return <div className={styles.employeePanel}>
      <ErrorBanner title="Não foi possível carregar o histórico funcional" message={error} />
      <EmptyState icon={AlertTriangle} size="compact" title="Histórico funcional indisponível"
        text="Isso pode ser falta de permissão para o cadastro, ou uma falha momentânea."
        action={<button className={styles.secondaryButton} onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />
    </div>;
  }

  const types: RecordType[] = ["situation", "assignment", "schedule"];
  return <div className={styles.employeePanel}>
    <header className={styles.sectionTitle}><h3>Vida funcional</h3><span>{data.records.length} registro(s) com validade</span></header>
    <label className={styles.historyDate}><span>Data-base</span>
      <input type="date" value={at || data.at} onChange={(event) => setAt(event.target.value)} /></label>

    <div className={styles.historySnapshot} aria-label={`Situação em ${dateLabel(data.at)}`}>
      {types.map((type) => {
        const record = data.snapshot[type];
        return <article key={type}><small>{typeLabels[type]} em {dateLabel(data.at)}</small>
          <strong>{record ? describe(record) : "Sem registro nesta data"}</strong>
          {record && <span>desde {dateLabel(record.validFrom)}</span>}</article>;
      })}
    </div>

    {data.divergences.length > 0 && <div className={styles.infoNote}><AlertTriangle aria-hidden="true" /><span>
      <strong>O cadastro de hoje difere do histórico vigente hoje</strong>
      <small>Campos: {[...new Set(data.divergences.map((item) => fieldLabels[item.field] ?? item.field))].join(", ")}. Acontece quando
        uma movimentação foi aplicada com data futura (o cadastro já mudou, a validade ainda não começou) ou quando o
        cadastro foi alterado por importação, fora das rotas que registram histórico.</small></span></div>}
    {data.gaps.length > 0 && <ErrorBanner title="Linha do tempo com intervalo inconsistente" message={data.gaps.join("; ")} />}

    {data.records.length ? <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr><th>Tipo</th><th>Vigência</th><th>Registro</th><th>Motivo</th></tr></thead>
        <tbody>{data.records.map((record) => <tr key={record.id}>
          <td data-label="Tipo">{typeLabels[record.recordType]}</td>
          <td data-label="Vigência">{dateLabel(record.validFrom)} – {dateLabel(record.validTo)}</td>
          <td data-label="Registro">{describe(record)}</td>
          <td data-label="Motivo">{reasonLabels[record.reason] ?? record.reason}</td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={CalendarClock} size="compact" title="Nenhuma mudança de vínculo registrada ainda"
      text="O histórico começa na primeira mudança aplicada a este colaborador: afastamento, desligamento, transferência ou alteração de lotação e jornada no cadastro." />}

    <div className={styles.infoNote}><Info aria-hidden="true" /><span><strong>Como ler</strong>
      <small>Cada mudança fecha o registro anterior na véspera e abre um novo — nada é apagado. O registro
        &quot;Situação na implantação do histórico&quot; é o cadastro como estava antes da primeira mudança registrada;
        o que aconteceu antes dele não foi registrado.</small></span></div>
  </div>;
}
