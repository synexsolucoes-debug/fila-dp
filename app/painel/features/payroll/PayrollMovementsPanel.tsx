"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ClipboardPaste, Download, FileSpreadsheet, LoaderCircle, Plus, Trash2, Upload } from "lucide-react";
import type { Company } from "@/lib/fila-dp-types";
import { pastedMovementCells } from "@/lib/payroll-movements";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import styles from "./payroll.module.css";

/**
 * Movimentos para o Sankhya: lança os eventos variáveis da folha por
 * colaborador e gera a planilha do Importador de Movimentos.
 *
 * As regras (índice ou valor, SEQUENCIA, bloqueios) moram no servidor, em
 * `lib/payroll-movements.ts`. A tela só mostra o que ele devolve, envia o que a
 * pessoa digitou como texto e desenha a conferência linha a linha.
 */

type Unit = "V" | "H" | "D" | "Q";
type CatalogEvent = { code: number; description: string; unit: Unit; eventType: -1 | 0 | 1; active: boolean };
type Employee = { id: string; name: string; code: string; registrationNumber: string; employmentStatus: string; terminationDate: string | null };
type Check = { level: "block" | "warn"; message: string };
type Movement = {
  id: string; employeeId: string; employeeName: string; employeeCode: string; eventCode: number; eventDescription: string;
  unit: Unit | null; eventType: -1 | 0 | 1 | null; indexValue: number; amountCents: number; note: string; sequence: number;
  checks: Check[]; exportedAt: string | null; exportedByName: string | null; createdAt: string;
};
type Payload = {
  company: { id: string; name: string; code: string };
  /** Quem responde pela empresa na carteira do DP: confere e exporta. */
  responsible: { userId: string; name: string; via: "holder" | "backup" | null } | null;
  competence: string;
  catalog: { count: number; updatedAt: string | null };
  events: CatalogEvent[];
  employees: Employee[];
  movements: Movement[];
};
type Problem = { line?: number; employeeName?: string; message: string };

class RequestFailure extends Error {
  readonly problems: Problem[];
  constructor(message: string, problems: Problem[]) { super(message); this.problems = problems; }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; details?: { problems?: Problem[] } };
  if (!response.ok) throw new RequestFailure(payload.error || "Não foi possível concluir a operação.", payload.details?.problems ?? []);
  return payload;
}

const unitLabels: Record<Unit, string> = { V: "valor em R$", H: "horas no índice", D: "dias no índice", Q: "quantidade ou percentual no índice" };
const typeLabels: Record<string, { label: string; status: string }> = {
  "1": { label: "Provento", status: "active" },
  "-1": { label: "Desconto", status: "warning" },
  "0": { label: "Informativo", status: "submitted" },
};
const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const decimal = (value: number) => value ? value.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) : "–";
const leadingCode = (value: string) => value.trim().match(/^(\d+)/u)?.[1] ?? "";
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleDateString("pt-BR") : "";
const currentCompetence = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

export function PayrollMovementsPanel({ companies, canEdit }: { companies: Company[]; canEdit: boolean }) {
  const activeCompanies = useMemo(() => companies.filter((company) => company.status === "active"), [companies]);
  const [companyId, setCompanyId] = useState(activeCompanies[0]?.id ?? "");
  const [competence, setCompetence] = useState(currentCompetence);
  const [tipmov, setTipmov] = useState("A");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<Problem[]>([]);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ employee: "", event: "", index: "", amount: "" });
  const [paste, setPaste] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const employeeInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!companyId || !/^\d{4}-\d{2}$/u.test(competence)) return;
    try {
      setData(await requestJson<Payload>(`/api/payroll-movements?companyId=${encodeURIComponent(companyId)}&competence=${encodeURIComponent(competence)}`));
      setError("");
    } catch (cause) { setData(null); setError(cause instanceof Error ? cause.message : "Erro ao carregar os lançamentos."); }
  }, [companyId, competence]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const events = useMemo(() => new Map((data?.events ?? []).map((event) => [event.code, event])), [data]);
  const selectedEvent = events.get(Number(leadingCode(form.event))) ?? null;
  const activeEvents = (data?.events ?? []).filter((event) => event.active);
  const employees = (data?.employees ?? []).filter((employee) => employee.employmentStatus !== "terminated" || !employee.terminationDate || employee.terminationDate >= `${competence}-01`);

  const totals = useMemo(() => {
    const movements = data?.movements ?? [];
    return {
      count: movements.length,
      people: new Set(movements.map((movement) => movement.employeeId)).size,
      earnings: movements.filter((movement) => movement.eventType === 1).reduce((sum, movement) => sum + movement.amountCents, 0),
      deductions: movements.filter((movement) => movement.eventType === -1).reduce((sum, movement) => sum + movement.amountCents, 0),
      blocked: movements.filter((movement) => movement.checks.some((check) => check.level === "block")).length,
      warned: movements.filter((movement) => movement.checks.some((check) => check.level === "warn")).length,
      exported: movements.filter((movement) => movement.exportedAt).length,
      lastExport: movements.reduce<Movement | null>((last, movement) =>
        movement.exportedAt && (!last?.exportedAt || movement.exportedAt > last.exportedAt) ? movement : last, null),
    };
  }, [data]);

  function fail(cause: unknown, fallback: string) {
    setError(cause instanceof Error ? cause.message : fallback);
    setProblems(cause instanceof RequestFailure ? cause.problems : []);
  }

  async function save(entries: Array<Record<string, unknown>>, done: string) {
    setBusy(true); setFeedback(""); setProblems([]);
    try {
      const result = await requestJson<{ created: number }>("/api/payroll-movements", {
        method: "POST", body: JSON.stringify({ companyId, competence, entries }),
      });
      setError("");
      setFeedback(`${result.created} ${done}`);
      await load();
      return true;
    } catch (cause) { fail(cause, "Não foi possível lançar."); return false; }
    finally { setBusy(false); }
  }

  async function addOne(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const employeeCode = leadingCode(form.employee);
    const employee = (data?.employees ?? []).find((item) => item.code === employeeCode || item.id === form.employee);
    const saved = await save([{
      employeeId: employee?.id ?? "", employeeCode, eventCode: leadingCode(form.event), index: form.index, amount: form.amount,
    }], "lançamento gravado.");
    if (saved) { setForm({ employee: "", event: form.event, index: "", amount: "" }); employeeInput.current?.focus(); }
  }

  async function addPasted() {
    const entries: Array<Record<string, unknown>> = [];
    paste.split(/\r?\n/u).forEach((raw, position) => {
      const cells = pastedMovementCells(raw);
      if (cells) entries.push({ line: position + 1, ...cells });
    });
    if (!entries.length) { setError("Cole ao menos uma linha: CODFUNC, CODEVENTO, ÍNDICE, VALOR (ou CODEMP na frente)."); setProblems([]); return; }
    if (await save(entries, "lançamento(s) importado(s) da colagem.")) setPaste("");
  }

  async function remove(id: string) {
    setBusy(true); setFeedback("");
    try { await requestJson(`/api/payroll-movements/${encodeURIComponent(id)}`, { method: "DELETE" }); setError(""); await load(); }
    catch (cause) { fail(cause, "Não foi possível remover."); }
    finally { setBusy(false); }
  }

  async function importCatalog(file: File) {
    const body = new FormData();
    body.append("file", file);
    setBusy(true); setFeedback(""); setProblems([]);
    try {
      const result = await requestJson<{ events: number; created: number; updated: number; skipped: number }>("/api/payroll-movements/events", { method: "POST", body });
      setError("");
      setFeedback(`Catálogo atualizado: ${result.events} eventos (${result.created} novos, ${result.updated} alterados${result.skipped ? `, ${result.skipped} linhas ignoradas` : ""}).`);
      await load();
    } catch (cause) { fail(cause, "Não foi possível importar o catálogo."); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function exportFile(scope: "company" | "all") {
    setBusy(true); setFeedback(""); setProblems([]);
    try {
      const response = await fetch("/api/payroll-movements/export", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competence, tipmov, companyId: scope === "company" ? companyId : "" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; details?: { problems?: Problem[] } };
        throw new RequestFailure(payload.error || "Não foi possível gerar a planilha.", payload.details?.problems ?? []);
      }
      const blob = await response.blob();
      const name = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/u)?.[1] ?? `movimentos-sankhya-${competence}.xlsx`;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      setError("");
      setFeedback(`${response.headers.get("X-Fila-Dp-Rows") ?? ""} linha(s) exportada(s) em ${name}. Importe no Sankhya pela tela de importação de movimentos.`);
      await load();
    } catch (cause) { fail(cause, "Não foi possível gerar a planilha."); }
    finally { setBusy(false); }
  }

  if (!activeCompanies.length) {
    return <section className={styles.movements} aria-labelledby="payroll-movements-title">
      <h2 id="payroll-movements-title" className={styles.title}>Movimentos para o Sankhya</h2>
      <EmptyState icon={FileSpreadsheet} size="compact" title="Nenhuma empresa ativa" text="Cadastre a empresa com o Código Sankhya para lançar movimentos." />
    </section>;
  }

  return <section className={styles.movements} aria-labelledby="payroll-movements-title">
    <header className={styles.header}>
      <div>
        <h2 id="payroll-movements-title" className={styles.title}>Lançamentos variáveis da competência</h2>
        <p className={styles.lead}>Horas extras, comissões, descontos e outros eventos por colaborador. A planilha sai no layout do Importador de Movimentos, com TIPEVENTO e UNIDADE do catálogo.</p>
      </div>
      <div className={styles.scope}>
        <label>Empresa<select id="payroll-movements-company" value={companyId} disabled={busy} onChange={(event) => setCompanyId(event.target.value)}>
          {activeCompanies.map((company) => <option key={company.id} value={company.id}>{company.externalCode ? `${company.externalCode} · ` : ""}{company.tradeName || company.legalName}</option>)}
        </select></label>
        <label>Competência<input id="payroll-movements-competence" type="month" value={competence} disabled={busy} onChange={(event) => setCompetence(event.target.value)} /></label>
        <label className={styles.narrow}>TIPMOV<input id="payroll-movements-tipmov" value={tipmov} maxLength={2} disabled={busy} onChange={(event) => setTipmov(event.target.value.toUpperCase())} /></label>
      </div>
    </header>

    {error && <ErrorBanner title="Atenção" message={error} onDismiss={() => { setError(""); setProblems([]); }} />}
    {problems.length > 0 && <ul className={styles.problems} aria-label="O que impediu">
      {problems.map((problem, position) => <li key={`${problem.line ?? problem.employeeName ?? ""}-${position}`}>
        {problem.line ? <strong>Linha {problem.line}: </strong> : problem.employeeName ? <strong>{problem.employeeName}: </strong> : null}{problem.message}
      </li>)}
    </ul>}
    {feedback && <p className={styles.feedback} role="status">{feedback}</p>}

    {!data && !error ? <LoadingState size="compact" title="Carregando lançamentos" /> : data && <>
      <p className={styles.responsible}>{data.responsible
        ? <>Conferência e exportação: <strong>{data.responsible.name}</strong>{data.responsible.via === "backup" ? " (backup — titular ausente hoje)" : " (titular na carteira)"}</>
        : <>Sem responsável na carteira do DP para {data.company.name}. Defina o titular em Operação DP › Carteira.</>}</p>
      <div className={styles.catalogBar}>
        <span><FileSpreadsheet aria-hidden="true" /> Catálogo de eventos: <strong>{data.catalog.count}</strong>{data.catalog.updatedAt ? ` · atualizado em ${dateLabel(data.catalog.updatedAt)}` : ""}</span>
        {canEdit && <>
          <input ref={fileInput} id="payroll-movements-catalog-file" type="file" accept=".xlsx" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCatalog(file); }} />
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" /> Importar TFPEVE (.xlsx)</button>
        </>}
      </div>
      {data.catalog.count === 0 && <p className={styles.note}><AlertTriangle aria-hidden="true" /><span><strong>Importe o catálogo de eventos antes de lançar.</strong>
        <small>No Sankhya, exporte a query da TFPEVE (CODEVENTO, DESCREVENTO, UNIDADE, TIPEVENTO, ATIVO) e salve como .xlsx.</small></span></p>}
      {!data.company.code && <p className={styles.note}><AlertTriangle aria-hidden="true" /><span><strong>{data.company.name} está sem Código Sankhya.</strong>
        <small>Preencha o código (CODEMP) no cadastro da empresa: sem ele a planilha não é gerada.</small></span></p>}

      {canEdit && data.catalog.count > 0 && <form className={styles.entryForm} onSubmit={(event) => void addOne(event)}>
        <label className={styles.grow}>Colaborador<input ref={employeeInput} id="payroll-movements-employee" list="payroll-movements-employees" value={form.employee} disabled={busy}
          placeholder="Código ou nome" onChange={(event) => setForm({ ...form, employee: event.target.value })} /></label>
        <datalist id="payroll-movements-employees">{employees.map((employee) => <option key={employee.id} value={`${employee.code || employee.registrationNumber} · ${employee.name}`} />)}</datalist>
        <label className={styles.grow}>Evento<input id="payroll-movements-event" list="payroll-movements-events" value={form.event} disabled={busy}
          placeholder="Código ou descrição" onChange={(event) => setForm({ ...form, event: event.target.value })} /></label>
        <datalist id="payroll-movements-events">{activeEvents.map((event) => <option key={event.code} value={`${event.code} · ${event.description}`} />)}</datalist>
        <label>Índice<input id="payroll-movements-index" inputMode="decimal" value={form.index} disabled={busy} placeholder="0"
          className={selectedEvent && selectedEvent.unit !== "V" ? styles.expected : undefined} onChange={(event) => setForm({ ...form, index: event.target.value })} /></label>
        <label>Valor (R$)<input id="payroll-movements-amount" inputMode="decimal" value={form.amount} disabled={busy} placeholder="0,00"
          className={selectedEvent?.unit === "V" ? styles.expected : undefined} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
        <button type="submit" className={styles.primaryButton} disabled={busy || !form.employee || !form.event}>
          {busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Plus aria-hidden="true" />} Lançar</button>
        <p className={styles.hint}>{selectedEvent
          ? <>{typeLabels[String(selectedEvent.eventType)]?.label ?? "Evento"} · unidade <b>{selectedEvent.unit}</b>: {unitLabels[selectedEvent.unit]}.</>
          : "Horas, dias e quantidade vão no índice; evento de valor vai em R$. Horas aceitam 2:30."}</p>
      </form>}

      {canEdit && data.catalog.count > 0 && <details className={styles.paste}>
        <summary><ClipboardPaste aria-hidden="true" /> Colar vários lançamentos do Excel</summary>
        <p className={styles.hint}>Uma linha por lançamento: CODFUNC, CODEVENTO, ÍNDICE, VALOR (ou CODEMP na frente, da empresa selecionada), separados por tabulação ou ponto e vírgula. Com erro em alguma linha, nada é gravado.</p>
        <textarea id="payroll-movements-paste" rows={5} value={paste} disabled={busy} onChange={(event) => setPaste(event.target.value)} placeholder={"17\t9\t12:30\t0\n23\t37\t0\t312,50"} />
        <button type="button" className={styles.secondaryButton} disabled={busy || !paste.trim()} onClick={() => void addPasted()}>Importar linhas</button>
      </details>}

      <div className={styles.summary} aria-label="Resumo da competência">
        <article><small>Lançamentos</small><strong>{totals.count}</strong><span>{totals.lastExport?.exportedAt
          ? `${totals.exported} exportado(s) · última em ${dateLabel(totals.lastExport.exportedAt)}${totals.lastExport.exportedByName ? ` por ${totals.lastExport.exportedByName}` : ""}`
          : "nenhum exportado"}</span></article>
        <article><small>Colaboradores</small><strong>{totals.people}</strong><span>com movimento na competência</span></article>
        <article><small>Proventos em R$</small><strong>{money(totals.earnings)}</strong><span>eventos de valor</span></article>
        <article><small>Descontos em R$</small><strong>{money(totals.deductions)}</strong><span>eventos de valor</span></article>
        <article><small>Para conferir</small><strong>{totals.blocked + totals.warned}</strong><span>{totals.blocked} bloqueado(s) · {totals.warned} aviso(s)</span></article>
      </div>

      {data.movements.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <caption className="sr-only">Lançamentos da competência</caption>
        <thead><tr><th>Codfunc</th><th>Colaborador</th><th>Evento</th><th>Tipo</th><th className={styles.num}>Índice</th><th className={styles.num}>Valor</th><th className={styles.num}>Seq.</th><th>Conferência</th>{canEdit && <th />}</tr></thead>
        <tbody>{data.movements.map((movement) => <tr key={movement.id}>
          <td data-label="CODFUNC" className={styles.code}>{movement.employeeCode || "—"}</td>
          <td data-label="Colaborador">{movement.employeeName}</td>
          <td data-label="Evento"><span className={styles.code}>{movement.eventCode}</span> {movement.eventDescription || "fora do catálogo"}{movement.unit ? <small className={styles.unit}> · {movement.unit}</small> : null}</td>
          <td data-label="Tipo">{movement.eventType !== null ? <StatusPill status={typeLabels[String(movement.eventType)].status} label={typeLabels[String(movement.eventType)].label} /> : "—"}</td>
          <td data-label="Índice" className={styles.num}>{decimal(movement.indexValue)}</td>
          <td data-label="Valor" className={styles.num}>{movement.amountCents ? money(movement.amountCents) : "–"}</td>
          <td data-label="Seq." className={styles.num}>{movement.sequence}</td>
          <td data-label="Conferência"><span className={styles.checks}>
            {movement.checks.map((check) => <StatusPill key={check.message} status={check.level === "block" ? "blocked" : "warning"} label={check.message} />)}
            {movement.exportedAt && <StatusPill status="applied" label={`Exportado em ${dateLabel(movement.exportedAt)}${movement.exportedByName ? ` por ${movement.exportedByName}` : ""}`} />}
            {!movement.checks.length && !movement.exportedAt && <StatusPill status="active" label="OK" />}
          </span></td>
          {canEdit && <td><button type="button" className={styles.iconButton} disabled={busy} aria-label={`Remover lançamento de ${movement.employeeName}`} onClick={() => void remove(movement.id)}><Trash2 aria-hidden="true" /></button></td>}
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={FileSpreadsheet} size="compact" title="Nenhum lançamento nesta competência"
        text={canEdit ? "Lance pelo formulário acima ou cole as linhas do Excel." : "Os lançamentos aparecem aqui quando o DP registrar os movimentos."} />}

      {canEdit && <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} disabled={busy || !data.movements.length} onClick={() => void exportFile("company")}>
          <Download aria-hidden="true" /> Exportar {data.company.name}</button>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void exportFile("all")}>
          <Download aria-hidden="true" /> Exportar todas as empresas</button>
      </div>}
    </>}
  </section>;
}
