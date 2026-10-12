"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BookOpen, CalendarClock, CalendarRange, Check, ClipboardCheck, Download, FileClock, FileSignature, History, Upload, Undo2,
  LayoutDashboard, LoaderCircle, Play, RefreshCw, Search, ShieldCheck, UserRound, Users,
} from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import { EmployeeFunctionalHistoryPanel } from "../registrations/EmployeeFunctionalHistoryPanel";
import { employeePath } from "@/lib/panel-routes";
import { parseReceiptSheet } from "@/lib/esocial-receipts";
import styles from "./erp-dp.module.css";

/**
 * Modo ERP DP — o Vinculato lido com a gramática do SAP HCM.
 *
 * Não é um segundo produto: são as mesmas tabelas, as mesmas permissões e as
 * mesmas rotas, organizadas pelas perguntas que um DP que vem de ERP faz
 * (docs/engenharia-reversa-sap-hcm.md): a ficha numa data-base (PA20), as
 * medidas esperando execução (PA40), o quadro num dia-chave, os retroativos
 * (0003), o calendário de competências (PA03) e os eventos do eSocial que as
 * mudanças do mês exigem. Nada aqui calcula folha nem transmite eSocial.
 */

type Section = "overview" | "record" | "actions" | "contracts" | "headcount" | "retro" | "cycles" | "esocial" | "about";
type Row = Record<string, unknown>;

const sections: Array<{ id: Section; label: string; sap: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Painel do DP", sap: "Início", icon: LayoutDashboard },
  { id: "record", label: "Ficha funcional", sap: "PA20 / PA30", icon: UserRound },
  { id: "actions", label: "Medidas", sap: "PA40", icon: Play },
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

export function ErpDpView({ companyId, scopeLabel, canManageMovements, canReadPending, canReadCycles, canCheckEsocial, onExit }: {
  companyId: string;
  scopeLabel: string;
  canManageMovements: boolean;
  /** Gravar a conferência do eSocial — `obligations.manage`. */
  canCheckEsocial: boolean;
  canReadPending: boolean;
  canReadCycles: boolean;
  onExit: () => void;
}) {
  const [section, setSection] = useState<Section>("overview");
  const visible = sections.filter((item) => (item.id !== "retro" || canReadPending) && (item.id !== "cycles" || canReadCycles));
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
      {section === "record" && <RecordSection companyId={companyId} onExit={onExit} />}
      {section === "actions" && <ActionsSection companyId={companyId} canManage={canManageMovements} />}
      {section === "contracts" && <ContractsSection companyId={companyId} onExit={onExit} />}
      {section === "headcount" && <HeadcountSection companyId={companyId} />}
      {section === "retro" && <RetroSection companyId={companyId} />}
      {section === "cycles" && <CyclesSection companyId={companyId} />}
      {section === "esocial" && <EsocialSection companyId={companyId} canCheck={canCheckEsocial} />}
      {section === "about" && <AboutSection />}
    </section>
  </div>;
}

/* -------------------------------------------------------------------------- */

function OverviewSection({ companyId, onGo }: { companyId: string; onGo: (section: Section) => void }) {
  const { data, loading, error, reload } = useResource<{ active: number; onLeave: number; terminated: number; approvedMovements: number; openRetroactive: number; cycles: Row[] }>(`/api/erp-dp/overview${scopeQuery(companyId)}`);
  if (loading || error || !data) return <SectionState loading={loading} error={error} reload={() => void reload()} title="Montando o painel do DP" />;
  const openCycles = data.cycles.filter((cycle) => text(cycle.status) !== "closed");
  const tiles: Array<{ label: string; value: number; hint: string; go: Section; tone?: "warn" }> = [
    { label: "Ativos hoje", value: data.active, hint: "Quadro em data-base", go: "headcount" },
    { label: "Afastados hoje", value: data.onLeave, hint: "Quadro em data-base", go: "headcount" },
    { label: "Medidas aguardando execução", value: data.approvedMovements, hint: "Aprovadas, ainda não aplicadas", go: "actions", tone: data.approvedMovements ? "warn" : undefined },
    { label: "Retroativos abertos", value: data.openRetroactive, hint: "Diferença a lançar na folha", go: "retro", tone: data.openRetroactive ? "warn" : undefined },
    { label: "Competências em andamento", value: openCycles.length, hint: "Calendário de folha", go: "cycles" },
  ];
  return <div className={styles.stack}>
    <div className={styles.tiles}>{tiles.map((tile) => <button key={tile.label} type="button" className={tile.tone === "warn" ? styles.tileWarn : styles.tile} onClick={() => onGo(tile.go)}>
      <small>{tile.label}</small><strong>{tile.value}</strong><span>{tile.hint}</span>
    </button>)}</div>
    <div className={styles.note}><ShieldCheck aria-hidden="true" /><p>
      O modo ERP lê os mesmos dados do Vinculato, com o vocabulário do SAP HCM: cada dado do vínculo tem data de validade,
      cada mudança é uma medida, e todo relatório pode ser lido numa data-base. Folha e eSocial continuam no seu sistema de folha —
      aqui você prepara, executa as medidas e confere.
    </p></div>
  </div>;
}

/* -------------------------------------------------------------------------- */

function RecordSection({ companyId, onExit }: { companyId: string; onExit: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Row[] | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  return <div className={styles.stack}>
    <form className={styles.toolbar} onSubmit={(event) => void search(event)} role="search">
      <label className={styles.grow}><span>Colaborador (nome ou matrícula)</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex.: 000123 ou Maria" /></label>
      <button className={styles.primary} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Search aria-hidden="true" />} Exibir</button>
    </form>
    {error && <ErrorBanner title="A busca falhou" message={error} />}
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
    {!results && !selected && <EmptyState icon={UserRound} size="compact" title="Informe um colaborador"
      text="A ficha funcional mostra a pessoa numa data-base — situação, lotação e jornada vigentes naquele dia — e a linha do tempo completa." />}
    {selected && <div className={styles.stack}>
      <div className={styles.recordHead}>
        <div><small>MATRÍCULA {text(selected.registration_number)} · {text(selected.company_name)}</small>
          <h2>{text(selected.social_name) || text(selected.full_name)}</h2>
          <span>Admissão {dateLabel(selected.admission_date)} · {text(selected.position_name) || "Sem cargo"} · {text(selected.department_name) || "Sem departamento"}</span></div>
        <div className={styles.actionsRow}>
          <button type="button" className={styles.secondary} onClick={() => setSelected(null)}>Outra pessoa</button>
          <a className={styles.secondary} href={employeePath(text(selected.id))} onClick={onExit}>Editar no cadastro do Vinculato</a>
        </div>
      </div>
      <EmployeeFunctionalHistoryPanel employeeId={text(selected.id)} />
    </div>}
  </div>;
}

/* -------------------------------------------------------------------------- */

function ActionsSection({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const approved = useResource<{ movements: Row[] }>(`/api/operations/movements${scopeQuery(companyId, { status: "approved", limit: "100" })}`);
  const [running, setRunning] = useState("");
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
      await approved.reload();
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : "Não foi possível executar a medida." });
    } finally { setRunning(""); }
  }

  return <div className={styles.stack}>
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

function RetroSection({ companyId }: { companyId: string }) {
  const { data, loading, error, reload } = useResource<{ items: Row[] }>(`/api/erp-dp/retroactivity${scopeQuery(companyId)}`);
  return <div className={styles.stack}>
    <p className={styles.lead}>No SAP, uma mudança com data no passado marca o recálculo da folha. O Vinculato não recalcula — ele abre uma pendência
      para o DP lançar a diferença na próxima folha. Resolva cada uma na Operação DP, em Pendências.</p>
    {loading || error || !data ? <SectionState loading={loading} error={error} reload={() => void reload()} title="Carregando retroativos" />
      : data.items.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Situação</th><th>Empresa</th><th>Colaborador</th><th>Medida</th><th>Vigência</th><th>Aberto em</th></tr></thead>
        <tbody>{data.items.map((row) => <tr key={text(row.id)}>
          <td data-label="Situação"><StatusPill status={text(row.status) === "open" ? "pending" : text(row.status)} label={text(row.status) === "open" ? "Aberto" : text(row.status) === "in_progress" ? "Em andamento" : text(row.status) === "resolved" ? "Lançado" : "Dispensado"} /></td>
          <td data-label="Empresa">{text(row.company_name)}</td>
          <td data-label="Colaborador">{text(row.employee_name) || "—"}</td>
          <td data-label="Medida">{movementLabels[text(row.movement_type)] ?? "—"}{row.movement_title ? ` · ${text(row.movement_title)}` : ""}</td>
          <td data-label="Vigência">{dateLabel(row.effective_date)}</td>
          <td data-label="Aberto em">{dateLabel(row.created_at)}</td>
        </tr>)}</tbody>
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

function ContractsSection({ companyId, onExit }: { companyId: string; onExit: () => void }) {
  const [days, setDays] = useState("45");
  const { data, loading, error, reload } = useResource<{ today: string; items: ContractDeadlineRow[] }>(`/api/erp-dp/contract-deadlines${scopeQuery(companyId, { days })}`);
  return <div className={styles.stack}>
    <p className={styles.lead}>Fim da experiência, do prazo determinado e do aviso prévio de quem ainda tem vínculo. Passar do fim da experiência
      sem decidir transforma o contrato em indeterminado (CLT, art. 451). Os mesmos prazos aparecem na Central de Trabalho.</p>
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
          <td><a className={styles.secondary} href={employeePath(row.employeeId, "contract")} onClick={onExit}>Abrir contrato</a></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={FileSignature} size="compact" title="Nenhum prazo contratual nesta janela"
        text="Registre o tipo de contrato e o aviso prévio na aba Contrato da ficha do colaborador." />}
  </div>;
}

/* -------------------------------------------------------------------------- */

function AboutSection() {
  const rows: Array<[string, string, string]> = [
    ["Infotipos com validade (0000, 0001, 0007)", "Histórico funcional: situação, lotação e jornada com início e fim", "Ficha funcional"],
    ["Medidas (PA40)", "Movimentações aprovadas, executadas com data de vigência", "Medidas"],
    ["Copiar × modificar (PA30)", "Mudança abre período novo; correção conserta o vigente", "Cadastro do colaborador"],
    ["Dia-chave (base lógica PNP)", "Quadro de pessoal em qualquer data", "Quadro em data-base"],
    ["Status da folha e retroatividade (0003)", "Pendência para lançar a diferença; sem recálculo", "Retroativos"],
    ["Registro de controle (PA03)", "Competência com gates de fechamento", "Competências"],
    ["Elementos do contrato e tarefas monitoradas (0016, 0019)", "Experiência, prazo determinado e aviso prévio, com prazos na Central", "Prazos contratuais"],
    ["eSocial S-2206, S-2230, S-2299", "Conferência do que o histórico exige: transmitido com recibo ou não se aplica", "eSocial esperado"],
  ];
  return <div className={styles.stack}>
    <p className={styles.lead}>O modo ERP foi desenhado a partir da engenharia reversa funcional do SAP HCM
      (documento <code>docs/engenharia-reversa-sap-hcm.md</code> do repositório). Ele reorganiza o Vinculato com a lógica de um ERP de DP,
      sem trazer o que o produto decidiu não fazer: cálculo de folha, rubricas e transmissão de eSocial.</p>
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th>Conceito do SAP HCM</th><th>Como o Vinculato faz</th><th>Onde ver</th></tr></thead>
      <tbody>{rows.map(([sap, how, where]) => <tr key={sap}><td data-label="SAP HCM">{sap}</td><td data-label="Vinculato">{how}</td><td data-label="Onde">{where}</td></tr>)}</tbody>
    </table></div>
  </div>;
}
