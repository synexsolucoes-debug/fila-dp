"use client";

import { FormEvent, useState } from "react";
import { Calculator, FileDown, LoaderCircle, Printer, Search, UserRound } from "lucide-react";
import { EmptyState, ErrorBanner } from "../shared";
import { brl, terminationKindLabels, terminationKinds, type PayrollLine, type TerminationKind } from "@/lib/payroll-calc";
import styles from "./erp-record.module.css";

/**
 * Cálculos do ERP DP — o lugar do PY do SAP (docs/engenharia-reversa-sap-hcm.md
 * §18): folha do mês, férias, 13º e rescisão de um colaborador, com o salário
 * vigente na data e as tabelas legais da data. É simulação: nada é gravado, e
 * o resultado mostra cada rubrica com a referência para quem confere.
 */

type CalcType = "monthly" | "vacation" | "thirteenth" | "termination";
const calcTypes: Array<{ id: CalcType; label: string }> = [
  { id: "monthly", label: "Folha do mês" },
  { id: "vacation", label: "Férias" },
  { id: "thirteenth", label: "13º salário" },
  { id: "termination", label: "Rescisão" },
];

type Employee = { id: string; name: string; registration: string; company: string };
type Result = {
  employee: { fullName: string; registrationNumber: string; admissionDate: string };
  salary: number;
  referenceDate: string;
  average?: { amount: number; months: number; source: "payroll" | "informed" };
  result: { lines: PayrollLine[]; earnings: number; deductions: number; net: number; fgts: number; notes: string[]; projectedEnd?: string };
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR").format(date);
}

export function ErpCalculationsPanel({ companyId }: { companyId: string }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Employee[] | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [type, setType] = useState<CalcType>("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [fields, setFields] = useState<Record<string, string | boolean>>({
    competence: today().slice(0, 7), start: today(), terminationDate: today(), year: today().slice(0, 4),
    kind: "without_cause", workingDays: "", restDays: "",
  });
  const field = (name: string) => String(fields[name] ?? "");
  const set = (name: string, value: string | boolean) => { setFields((current) => ({ ...current, [name]: value })); setResult(null); };

  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const params = new URLSearchParams({ search: query.trim(), limit: "20" });
      if (companyId) params.set("companyId", companyId);
      const payload = await requestJson<{ employees: Array<Record<string, unknown>> }>(`/api/employees?${params}`);
      setFound(payload.employees.map((row) => ({
        id: String(row.id), name: String(row.social_name || row.full_name || ""), registration: String(row.registration_number ?? ""), company: String(row.company_name ?? ""),
      })));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro na busca."); }
    finally { setBusy(false); }
  }

  async function calculate(event: FormEvent) {
    event.preventDefault();
    if (!employee) return;
    setBusy(true);
    try {
      setResult(await requestJson<Result>("/api/erp-dp/calculations", { method: "POST", body: JSON.stringify({ ...fields, type, employeeId: employee.id }) }));
      setError("");
    } catch (cause) { setResult(null); setError(cause instanceof Error ? cause.message : "Não foi possível calcular."); }
    finally { setBusy(false); }
  }

  const number = (name: string, label: string, hint?: string) => <label><span>{label}</span>
    <input type="number" min={0} step="any" value={field(name)} placeholder={hint} onChange={(event) => set(name, event.target.value)} /></label>;
  const money = (name: string, label: string) => <label><span>{label}</span>
    <input inputMode="decimal" value={field(name)} placeholder="0,00" onChange={(event) => set(name, event.target.value)} /></label>;
  const check = (name: string, label: string) => <label><span>{label}</span>
    <select value={fields[name] === true ? "yes" : "no"} onChange={(event) => set(name, event.target.value === "yes")}>
      <option value="no">Não</option><option value="yes">Sim</option></select></label>;

  return <div className={styles.employeePanel}>
    {!employee ? <>
      <form className={styles.formGrid} onSubmit={(event) => void search(event)} role="search">
        <label className={styles.spanTwo}><span>Colaborador (nome ou matrícula)</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex.: 000123 ou Maria" /></label>
        <div><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Search aria-hidden="true" />} Buscar</button></div>
      </form>
      {error && <ErrorBanner title="Não foi possível buscar" message={error} />}
      {found && (found.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <caption className="sr-only">Colaboradores encontrados</caption>
        <thead><tr><th>Matrícula</th><th>Nome</th><th>Empresa</th><th /></tr></thead>
        <tbody>{found.map((row) => <tr key={row.id}>
          <td data-label="Matrícula">{row.registration}</td><td data-label="Nome">{row.name}</td><td data-label="Empresa">{row.company}</td>
          <td><button type="button" className={styles.secondaryButton} onClick={() => { setEmployee(row); setResult(null); setError(""); }}>Calcular</button></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={UserRound} size="compact" title="Ninguém encontrado" text="Confira a matrícula ou o nome, e a empresa selecionada no topo." />)}
      {!found && <EmptyState icon={Calculator} size="compact" title="Escolha um colaborador"
        text="O cálculo usa o salário cadastrado na aba Remuneração da Ficha funcional, vigente na data do cálculo, e as tabelas de INSS e IRRF daquela data." />}
    </> : <>
      <header className={styles.sectionTitle}><h3>{employee.registration} · {employee.name}</h3>
        <button type="button" className={styles.secondaryButton} onClick={() => { setEmployee(null); setResult(null); }}>Outra pessoa</button></header>
      <div className={styles.chips} role="group" aria-label="Tipo de cálculo">
        {calcTypes.map((item) => <button key={item.id} type="button" className={styles.secondaryButton} aria-pressed={type === item.id}
          onClick={() => { setType(item.id); setResult(null); }}>{item.label}</button>)}
      </div>
      <form className={styles.requirementEditor} onSubmit={(event) => void calculate(event)}>
        <div className={styles.formGrid}>
          {type === "monthly" && <>
            <label><span>Competência *</span><input type="month" required value={field("competence")} onChange={(event) => set("competence", event.target.value)} /></label>
            {number("absenceDays", "Faltas (dias)")}
            {number("overtime50Hours", "Horas extras 50%")}
            {number("overtime100Hours", "Horas extras 100%")}
            {number("workingDays", "Dias úteis do mês", "para o DSR")}
            {number("restDays", "Domingos e feriados do mês", "para o DSR")}
            {money("otherEarnings", "Outros proventos (R$)")}
            {money("otherDeductions", "Outros descontos (R$)")}
            {money("alimony", "Pensão alimentícia (R$)")}
          </>}
          {type === "vacation" && <>
            <label><span>Início do gozo *</span><input type="date" required value={field("start")} onChange={(event) => set("start", event.target.value)} /></label>
            {number("absences", "Faltas injustificadas no período aquisitivo", "define os dias (art. 130)")}
            {number("soldDays", "Dias vendidos (abono)", "até 1/3")}
            {money("variableAverage", "Média de variáveis (R$) — vazio calcula das folhas fechadas")}
          </>}
          {type === "thirteenth" && <>
            {number("year", "Ano *")}
            {money("firstInstallmentPaid", "1ª parcela já paga (R$)")}
            {money("variableAverage", "Média de variáveis (R$) — vazio calcula das folhas fechadas")}
          </>}
          {type === "termination" && <>
            <label className={styles.spanTwo}><span>Tipo de desligamento *</span>
              <select value={field("kind")} onChange={(event) => set("kind", event.target.value as TerminationKind)}>
                {terminationKinds.map((kind) => <option key={kind} value={kind}>{terminationKindLabels[kind]}</option>)}
              </select></label>
            <label><span>Último dia trabalhado *</span><input type="date" required value={field("terminationDate")} onChange={(event) => set("terminationDate", event.target.value)} /></label>
            {(field("kind") === "without_cause" || field("kind") === "agreement") && check("noticeWorked", "Aviso prévio trabalhado")}
            {field("kind") === "resignation" && check("discountUnworkedNotice", "Descontar aviso não cumprido")}
            {field("kind") === "fixed_term_early" && <label><span>Fim previsto do contrato</span>
              <input type="date" value={field("contractEnd")} onChange={(event) => set("contractEnd", event.target.value)} /></label>}
            {number("overdueVacationPeriods", "Períodos de férias vencidas")}
            {money("fgtsBalance", "Saldo do FGTS (R$)")}
            {money("thirteenthAdvance", "13º já adiantado no ano (R$)")}
            {money("variableAverage", "Média de variáveis (R$) — vazio calcula das folhas fechadas")}
          </>}
        </div>
        <footer><span /><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Calculator aria-hidden="true" />} Calcular</button></footer>
      </form>
      {error && <ErrorBanner title="Não foi possível calcular" message={error} />}
      {result && <ResultView result={result} document={type === "vacation" || type === "termination"
        ? () => downloadDocument({ ...fields, type, employeeId: employee.id }) : null} />}
    </>}
  </div>;
}

/** O PDF refaz a conta no servidor com o mesmo corpo: o documento nunca diverge da tela. */
async function downloadDocument(body: Record<string, unknown>) {
  const response = await fetch("/api/erp-dp/calculations/document", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Não foi possível gerar o documento.");
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/u.exec(disposition)?.[1] ?? "documento.pdf";
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

function ResultView({ result, document: makeDocument }: { result: Result; document: (() => Promise<void>) | null }) {
  const [documentError, setDocumentError] = useState("");
  const [documentBusy, setDocumentBusy] = useState(false);
  const { lines, earnings, deductions, net, fgts, notes, projectedEnd } = result.result;
  const payroll = lines.filter((line) => line.kind !== "info");
  const info = lines.filter((line) => line.kind === "info");
  return <section className={styles.stackPrint} aria-label="Resultado do cálculo">
    <div className={styles.historySnapshot}>
      <article><small>Proventos</small><strong>{brl(earnings)}</strong><span>Salário-base {brl(result.salary)}</span></article>
      <article><small>Descontos</small><strong>{brl(deductions)}</strong><span>INSS, IRRF e outros</span></article>
      <article><small>Líquido</small><strong>{brl(net)}</strong><span>Data de referência {dateLabel(result.referenceDate)}</span></article>
      <article><small>FGTS (empregador)</small><strong>{brl(fgts)}</strong><span>{projectedEnd ? `Contrato projetado até ${dateLabel(projectedEnd)}` : "8% da base"}</span></article>
    </div>
    <div className={styles.tableWrap}><table className={styles.table}>
      <caption className="sr-only">Rubricas do cálculo</caption>
      <thead><tr><th>Código</th><th>Rubrica</th><th>Referência</th><th className={styles.num}>Proventos</th><th className={styles.num}>Descontos</th></tr></thead>
      <tbody>
        {payroll.map((line) => <tr key={line.code}>
          <td data-label="Código">{line.code}</td>
          <td data-label="Rubrica">{line.label}</td>
          <td data-label="Referência">{line.reference ?? ""}</td>
          <td data-label="Proventos" className={styles.num}>{line.kind === "earning" ? brl(line.amount) : ""}</td>
          <td data-label="Descontos" className={styles.num}>{line.kind === "deduction" ? brl(line.amount) : ""}</td>
        </tr>)}
        <tr className={styles.totalsRow}><td /><td>Totais</td><td>Líquido {brl(net)}</td>
          <td data-label="Proventos" className={styles.num}>{brl(earnings)}</td><td data-label="Descontos" className={styles.num}>{brl(deductions)}</td></tr>
      </tbody>
    </table></div>
    {info.length > 0 && <div className={styles.historySnapshot} aria-label="Bases e informações">
      {info.map((line) => <article key={line.code}><small>{line.label}</small><strong>{brl(line.amount)}</strong><span>{line.reference ?? ""}</span></article>)}
    </div>}
    {result.average?.source === "payroll" && <p className={styles.infoNote}><Calculator aria-hidden="true" /><span>
      <strong>Média de variáveis automática: {brl(result.average.amount)}</strong>
      <small>{result.average.months
        ? `Horas extras, DSR e adicional noturno das ${result.average.months} folhas fechadas nos 12 meses anteriores. Informe a média no campo para substituir.`
        : "Nenhuma folha fechada nos 12 meses anteriores: a média ficou zero. Informe no campo, se houver variáveis pagas fora do ERP."}</small></span></p>}
    {notes.length > 0 && <ul className={styles.notes}>{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    {documentError && <ErrorBanner title="Documento não gerado" message={documentError} />}
    <div className={styles.chips}>
      {makeDocument && <button type="button" className={styles.primaryButton} disabled={documentBusy} onClick={() => {
        setDocumentBusy(true); setDocumentError("");
        makeDocument().catch((cause) => setDocumentError(cause instanceof Error ? cause.message : "Erro ao gerar.")).finally(() => setDocumentBusy(false));
      }}>{documentBusy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <FileDown aria-hidden="true" />} Gerar documento (PDF)</button>}
      <button type="button" className={styles.secondaryButton} onClick={() => window.print()}><Printer aria-hidden="true" /> Imprimir</button>
    </div>
  </section>;
}
