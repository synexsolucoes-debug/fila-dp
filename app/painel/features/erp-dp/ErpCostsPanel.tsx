"use client";

import { useCallback, useEffect, useState } from "react";
import { FileDown, PiggyBank } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState } from "../shared";
import { brl } from "@/lib/payroll-calc";
import type { CostGroup, EmployeeCost } from "@/lib/payroll-costs";
import styles from "./erp-record.module.css";

/**
 * Custo de pessoal do ERP DP (§4.42): o que a folha custa à empresa além do
 * salário, por pessoa, centro de custo e departamento, e a evolução das folhas
 * fechadas.
 */

type Payload = {
  competence: string | null; competences: string[]; costs: EmployeeCost[];
  byCostCenter: CostGroup[]; byDepartment: CostGroup[];
  totals: { earnings: number; charges: number; provisions: number; benefits: number; total: number } | null;
  evolution: Array<{ competence: string; earnings: number; net: number; fgts: number; people: number }>;
};

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Não foi possível carregar.");
  return payload;
}

export function ErpCostsPanel({ companyId }: { companyId: string }) {
  const [competence, setCompetence] = useState("");
  const [groupBy, setGroupBy] = useState<"costCenter" | "department">("costCenter");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");

  const query = new URLSearchParams();
  if (companyId) query.set("companyId", companyId);
  if (competence) query.set("competence", competence);
  const url = `/api/erp-dp/costs?${query}`;

  const load = useCallback(async () => {
    try { setData(await requestJson<Payload>(url)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar."); }
  }, [url]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (error) return <ErrorBanner title="Custos indisponíveis" message={error} />;
  if (!data) return <LoadingState size="compact" title="Calculando custos" />;
  if (!data.competence || !data.totals) {
    return <EmptyState icon={PiggyBank} size="compact" title="Nenhuma folha calculada" text="Calcule a folha da competência em Folha para ver o custo de pessoal." />;
  }
  const groups = groupBy === "costCenter" ? data.byCostCenter : data.byDepartment;
  const peak = Math.max(1, ...data.evolution.map((row) => row.earnings));
  const csv = `${url}&format=csv`;

  return <div className={styles.employeePanel}>
    <div className={styles.chips}>
      <label className={styles.fieldHint}>Competência{" "}
        <select value={data.competence} onChange={(event) => setCompetence(event.target.value)}>
          {data.competences.map((item) => <option key={item} value={item}>{item}</option>)}
        </select></label>
      <a className={styles.secondaryButton} href={csv} download><FileDown aria-hidden="true" /> Planilha por pessoa (CSV)</a>
    </div>
    <div className={styles.historySnapshot} aria-label="Custo total">
      <article><small>Custo total</small><strong>{brl(data.totals.total)}</strong><span>{data.costs.length} pessoa(s)</span></article>
      <article><small>Proventos</small><strong>{brl(data.totals.earnings)}</strong><span>Sem o salário-família</span></article>
      <article><small>Encargos e FGTS</small><strong>{brl(data.totals.charges)}</strong><span>Patronal, FGTS e encargos das provisões</span></article>
      <article><small>Provisões</small><strong>{brl(data.totals.provisions)}</strong><span>Férias + 1/3 e 13º do mês</span></article>
    </div>
    <div className={styles.chips} role="group" aria-label="Agrupar por">
      <button type="button" className={styles.secondaryButton} aria-pressed={groupBy === "costCenter"} onClick={() => setGroupBy("costCenter")}>Por centro de custo</button>
      <button type="button" className={styles.secondaryButton} aria-pressed={groupBy === "department"} onClick={() => setGroupBy("department")}>Por departamento</button>
    </div>
    <div className={styles.tableWrap}><table className={styles.table}>
      <caption className="sr-only">Custo agrupado</caption>
      <thead><tr><th>{groupBy === "costCenter" ? "Centro de custo" : "Departamento"}</th><th className={styles.num}>Pessoas</th>
        <th className={styles.num}>Proventos</th><th className={styles.num}>Encargos</th><th className={styles.num}>Provisões</th><th className={styles.num}>Custo total</th></tr></thead>
      <tbody>{groups.map((group) => <tr key={group.key}>
        <td data-label="Grupo">{group.key}</td>
        <td data-label="Pessoas" className={styles.num}>{group.people}</td>
        <td data-label="Proventos" className={styles.num}>{brl(group.earnings)}</td>
        <td data-label="Encargos" className={styles.num}>{brl(group.charges)}</td>
        <td data-label="Provisões" className={styles.num}>{brl(group.provisions)}</td>
        <td data-label="Custo total" className={styles.num}><strong>{brl(group.total)}</strong></td>
      </tr>)}</tbody>
    </table></div>
    {data.evolution.length > 0 && <section aria-labelledby="evolution-title" className={styles.stackPrint}>
      <h3 id="evolution-title" className={styles.fieldHint}>Evolução das folhas fechadas (proventos)</h3>
      <ul className={styles.bars}>{data.evolution.map((row) => <li key={row.competence}>
        <span>{row.competence}</span>
        <span className={styles.barTrack}><span className={styles.barFill} style={{ width: `${Math.round((row.earnings / peak) * 100)}%` }} /></span>
        <strong>{brl(row.earnings)}</strong>
      </li>)}</ul>
    </section>}
    <div className={styles.tableWrap}><table className={styles.table}>
      <caption className="sr-only">Custo por pessoa</caption>
      <thead><tr><th>Colaborador</th><th className={styles.num}>Proventos</th><th className={styles.num}>Patronal</th><th className={styles.num}>FGTS</th>
        <th className={styles.num}>Provisões</th><th className={styles.num}>VT empresa</th><th className={styles.num}>Custo</th></tr></thead>
      <tbody>{data.costs.map((cost) => <tr key={cost.employeeId}>
        <td data-label="Colaborador">{cost.registrationNumber} · {cost.name}</td>
        <td data-label="Proventos" className={styles.num}>{brl(cost.earnings)}</td>
        <td data-label="Patronal" className={styles.num}>{brl(cost.employerContribution)}</td>
        <td data-label="FGTS" className={styles.num}>{brl(cost.fgts)}</td>
        <td data-label="Provisões" className={styles.num}>{brl(cost.vacationProvision + cost.thirteenthProvision + cost.provisionCharges)}</td>
        <td data-label="VT empresa" className={styles.num}>{brl(cost.transportVoucher)}</td>
        <td data-label="Custo" className={styles.num}><strong>{brl(cost.total)}</strong></td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}
