"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, PencilLine, RefreshCw } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState } from "../shared";
import styles from "./erp-record.module.css";

type Option = { id: string; name: string; status: string };
type Catalogs = Record<"departments" | "positions" | "cost-centers" | "work-schedules" | "establishments", Option[]>;
type Values = { departmentId: string; positionId: string; costCenterId: string; workScheduleId: string; establishmentId: string };

const catalogKeys = ["departments", "positions", "cost-centers", "work-schedules", "establishments"] as const;
const fields: Array<{ key: keyof Values; catalog: keyof Catalogs; label: string }> = [
  { key: "establishmentId", catalog: "establishments", label: "Unidade" },
  { key: "departmentId", catalog: "departments", label: "Departamento" },
  { key: "positionId", catalog: "positions", label: "Cargo" },
  { key: "costCenterId", catalog: "cost-centers", label: "Centro de custo" },
  { key: "workScheduleId", catalog: "work-schedules", label: "Jornada" },
];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

const text = (value: unknown) => value == null ? "" : String(value);

/**
 * ERP DP — corrigir o registro (o "modificar" do PA30 do SAP).
 *
 * Erro de digitação na lotação ou na jornada não é uma mudança na vida
 * funcional de ninguém: corrigir conserta o registro vigente do histórico e o
 * cadastro, sem abrir período novo. Mudança de verdade, com data, é medida
 * (transferência na Operação DP, executada em Medidas).
 */
export function ErpCorrectionPanel({ employeeId, onSaved }: { employeeId: string; onSaved: () => void }) {
  const [companyId, setCompanyId] = useState("");
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [initial, setInitial] = useState<Values | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { employee } = await requestJson<{ employee: Record<string, unknown> }>(`/api/employees/${encodeURIComponent(employeeId)}`);
      const company = text(employee.company_id);
      const lists = await Promise.all(catalogKeys.map((key) =>
        requestJson<{ items: Option[] }>(`/api/registrations/catalogs/${key}?companyId=${encodeURIComponent(company)}`).then((payload) => payload.items)));
      const current: Values = {
        departmentId: text(employee.department_id), positionId: text(employee.position_id), costCenterId: text(employee.cost_center_id),
        workScheduleId: text(employee.work_schedule_id), establishmentId: text(employee.establishment_id),
      };
      setCompanyId(company);
      setCatalogs(Object.fromEntries(catalogKeys.map((key, index) => [key, lists[index]])) as Catalogs);
      setInitial(current);
      setValues(current);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao carregar o registro.");
    } finally { setLoading(false); }
  }, [employeeId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!values || !initial) return;
    // Só o que mudou vai para o servidor: o resto do cadastro não é tocado.
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial[key as keyof Values]));
    if (!Object.keys(changed).length) { setError("Nada foi alterado."); return; }
    setBusy(true); setSaved(false);
    try {
      await requestJson(`/api/employees/${encodeURIComponent(employeeId)}`, {
        method: "PATCH", body: JSON.stringify({ ...changed, companyId, historyMode: "correction" }),
      });
      setError(""); setSaved(true);
      await load();
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível corrigir o registro.");
    } finally { setBusy(false); }
  }

  if (loading && !values) return <div className={styles.employeePanel}><LoadingState size="compact" title="Carregando o registro" /></div>;
  if (!values || !catalogs) {
    return <div className={styles.employeePanel}>
      <ErrorBanner title="Não foi possível carregar o registro" message={error} />
      <EmptyState icon={AlertTriangle} size="compact" title="Registro indisponível" text="Isso pode ser falta de permissão ou uma falha momentânea."
        action={<button className={styles.secondaryButton} onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />
    </div>;
  }

  return <form className={`${styles.employeePanel} ${styles.requirementEditor}`} onSubmit={(event) => void submit(event)}>
    <header><div><span>CORRIGIR REGISTRO</span><h3>Lotação e jornada vigentes</h3></div></header>
    <p className={styles.infoNote}><PencilLine aria-hidden="true" /><span><strong>Correção, não mudança</strong>
      <small>Conserta o registro vigente do histórico e o cadastro, sem abrir período novo — para erro de digitação. Mudança com data (transferência, troca de jornada) é uma medida.</small></span></p>
    {error && <ErrorBanner title="A correção não foi gravada" message={error} />}
    {saved && <p className={styles.infoNote}><Check aria-hidden="true" /><span><strong>Registro corrigido</strong><small>O histórico continua com os mesmos períodos.</small></span></p>}
    <div className={styles.formGrid}>
      {fields.map((field) => <label key={field.key}><span>{field.label}</span>
        <select value={values[field.key]} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}>
          <option value="">Não informado</option>
          {catalogs[field.catalog].filter((item) => item.status === "active" || item.id === values[field.key])
            .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>)}
    </div>
    <footer><span /><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} /> : <Check />} Corrigir registro</button></footer>
  </form>;
}
