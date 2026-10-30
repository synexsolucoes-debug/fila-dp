"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BookOpen, Calculator, CalendarClock, CalendarRange, Check, ClipboardCheck, Download, FileClock, FileSignature, History, Upload, Undo2,
  LayoutDashboard, LoaderCircle, Play, RefreshCw, Search, ShieldCheck, UserRound, Users, Wallet, Palmtree, PiggyBank,
} from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import { ErpFunctionalHistoryPanel } from "./ErpFunctionalHistoryPanel";
import { ErpContractPanel } from "./ErpContractPanel";
import { ErpCorrectionPanel } from "./ErpCorrectionPanel";
import { ErpRemunerationPanel } from "./ErpRemunerationPanel";
import { ErpCalculationsPanel } from "./ErpCalculationsPanel";
import { ErpPayrollRunPanel } from "./ErpPayrollRunPanel";
import { ErpVacationsPanel } from "./ErpVacationsPanel";
import { ErpCostsPanel } from "./ErpCostsPanel";
import { parseReceiptSheet } from "@/lib/esocial-receipts";
import styles from "./erp-dp.module.css";

/**
 * Modo ERP DP — o Vinculato lido com a gramática do SAP HCM.
 *
 * Não é um segundo produto: são as mesmas tabelas, as mesmas permissões e as
 * mesmas rotas, organizadas pelas perguntas que um DP que vem de ERP faz
 * (docs/engenharia-reversa-sap-hcm.md): a ficha numa data-base (PA20), as
 * medidas esperando execução (PA40), o quadro num dia-chave, os retroativos
 * (0003), o calendário de competências (PA03), os eventos do eSocial que as
 * mudanças do mês exigem, a remuneração com vigência (0008) e o cálculo de
 * folha, férias, 13º e rescisão (PY). Não transmite eSocial.
 */

type Section = "overview" | "record" | "actions" | "vacations" | "payroll" | "costs" | "calculations" | "contracts" | "headcount" | "retro" | "cycles" | "esocial" | "about";
type Row = Record<string, unknown>;

const sections: Array<{ id: Section; label: string; sap: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Painel do DP", sap: "Início", icon: LayoutDashboard },
  { id: "record", label: "Ficha funcional", sap: "PA20 / PA30", icon: UserRound },
  { id: "actions", label: "Medidas", sap: "PA40", icon: Play },
  { id: "vacations", label: "Férias", sap: "IT2006 · cotas", icon: Palmtree },
  { id: "payroll", label: "Folha", sap: "PC00 · folha mensal", icon: Wallet },
  { id: "costs", label: "Custos", sap: "Custo de pessoal · provisões", icon: PiggyBank },
  { id: "calculations", label: "Cálculos", sap: "PY · simulação", icon: Calculator },
  { id: "contracts", label: "Prazos contratuais", sap: "IT0016 / IT0019", icon: FileSignature },
  { id: "headcount", label: "Quadro em data-base", sap: "Dia-chave", icon: Users },
  { id: "retro", label: "Retroativos", sap: "IT0003", icon: FileClock },
  { id: "cycles", label: "Competências", sap: "PA03", icon: CalendarRange },
  { id: "esocial", label: "eSocial esperado", sap: "S-2206 · S-2230 · S-2299", icon: ClipboardCheck },
  { id: "about", label: "Sobre o modo ERP", sap: "Ajuda", icon: BookOpen },
];

const movementLabels: Record<string, string> = {
  salary_change: "Alteração salarial", vacation: "Férias", leave: "Afastamento", return_to_work: "Retorno de afastamento",
  termination: "Desligamento", transfer: "Transferência", benefit_change: "Benefício", registration_sync: "Conciliação cadastral",
  epi_discount: "Desconto de EPI", other: "Outra",
};
const statusLabels: Record<string, string> = { active: "Ativo", on_leave: "Afastado", terminated: "Desligado" };
const cycleLabels: Record<string, string> = {
  open: "Aberta", pre_closing: "Pré-fechamento", processing: "Em processamento", post_closing: "Pós-fechamento", closed: "Encerrada",
};
const cycleSap: Record<string, string> = {
  open: "Liberada para folha (entrada)", pre_closing: "Liberada para folha (conferência)", processing: "Folha em cálculo",
  post_closing: "Verificar resultados", closed: "Encerrar folha",
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

const text = (value: unknown) => value == null ? "" : String(value);
function dateLabel(value: unknown) {
  const raw = text(value).slice(0, 10);
  if (!raw) return "—";
  const date = new Date(`${raw}T12:00:00`);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("pt-BR").format(date);
}
function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}
function scopeQuery(companyId: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (companyId) params.set("companyId", companyId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Carregamento com estado de erro e recarga, o mesmo contrato em todas as seções. */
function useResource<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try { setData(await requestJson<T>(url)); setError(""); }
    catch (cause) { setData(null); setError(cause instanceof Error ? cause.message : "Erro ao carregar."); }
    finally { setLoading(false); }
  }, [url]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);
  return { data, loading, error, reload: load };
}

function SectionState({ loading, error, reload, title }: { loading: boolean; error: string; reload: () => void; title: string }) {
  if (loading) return <LoadingState size="compact" title={title} />;
  if (error) return <div className={styles.stack}>
    <ErrorBanner title="Não foi possível carregar" message={error} />
    <button className={styles.secondary} onClick={reload}><RefreshCw aria-hidden="true" /> Tentar novamente</button>
  </div>;
  return null;
}

export function ErpDpView({
  companyId, scopeLabel, canManageMovements, canManageEmployees, canReadMovements, canReadCycles, canCheckEsocial, canReadPayroll, canManagePayroll, onExit,
}: {
  companyId: string;
  scopeLabel: string;
  canManageMovements: boolean;
  /** Contrato e correção de registro — `employees.manage`. */
  canManageEmployees: boolean;
  /** Retroativos — `movements.read`. */
  canReadMovements: boolean;
  /** Gravar a conferência do eSocial — `obligations.manage`. */
  canCheckEsocial: boolean;
  canReadCycles: boolean;
  /** Ver salário e calcular — `payroll.read`. */
  canReadPayroll: boolean;
  /** Gravar a remuneração — `payroll.manage`. */
  canManagePayroll: boolean;
  onExit: () => void;
}) {
  const [section, setSection] = useState<Section>("overview");
  /* A ficha pode ser aberta de outra tela do ERP já na aba certa — Prazos
     contratuais abre o contrato da pessoa, sem sair do ERP. */
  const [recordTarget, setRecordTarget] = useState<{ employeeId: string; tab: RecordTab } | null>(null);
  const openRecord = (employeeId: string, tab: RecordTab) => { setRecordTarget({ employeeId, tab }); setSection("record"); };
  const visible = sections.filter((item) => (item.id !== "retro" || canReadMovements) && (item.id !== "cycles" || canReadCycles)
    && ((item.id !== "calculations" && item.id !== "payroll" && item.id !== "costs") || canReadPayroll));
  const current = sections.find((item) => item.id === section) ?? sections[0];

  return <div className={styles.shell}>
    <nav className={styles.menu} aria-label="Menu do ERP DP">
      <header><span>ERP DP</span><small>{scopeLabel}</small></header>
      <ul>{visible.map((item) => {
        const Icon = item.icon;
        return <li key={item.id}><button type="button" className={section === item.id ? styles.menuActive : ""}
          aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}>
          <Icon aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.sap}</small></span>
        </button></li>;
      })}</ul>
      <button type="button" className={styles.exit} onClick={onExit}>Voltar ao Vinculato</button>
    </nav>
    <section className={styles.work} aria-labelledby="erp-section-title">
      <header className={styles.workHeader}>
        <div><span>{current.sap}</span><h1 id="erp-section-title">{current.label}</h1></div>
      </header>
      {section === "overview" && <OverviewSection companyId={companyId} onGo={setSection} />}
      {section === "record" && <RecordSection key={recordTarget ? `${recordTarget.employeeId}-${recordTarget.tab}` : "search"}
        companyId={companyId} target={recordTarget} canManage={canManageEmployees} canReadPayroll={canReadPayroll} canManagePayroll={canManagePayroll} />}
      {section === "actions" && <ActionsSection companyId={companyId} canManage={canManageMovements} />}
      {section === "vacations" && <ErpVacationsPanel companyId={companyId} canManage={canManageEmployees} />}
      {section === "payroll" && canReadPayroll && <ErpPayrollRunPanel companyId={companyId} canManage={canManagePayroll} />}
      {section === "costs" && canReadPayroll && <ErpCostsPanel companyId={companyId} />}
      {section === "calculations" && canReadPayroll && <ErpCalculationsPanel companyId={companyId} />}
      {section === "contracts" && <ContractsSection companyId={companyId} onOpen={(employeeId) => openRecord(employeeId, "contract")} />}
      {section === "headcount" && <HeadcountSection companyId={companyId} />}
      {section === "retro" && <RetroSection companyId={companyId} canManage={canManageMovements} />}
      {section === "cycles" && <CyclesSection companyId={companyId} />}
      {section === "esocial" && <EsocialSection companyId={companyId} canCheck={canCheckEsocial} />}
      {section === "about" && <AboutSection />}
    </section>
  </div>;
}

/* -------------------------------------------------------------------------- */

function OverviewSection({ companyId, onGo }: { companyId: string; onGo: (section: Section) => void }) {
  const { data, loading, error, reload } = useResource<{ active: number; onLeave: number; terminated: number; approvedMovements: number; openRetroactive: number; contractDeadlines: number; cycles: Row[] }>(`/api/erp-dp/overview${scopeQuery(companyId)}`);
  if (loading || error || !data) return <SectionState loading={loading} error={error} reload={() => void reload()} title="Montando o painel do DP" />;
  const openCycles = data.cycles.filter((cycle) => text(cycle.status) !== "closed");
  const tiles: Array<{ label: string; value: number; hint: string; go: Section; tone?: "warn" }> = [
    { label: "Ativos hoje", value: data.active, hint: "Quadro em data-base", go: "headcount" },
    { label: "Afastados hoje", value: data.onLeave, hint: "Quadro em data-base", go: "headcount" },
    { label: "Medidas aguardando execução", value: data.approvedMovements, hint: "Aprovadas, ainda não aplicadas", go: "actions", tone: data.approvedMovements ? "warn" : undefined },
    { label: "Retroativos abertos", value: data.openRetroactive, hint: "Diferença a lançar na folha", go: "retro", tone: data.openRetroactive ? "warn" : undefined },
    { label: "Prazos contratuais", value: data.contractDeadlines, hint: "Vencidos ou nos próximos 15 dias", go: "contracts", tone: data.contractDeadlines ? "warn" : undefined },
    { label: "Competências em andamento", value: openCycles.length, hint: "Calendário de folha", go: "cycles" },
  ];
  return <div className={styles.stack}>
    <div className={styles.tiles}>{tiles.map((tile) => <button key={tile.label} type="button" className={tile.tone === "warn" ? styles.tileWarn : styles.tile} onClick={() => onGo(tile.go)}>
      <small>{tile.label}</small><strong>{tile.value}</strong><span>{tile.hint}</span>
    </button>)}</div>
    <div className={styles.note}><ShieldCheck aria-hidden="true" /><p>
      O modo ERP lê os mesmos dados do Vinculato, com o vocabulário do SAP HCM: cada dado do vínculo tem data de validade,
      cada mudança é uma medida, e todo relatório pode ser lido numa data-base. A remuneração fica na Ficha funcional e a folha, as
      férias, o 13º e a rescisão são calculados em Cálculos; a transmissão do eSocial continua no sistema que tem o certificado.
    </p></div>
  </div>;
}

/* -------------------------------------------------------------------------- */

type RecordTab = "functional" | "contract" | "remuneration" | "correction";
const recordTabs: Array<{ id: RecordTab; label: string; sap: string }> = [
  { id: "functional", label: "Vida funcional", sap: "IT0000 · IT0001 · IT0007" },
  { id: "contract", label: "Contrato", sap: "IT0016 · IT0019" },
  { id: "remuneration", label: "Remuneração", sap: "IT0008" },
  { id: "correction", label: "Corrigir registro", sap: "PA30 · modificar" },
];

function RecordSection({ companyId, target, canManage, canReadPayroll, canManagePayroll }: {
  companyId: string; target: { employeeId: string; tab: RecordTab } | null; canManage: boolean; canReadPayroll: boolean; canManagePayroll: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Row[] | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [tab, setTab] = useState<RecordTab>(target?.tab ?? "functional");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Aberta por outra tela do ERP: carrega a pessoa direto, sem busca.
  useEffect(() => {
    if (!target) return;
    let active = true;
    void requestJson<{ employee: Row }>(`/api/employees/${encodeURIComponent(target.employeeId)}`)
      .then((payload) => { if (active) setSelected(payload.employee); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Colaborador não encontrado."); });
    return () => { active = false; };
  }, [target]);

  async function search(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    try {
      const payload = await requestJson<{ employees: Row[] }>(`/api/employees${scopeQuery(companyId, { search: query.trim(), limit: "30" })}`);
      setResults(payload.employees);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro na busca.");
    } finally { setBusy(false); }
  }

  const visibleTabs = recordTabs.filter((item) => (item.id !== "correction" || canManage) && (item.id !== "remuneration" || canReadPayroll));

  return <div className={styles.stack}>
    {!selected && <form className={styles.toolbar} onSubmit={(event) => void search(event)} role="search">
      <label className={styles.grow}><span>Colaborador (nome ou matrícula)</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex.: 000123 ou Maria" /></label>
      <button className={styles.primary} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Search aria-hidden="true" />} Exibir</button>
    </form>}
    {error && <ErrorBanner title="Não foi possível abrir a ficha" message={error} />}
    {results && !selected && (results.length ? <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th>Matrícula</th><th>Nome</th><th>Empresa</th><th>Situação</th><th /></tr></thead>
      <tbody>{results.map((row) => <tr key={text(row.id)}>
        <td data-label="Matrícula">{text(row.registration_number)}</td>
        <td data-label="Nome">{text(row.social_name) || text(row.full_name)}</td>
        <td data-label="Empresa">{text(row.company_name)}</td>
        <td data-label="Situação"><StatusPill status={text(row.employment_status)} label={statusLabels[text(row.employment_status)] ?? "—"} /></td>
        <td><button type="button" className={styles.secondary} onClick={() => setSelected(row)}>Abrir ficha</button></td>
      </tr>)}</tbody>
    </table></div> : <EmptyState icon={UserRound} size="compact" title="Ninguém encontrado" text="Confira a matrícula ou o nome, e a empresa selecionada no topo." />)}
    {!results && !selected && !target && <EmptyState icon={UserRound} size="compact" title="Informe um colaborador"
      text="A ficha funcional mostra a pessoa numa data-base, o contrato com os prazos e a correção do registro vigente." />}
    {selected && <div className={styles.stack}>
      <div className={styles.recordHead}>
        <div><small>MATRÍCULA {text(selected.registration_number)} · {text(selected.company_name)}</small>
          <h2>{text(selected.social_name) || text(selected.full_name)}</h2>
          <span>Admissão {dateLabel(selected.admission_date)} · {text(selected.position_name) || "Sem cargo"} · {text(selected.department_name) || "Sem departamento"}</span></div>
        <div className={styles.actionsRow}>
          <button type="button" className={styles.secondary} onClick={() => { setSelected(null); setResults(null); }}>Outra pessoa</button>
        </div>
      </div>
      <div className={styles.recordTabs} role="tablist" aria-label="Ficha funcional">
        {visibleTabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
          className={tab === item.id ? styles.recordTabActive : ""} onClick={() => setTab(item.id)}>
          <strong>{item.label}</strong><small>{item.sap}</small></button>)}
      </div>
      <div role="tabpanel">
        {tab === "functional" && <ErpFunctionalHistoryPanel key={version} employeeId={text(selected.id)} />}
        {tab === "contract" && <ErpContractPanel employeeId={text(selected.id)} canManage={canManage} />}
        {tab === "remuneration" && canReadPayroll && <ErpRemunerationPanel employeeId={text(selected.id)} canManage={canManagePayroll} />}
        {tab === "correction" && canManage && <ErpCorrectionPanel employeeId={text(selected.id)} onSaved={() => setVersion((value) => value + 1)} />}
      </div>
    </div>}
  </div>;
}

/* -------------------------------------------------------------------------- */

function ActionsSection({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const approved = useResource<{ movements: Row[] }>(`/api/operations/movements${scopeQuery(companyId, { status: "approved", limit: "100" })}`);
  const [running, setRunning] = useState("");
  // Cada medida executada pode mudar quem está afastado: o formulário de
  // retorno recarrega a lista a cada execução.
  const [executions, setExecutions] = useState(0);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function execute(row: Row) {
    setRunning(text(row.id));
    try {
      const result = await requestJson<{ retroactive: { competence: string } | null }>(`/api/operations/movements/${encodeURIComponent(text(row.id))}/apply`, { method: "POST", body: "{}" });
      setFeedback({
        tone: "ok",
        text: result.retroactive
          ? `Medida executada. Ela vale a partir de ${result.retroactive.competence}, competência já processada: abrimos um retroativo para o DP lançar a diferença na folha.`
          : "Medida executada. O cadastro e o histórico funcional foram atualizados na mesma transação.",
      });
      setExecutions((value) => value + 1);
      await approved.reload();
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : "Não foi possível executar a medida." });
    } finally { setRunning(""); }
  }

  return <div className={styles.stack}>
    {canManage && <ReturnToWorkAction key={executions} companyId={companyId} onDone={(message) => setFeedback({ tone: "ok", text: message })} />}
    <p className={styles.lead}>Medidas aprovadas que ainda não mudaram o cadastro. Executar grava a mudança com a data de vigência,
      delimita o histórico e, se a data cair numa competência já processada, abre o retroativo.</p>
    {feedback && (feedback.tone === "ok"
      ? <div className={styles.note}><ShieldCheck aria-hidden="true" /><p>{feedback.text}</p></div>
      : <ErrorBanner title="A medida não foi executada" message={feedback.text} />)}
    {approved.loading || approved.error || !approved.data
      ? <SectionState loading={approved.loading} error={approved.error} reload={() => void approved.reload()} title="Carregando medidas aprovadas" />
      : approved.data.movements.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Medida</th><th>Colaborador</th><th>Vigência</th><th>Título</th><th /></tr></thead>
        <tbody>{approved.data.movements.map((row) => <tr key={text(row.id)}>
          <td data-label="Medida">{movementLabels[text(row.movement_type)] ?? text(row.movement_type)}</td>
          <td data-label="Colaborador">{text(row.social_name) || text(row.employee_name)}</td>
          <td data-label="Vigência">{dateLabel(row.effective_date)}</td>
          <td data-label="Título">{text(row.title)}</td>
          <td>{canManage
            ? <button type="button" className={styles.primary} disabled={Boolean(running)} onClick={() => void execute(row)}>
              {running === text(row.id) ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Play aria-hidden="true" />} Executar</button>
            : <span className={styles.muted}>Sem permissão para executar</span>}</td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={Play} size="compact" title="Nenhuma medida aguardando execução"
        text="Movimentações aprovadas na Operação DP aparecem aqui até serem executadas." />}
  </div>;
}

/**
 * Medida "Retorno de afastamento", executada no próprio ERP (PA40): situação
 * ativa com a data do retorno, histórico e retroativo no mesmo lote, com a
 * trava do ASO inapto. Não cria movimentação na Operação DP.
 */
function ReturnToWorkAction({ companyId, onDone }: { companyId: string; onDone: (message: string) => void }) {
  const onLeave = useResource<{ employees: Row[] }>(`/api/employees${scopeQuery(companyId, { status: "on_leave", limit: "100" })}`);
  const [employeeId, setEmployeeId] = useState("");
  const [returnDate, setReturnDate] = useState(todayLocal);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await requestJson<{ retroactive: { competence: string } | null }>("/api/erp-dp/actions/return-to-work", {
        method: "POST", body: JSON.stringify({ employeeId, returnDate, notes }),
      });
      setError(""); setEmployeeId(""); setNotes("");
      onDone(result.retroactive
        ? `Retorno registrado. A data cai em ${result.retroactive.competence}, competência já processada: abrimos um retroativo.`
        : "Retorno registrado. O cadastro voltou a ativo e o histórico funcional ganhou o período novo.");
      await onLeave.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível registrar o retorno.");
    } finally { setBusy(false); }
  }

  const people = onLeave.data?.employees ?? [];
  return <form className={styles.actionCard} onSubmit={(event) => void submit(event)}>
    <header><span>Medida</span><strong>Retorno de afastamento</strong></header>
    {error && <ErrorBanner title="O retorno não foi registrado" message={error} />}
    {people.length ? <div className={styles.toolbar}>
      <label className={styles.grow}><span>Colaborador afastado</span>
        <select required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
          <option value="">Selecione</option>
          {people.map((row) => <option key={text(row.id)} value={text(row.id)}>{text(row.registration_number)} · {text(row.social_name) || text(row.full_name)}</option>)}
        </select></label>
      <label><span>Data do retorno</span><input type="date" required value={returnDate} onChange={(event) => setReturnDate(event.target.value)} /></label>
      <label className={styles.grow}><span>Observação</span><input value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} placeholder="Ex.: ASO de retorno apto" /></label>
      <button className={styles.primary} disabled={busy || !employeeId}>{busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Play aria-hidden="true" />} Executar retorno</button>
    </div> : <span className={styles.muted}>{onLeave.loading ? "Carregando afastados…" : "Ninguém afastado no escopo selecionado."}</span>}
  </form>;
}

/* -------------------------------------------------------------------------- */

type HeadcountPayload = {
  at: string;
  rows: Array<{ employeeId: string; fullName: string; registrationNumber: string; status: string; companyId: string; departmentId: string | null; positionId: string | null; costCenterId: string | null; workScheduleId: string | null; establishmentId: string | null; source: string }>;
  summary: { total: number; byStatus: Record<string, number>; byDepartment: Array<{ departmentId: string | null; active: number; onLeave: number }>; approximated: number };
  names: Record<string, Record<string, string>>;
};

function HeadcountSection({ companyId }: { companyId: string }) {
  const [at, setAt] = useState(todayLocal);
  const [includeTerminated, setIncludeTerminated] = useState(false);
  const { data, loading, error, reload } = useResource<HeadcountPayload>(`/api/erp-dp/headcount${scopeQuery(companyId, { at })}`);
  const name = useCallback((group: string, id: string | null) => (id && data?.names[group]?.[id]) || "—", [data]);
  const rows = useMemo(() => (data?.rows ?? []).filter((row) => includeTerminated || row.status !== "terminated"), [data, includeTerminated]);

  function exportCsv() {
    if (!data) return;
    const header = ["Matrícula", "Nome", "Situação", "Empresa", "Unidade", "Departamento", "Cargo", "Centro de custo", "Jornada", "Origem"];
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const lines = rows.map((row) => [row.registrationNumber, row.fullName, statusLabels[row.status] ?? row.status, name("companies", row.companyId),
      name("establishments", row.establishmentId), name("departments", row.departmentId), name("positions", row.positionId),
      name("costCenters", row.costCenterId), name("schedules", row.workScheduleId), row.source === "history" ? "Histórico" : "Cadastro atual"].map(quote).join(";"));
    const blob = new Blob([`﻿${[header.map(quote).join(";"), ...lines].join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `quadro-${data.at}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return <div className={styles.stack}>
    <div className={styles.toolbar}>
      <label><span>Data-base</span><input type="date" value={at} onChange={(event) => setAt(event.target.value || todayLocal())} /></label>
      <label className={styles.check}><input type="checkbox" checked={includeTerminated} onChange={(event) => setIncludeTerminated(event.target.checked)} /> Incluir desligados</label>
      <button type="button" className={styles.secondary} disabled={!data || !rows.length} onClick={exportCsv}><Download aria-hidden="true" /> Exportar CSV</button>
    </div>
    {loading || error || !data ? <SectionState loading={loading} error={error} reload={() => void reload()} title="Montando o quadro na data-base" /> : <>
      <div className={styles.tiles}>
        <div className={styles.tile}><small>Quadro em {dateLabel(data.at)}</small><strong>{data.summary.total}</strong><span>ativos + afastados</span></div>
        <div className={styles.tile}><small>Ativos</small><strong>{data.summary.byStatus.active ?? 0}</strong><span>com vínculo em exercício</span></div>
        <div className={styles.tile}><small>Afastados</small><strong>{data.summary.byStatus.on_leave ?? 0}</strong><span>vínculo suspenso</span></div>
        <div className={styles.tile}><small>Desligados até a data</small><strong>{data.summary.byStatus.terminated ?? 0}</strong><span>fora do quadro</span></div>
      </div>
      {data.summary.approximated > 0 && <div className={styles.note}><AlertTriangle aria-hidden="true" /><p>
        {data.summary.approximated} pessoa(s) ainda sem histórico funcional completo: para elas a lotação vem do cadastro de hoje.
        O histórico passa a valer a partir da primeira mudança registrada de cada pessoa.</p></div>}
      {data.summary.byDepartment.length > 0 && <div className={styles.bars} aria-label="Quadro por departamento">
        {data.summary.byDepartment.slice(0, 12).map((item) => {
          const max = Math.max(...data.summary.byDepartment.map((entry) => entry.active + entry.onLeave), 1);
          return <div key={item.departmentId ?? "none"} className={styles.bar}>
            <span>{name("departments", item.departmentId)}</span>
            <i><b style={{ width: `${((item.active + item.onLeave) / max) * 100}%` }} /></i>
            <strong>{item.active + item.onLeave}</strong>
          </div>;
        })}
      </div>}
      {rows.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Matrícula</th><th>Nome</th><th>Situação</th><th>Departamento</th><th>Cargo</th><th>Centro de custo</th><th>Jornada</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.employeeId}>
          <td data-label="Matrícula">{row.registrationNumber}</td>
          <td data-label="Nome">{row.fullName}{row.source === "current" && <small className={styles.muted}> · cadastro atual</small>}</td>
          <td data-label="Situação"><StatusPill status={row.status} label={statusLabels[row.status] ?? row.status} /></td>
          <td data-label="Departamento">{name("departments", row.departmentId)}</td>
          <td data-label="Cargo">{name("positions", row.positionId)}</td>
          <td data-label="Centro de custo">{name("costCenters", row.costCenterId)}</td>
          <td data-label="Jornada">{name("schedules", row.workScheduleId)}</td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={Users} size="compact" title="Ninguém no quadro nesta data" text="Confira a data-base e a empresa selecionada no topo." />}
    </>}
  </div>;
}

/* -------------------------------------------------------------------------- */

const retroStatusLabels: Record<string, string> = { open: "Aberto", posted: "Lançado na folha", waived: "Dispensado" };

function RetroSection({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const { data, loading, error, reload } = useResource<{ items: Row[] }>(`/api/erp-dp/retroactivity${scopeQuery(companyId)}`);
  const [editing, setEditing] = useState<{ id: string; status: "posted" | "waived"; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function resolve(id: string, status: "posted" | "waived" | "open", resolution: string) {
    setBusy(true);
    try {
      await requestJson(`/api/erp-dp/retroactivity/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status, resolution }) });
      setFeedback({ tone: "ok", text: status === "open" ? "Retroativo reaberto." : status === "posted" ? "Retroativo marcado como lançado na folha." : "Retroativo dispensado." });
      setEditing(null);
      await reload();
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : "Não foi possível atualizar o retroativo." });
    } finally { setBusy(false); }
  }

  return <div className={styles.stack}>
    <p className={styles.lead}>No SAP, uma mudança com data no passado marca o recálculo da folha. O Vinculato não recalcula: quando uma medida vale a partir
      de uma competência já processada, o ERP abre um retroativo para o DP lançar a diferença na próxima folha — e registrar aqui em qual.</p>
    {feedback && (feedback.tone === "ok"
      ? <div className={styles.note}><Check aria-hidden="true" /><p>{feedback.text}</p></div>
      : <ErrorBanner title="O retroativo não foi atualizado" message={feedback.text} />)}
    {loading || error || !data ? <SectionState loading={loading} error={error} reload={() => void reload()} title="Carregando retroativos" />
      : data.items.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Situação</th><th>Empresa</th><th>Colaborador</th><th>Origem</th><th>Vigência</th><th>Competência</th><th>Resolução</th></tr></thead>
        <tbody>{data.items.map((row) => {
          const id = text(row.id);
          const status = text(row.status);
          return <tr key={id}>
            <td data-label="Situação"><StatusPill status={status === "open" ? "pending" : status === "posted" ? "applied" : "neutral"} label={retroStatusLabels[status] ?? status} /></td>
            <td data-label="Empresa">{text(row.company_name)}</td>
            <td data-label="Colaborador">{text(row.employee_name) || "—"}</td>
            <td data-label="Origem">{text(row.source_type) === "erp_action" ? "Medida do ERP" : `${movementLabels[text(row.movement_type)] ?? "Movimentação"}${row.movement_title ? ` · ${text(row.movement_title)}` : ""}`}</td>
            <td data-label="Vigência">{dateLabel(row.effective_date)}</td>
            <td data-label="Competência">{text(row.competence)}</td>
            <td data-label="Resolução">
              {editing?.id === id ? <form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); void resolve(id, editing.status, editing.value); }}>
                <input autoFocus required maxLength={500} value={editing.value} aria-label={editing.status === "posted" ? "Em qual folha" : "Motivo"}
                  placeholder={editing.status === "posted" ? "Ex.: folha 11/2026, rubrica diferença" : "Por que não será lançado"}
                  onChange={(event) => setEditing({ ...editing, value: event.target.value })} />
                <button className={styles.primary} disabled={busy}>Salvar</button>
                <button type="button" className={styles.secondary} onClick={() => setEditing(null)}>Cancelar</button>
              </form>
              : status === "open" ? (canManage ? <div className={styles.inlineForm}>
                <button type="button" className={styles.secondary} disabled={busy} onClick={() => setEditing({ id, status: "posted", value: "" })}>Lançado na folha</button>
                <button type="button" className={styles.secondary} disabled={busy} onClick={() => setEditing({ id, status: "waived", value: "" })}>Dispensar</button>
              </div> : <span className={styles.muted}>Aguardando o DP</span>)
              : <div className={styles.inlineForm}><span>{text(row.resolution)}</span>
                {canManage && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void resolve(id, "open", "")} aria-label="Reabrir retroativo"><Undo2 aria-hidden="true" /></button>}</div>}
            </td>
          </tr>;
        })}</tbody>
      </table></div> : <EmptyState icon={FileClock} size="compact" title="Nenhum retroativo" text="Quando uma medida for executada com vigência numa competência já processada, ela aparece aqui." />}
  </div>;
}

/* -------------------------------------------------------------------------- */

function CyclesSection({ companyId }: { companyId: string }) {
  const { data, loading, error, reload } = useResource<{ cycles: Row[] }>(`/api/erp-dp/overview${scopeQuery(companyId)}`);
  return <div className={styles.stack}>
    <p className={styles.lead}>O registro de controle da folha: em que estado está cada competência. Abrir, conferir e fechar continua na Operação DP,
      com os gates de fechamento.</p>
    {loading || error || !data ? <SectionState loading={loading} error={error} reload={() => void reload()} title="Carregando competências" />
      : data.cycles.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Competência</th><th>Empresa</th><th>Estado</th><th>Equivalente no SAP</th><th>Pagamento</th></tr></thead>
        <tbody>{data.cycles.map((row) => <tr key={text(row.id)}>
          <td data-label="Competência">{text(row.competence)}</td>
          <td data-label="Empresa">{text(row.company_name)}</td>
          <td data-label="Estado"><StatusPill status={text(row.status)} label={cycleLabels[text(row.status)] ?? text(row.status)} /></td>
          <td data-label="Equivalente no SAP">{cycleSap[text(row.status)] ?? "—"}</td>
          <td data-label="Pagamento">{dateLabel(row.payment_date)}</td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={CalendarClock} size="compact" title="Nenhuma competência aberta" text="Abra a competência na Operação DP." />}
  </div>;
}

/* -------------------------------------------------------------------------- */

type EsocialEvent = {
  event: string; label: string; employeeId: string; recordId: string; date: string; detail: string;
  employeeName: string; registrationNumber: string;
  check: { status: string; receipt: string; notes: string; checkedAt: string } | null;
};
type EsocialPayload = { competence: string; events: EsocialEvent[]; summary: { total: number; transmitted: number; notApplicable: number; pending: number } };

function EsocialSection({ companyId, canCheck }: { companyId: string; canCheck: boolean }) {
  const [competence, setCompetence] = useState(() => todayLocal().slice(0, 7));
  const { data, loading, error, reload } = useResource<EsocialPayload>(`/api/erp-dp/esocial${scopeQuery(companyId, { competence })}`);
  const [editing, setEditing] = useState<{ key: string; status: "transmitted" | "not_applicable"; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const keyOf = (event: EsocialEvent) => `${event.recordId}|${event.event}|${event.date}`;

  async function send(items: Array<Record<string, unknown>>, message: string) {
    setBusy(true);
    try {
      await requestJson("/api/erp-dp/esocial/checks", { method: "POST", body: JSON.stringify({ items }) });
      setFeedback({ tone: "ok", text: message }); setEditing(null);
      await reload();
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : "Não foi possível gravar a conferência." });
    } finally { setBusy(false); }
  }

  async function undo(event: EsocialEvent) {
    setBusy(true);
    try {
      const query = new URLSearchParams({ historyRecordId: event.recordId, eventCode: event.event, eventDate: event.date });
      await requestJson(`/api/erp-dp/esocial/checks?${query}`, { method: "DELETE" });
      setFeedback({ tone: "ok", text: "Conferência desfeita." });
      await reload();
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : "Não foi possível desfazer." });
    } finally { setBusy(false); }
  }

  async function importSheet(file: File) {
    if (!data) return;
    const lines = parseReceiptSheet(await file.text());
    const matched: Array<Record<string, unknown>> = [];
    let unmatched = 0;
    for (const line of lines) {
      const event = data.events.find((item) => item.registrationNumber === line.registration && item.event === line.event && item.date === line.date);
      if (event) matched.push({ historyRecordId: event.recordId, eventCode: event.event, eventDate: event.date, status: "transmitted", receipt: line.receipt });
      else unmatched += 1;
    }
    if (!matched.length) {
      setFeedback({ tone: "error", text: `Nenhuma das ${lines.length} linha(s) válidas corresponde a um evento esperado desta competência. Formato: matrícula;evento;data;recibo.` });
      return;
    }
    await send(matched, `${matched.length} recibo(s) conferido(s)${unmatched ? `; ${unmatched} linha(s) sem evento correspondente nesta competência` : ""}.`);
  }

  return <div className={styles.stack}>
    <p className={styles.lead}>Os eventos não periódicos que as mudanças registradas no mês exigem. Confira no seu sistema de folha e registre aqui:
      transmitido, com o número do recibo, ou não se aplica, com o motivo. O Vinculato não gera nem envia eventos ao eSocial.</p>
    <div className={styles.toolbar}>
      <label><span>Competência</span>
        <input type="month" value={competence} onChange={(event) => setCompetence(event.target.value || todayLocal().slice(0, 7))} /></label>
      {canCheck && <label className={styles.secondary}><Upload aria-hidden="true" /> Importar recibos (CSV)
        <input type="file" accept=".csv,.txt" className={styles.hiddenInput} disabled={busy || !data}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void importSheet(file); event.target.value = ""; }} /></label>}
    </div>
    {feedback && (feedback.tone === "ok"
      ? <div className={styles.note}><Check aria-hidden="true" /><p>{feedback.text}</p></div>
      : <ErrorBanner title="A conferência não foi gravada" message={feedback.text} />)}
    {loading || error || !data ? <SectionState loading={loading} error={error} reload={() => void reload()} title="Derivando eventos do histórico" /> : <>
      {data.summary.total > 0 && <div className={styles.tiles}>
        <div className={styles.tile}><small>Eventos esperados</small><strong>{data.summary.total}</strong><span>em {data.competence}</span></div>
        <div className={styles.tile}><small>Transmitidos</small><strong>{data.summary.transmitted}</strong><span>com recibo</span></div>
        <div className={styles.tile}><small>Não se aplica</small><strong>{data.summary.notApplicable}</strong><span>com motivo</span></div>
        <div className={data.summary.pending ? styles.tileWarn : styles.tile}><small>A conferir</small><strong>{data.summary.pending}</strong><span>sem confirmação</span></div>
      </div>}
      {data.events.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Evento</th><th>Data</th><th>Colaborador</th><th>O que aconteceu</th><th>Conferência</th></tr></thead>
        <tbody>{data.events.map((row) => {
          const key = keyOf(row);
          return <tr key={key}>
            <td data-label="Evento"><strong>{row.event}</strong> · {row.label}</td>
            <td data-label="Data">{dateLabel(row.date)}</td>
            <td data-label="Colaborador">{row.registrationNumber} · {row.employeeName}</td>
            <td data-label="O que aconteceu">{row.detail}</td>
            <td data-label="Conferência">
              {editing?.key === key ? <form className={styles.inlineForm} onSubmit={(event) => {
                event.preventDefault();
                void send([{ historyRecordId: row.recordId, eventCode: row.event, eventDate: row.date, status: editing.status,
                  receipt: editing.status === "transmitted" ? editing.value : "", notes: editing.status === "not_applicable" ? editing.value : "" }],
                editing.status === "transmitted" ? "Evento conferido como transmitido." : "Evento marcado como não se aplica.");
              }}>
                <input autoFocus required value={editing.value} maxLength={editing.status === "transmitted" ? 80 : 500}
                  aria-label={editing.status === "transmitted" ? "Número do recibo" : "Motivo"}
                  placeholder={editing.status === "transmitted" ? "Nº do recibo" : "Por que não se aplica"}
                  onChange={(event) => setEditing({ ...editing, value: event.target.value })} />
                <button className={styles.primary} disabled={busy}>Salvar</button>
                <button type="button" className={styles.secondary} onClick={() => setEditing(null)}>Cancelar</button>
              </form>
              : row.check ? <div className={styles.inlineForm}>
                <StatusPill status={row.check.status === "transmitted" ? "applied" : "neutral"}
                  label={row.check.status === "transmitted" ? `Transmitido · ${row.check.receipt}` : `Não se aplica · ${row.check.notes}`} />
                {canCheck && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void undo(row)} aria-label="Desfazer conferência"><Undo2 aria-hidden="true" /></button>}
              </div>
              : canCheck ? <div className={styles.inlineForm}>
                <button type="button" className={styles.secondary} disabled={busy} onClick={() => setEditing({ key, status: "transmitted", value: "" })}>Transmitido</button>
                <button type="button" className={styles.secondary} disabled={busy} onClick={() => setEditing({ key, status: "not_applicable", value: "" })}>Não se aplica</button>
              </div>
              : <StatusPill status="pending" label="A conferir" />}
            </td>
          </tr>;
        })}</tbody>
      </table></div> : <EmptyState icon={History} size="compact" title="Nenhuma mudança registrada nesta competência"
        text="Afastamentos, retornos, desligamentos e mudanças de lotação ou jornada do mês aparecem aqui." />}
    </>}
  </div>;
}

/* -------------------------------------------------------------------------- */

type ContractDeadlineRow = { kind: string; date: string; label: string; action: string; employeeId: string; employeeName: string; registrationNumber: string; companyName: string; overdue: boolean };

function ContractsSection({ companyId, onOpen }: { companyId: string; onOpen: (employeeId: string) => void }) {
  const [days, setDays] = useState("45");
  const { data, loading, error, reload } = useResource<{ today: string; items: ContractDeadlineRow[] }>(`/api/erp-dp/contract-deadlines${scopeQuery(companyId, { days })}`);
  return <div className={styles.stack}>
    <p className={styles.lead}>Fim da experiência, do prazo determinado e do aviso prévio de quem ainda tem vínculo. Passar do fim da experiência
      sem decidir transforma o contrato em indeterminado (CLT, art. 451).</p>
    <div className={styles.toolbar}><label><span>Mostrar até</span>
      <select value={days} onChange={(event) => setDays(event.target.value)}>
        <option value="15">15 dias à frente</option><option value="45">45 dias à frente</option><option value="90">90 dias à frente</option><option value="365">1 ano à frente</option>
      </select></label></div>
    {loading || error || !data ? <SectionState loading={loading} error={error} reload={() => void reload()} title="Carregando prazos contratuais" />
      : data.items.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Data</th><th>Prazo</th><th>Colaborador</th><th>Empresa</th><th>Decisão</th><th /></tr></thead>
        <tbody>{data.items.map((row) => <tr key={`${row.employeeId}-${row.kind}`}>
          <td data-label="Data"><StatusPill status={row.overdue ? "critical" : "warning"} label={dateLabel(row.date)} /></td>
          <td data-label="Prazo">{row.label}</td>
          <td data-label="Colaborador">{row.registrationNumber} · {row.employeeName}</td>
          <td data-label="Empresa">{row.companyName}</td>
          <td data-label="Decisão">{row.action}</td>
          <td><button type="button" className={styles.secondary} onClick={() => onOpen(row.employeeId)}>Abrir contrato</button></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={FileSignature} size="compact" title="Nenhum prazo contratual nesta janela"
        text="Registre o tipo de contrato e o aviso prévio na Ficha funcional do ERP, aba Contrato." />}
  </div>;
}

/* -------------------------------------------------------------------------- */

function AboutSection() {
  const rows: Array<[string, string, string]> = [
    ["Infotipos com validade (0000, 0001, 0007)", "Histórico funcional: situação, lotação e jornada com início e fim", "Ficha funcional › Vida funcional"],
    ["Medidas (PA40)", "Movimentações aprovadas executadas com data de vigência; retorno de afastamento executado no ERP", "Medidas"],
    ["Copiar × modificar (PA30)", "Mudança abre período novo; correção conserta o vigente", "Ficha funcional › Corrigir registro"],
    ["Dia-chave (base lógica PNP)", "Quadro de pessoal em qualquer data", "Quadro em data-base"],
    ["Status da folha e retroatividade (0003)", "Retroativo para lançar a diferença, com registro de em qual folha; sem recálculo", "Retroativos"],
    ["Registro de controle (PA03)", "Competência com gates de fechamento", "Competências"],
    ["Elementos do contrato e tarefas monitoradas (0016, 0019)", "Experiência, prazo determinado e aviso prévio, com os prazos a decidir", "Ficha funcional › Contrato e Prazos contratuais"],
    ["eSocial S-2206, S-2230, S-2299", "Conferência do que o histórico exige: transmitido com recibo ou não se aplica", "eSocial esperado"],
    ["Remuneração básica (0008)", "Salário com vigência, tipo, horas, dependentes do IRRF e adicional", "Ficha funcional › Remuneração"],
    ["Folha (PY, PC00_M37_CALC)", "Folha da competência da empresa inteira, gravada e fechada, com ponto, parcelas, VT, VR e retroativos", "Folha"],
    ["Cota de ausência (2006)", "Períodos aquisitivos com saldo, vencimento do concessivo, programação com as regras da CLT e férias coletivas", "Férias"],
    ["Custo de pessoal e provisões", "Custo por pessoa, centro de custo e departamento, com encargos, provisões de férias e 13º e evolução", "Custos"],
    ["Autoatendimento (ESS)", "Link do portal do colaborador: holerites, saldo de férias e pedido de férias", "Ficha funcional › Remuneração"],
    ["Simulação de folha", "Folha do mês, férias, 13º e rescisão de uma pessoa, com média de variáveis automática", "Cálculos"],
  ];
  return <div className={styles.stack}>
    <p className={styles.lead}>O modo ERP foi desenhado a partir da engenharia reversa funcional do SAP HCM
      (documento <code>docs/engenharia-reversa-sap-hcm.md</code> do repositório). Ele reorganiza o Vinculato com a lógica de um ERP de DP
      e calcula folha, férias, 13º e rescisão com as tabelas legais vigentes; a transmissão do eSocial continua no sistema que tem o
      certificado. O que é ERP fica no ERP: nada destas telas aparece nas telas do Vinculato, e o Vinculato continua como sempre foi.</p>
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th>Conceito do SAP HCM</th><th>Como o Vinculato faz</th><th>Onde ver</th></tr></thead>
      <tbody>{rows.map(([sap, how, where]) => <tr key={sap}><td data-label="SAP HCM">{sap}</td><td data-label="Vinculato">{how}</td><td data-label="Onde">{where}</td></tr>)}</tbody>
    </table></div>
  </div>;
}
