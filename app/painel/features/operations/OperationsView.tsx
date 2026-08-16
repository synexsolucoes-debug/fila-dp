"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, BookOpenCheck, Building2, CalendarClock, Check, CheckCircle2, ChevronRight,
  CircleDashed, CircleDot, ClipboardCheck, FilePlus2, Gauge, Inbox, ListChecks, LockKeyhole, Plus, RefreshCw,
  Search, ShieldAlert, ShieldCheck, TimerReset, UserCheck, UsersRound,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { EmptyState, ErrorBanner, LoadingState, PanelHeader, StatusPill } from "../shared";
import { OperationDialog } from "./OperationDialogs";
import {
  normalizeCompany, normalizeEmployee, normalizeMovement, normalizeOverview, normalizeProcess, normalizeVersion, requestJson,
} from "./operations.api";
import type {
  ClosingItem, CompanyOption, Cycle, EditorState, EmployeeOption, Movement, Obligation, OperationTab,
  OverviewPayload, PendingItem, ProcessDefinition, ProcessVersion, WorkStatus,
} from "./operations.types";
import styles from "./operations.module.css";

type Row = Record<string, unknown>;

const tabs: Array<{ id: OperationTab; label: string; icon: typeof Gauge }> = [
  { id: "overview", label: "Visão da competência", icon: Gauge },
  { id: "movements", label: "Movimentações", icon: UsersRound },
  { id: "approvals", label: "Aprovações", icon: UserCheck },
  { id: "closing", label: "Fechamento", icon: ClipboardCheck },
  { id: "obligations", label: "Obrigações", icon: CalendarClock },
  { id: "pending", label: "Pendências", icon: ShieldAlert },
  { id: "library", label: "Biblioteca", icon: BookOpenCheck },
];

const cycleStages: Array<{ status: Cycle["status"]; label: string; note: string }> = [
  { status: "open", label: "Aberta", note: "Receber entradas" },
  { status: "pre_closing", label: "Pré-fechamento", note: "Validar gates" },
  { status: "processing", label: "Processamento", note: "Executar folha" },
  { status: "post_closing", label: "Pós-fechamento", note: "Conciliar saídas" },
  { status: "closed", label: "Concluída", note: "Ciclo protegido" },
];
const nextStatus: Partial<Record<Cycle["status"], Cycle["status"]>> = { open: "pre_closing", pre_closing: "processing", processing: "post_closing", post_closing: "closed" };
const statusLabels: Record<string, string> = {
  open: "Aberta", pre_closing: "Pré-fechamento", processing: "Processamento", post_closing: "Pós-fechamento", closed: "Concluída",
  draft: "Rascunho", pending_approval: "Em aprovação", approved: "Aprovada", rejected: "Rejeitada", applied: "Aplicada", canceled: "Cancelada",
  pending: "Pendente", in_progress: "Em andamento", blocked: "Bloqueado", completed: "Concluído", resolved: "Resolvida", waived: "Dispensada",
};
const movementLabels: Record<string, string> = { salary_change: "Alteração salarial", vacation: "Férias", leave: "Afastamento", termination: "Desligamento", transfer: "Transferência", benefit_change: "Benefício", registration_sync: "Conciliação cadastral", other: "Outra" };
const obligationLabels: Record<string, string> = { payroll: "Folha", social_security: "Previdenciária", tax: "Tributária", reporting: "Declaração", union: "Sindical", other: "Outra" };

const currentCompetence = () => new Date().toISOString().slice(0, 7);
const field = (data: FormData, name: string) => String(data.get(name) ?? "").trim();
const isoDate = (value: string) => { if (!value) return "—"; const date = new Date(`${value.slice(0, 10)}T12:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(date); };
const competenceLabel = (value: string) => { const [year, month] = value.split("-"); if (!year || !month) return value; return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(Number(year), Number(month) - 1, 1)); };
const daysUntil = (value: string) => value ? Math.ceil((new Date(`${value.slice(0, 10)}T12:00:00`).getTime() - Date.now()) / 86400000) : null;

export function OperationsView({ role }: { role: WorkspaceRole }) {
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [competence, setCompetence] = useState(currentCompetence);
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [tab, setTab] = useState<OperationTab>("overview");
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [versions, setVersions] = useState<ProcessVersion[]>([]);
  const [libraryProcesses, setLibraryProcesses] = useState<ProcessDefinition[]>([]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [movementFilter, setMovementFilter] = useState("");

  const loadOverview = useCallback(async (selectedCompany: string, selectedCompetence: string, quiet = false) => {
    if (!selectedCompany) return;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams({ companyId: selectedCompany, competence: selectedCompetence });
      const payload = await requestJson<Row>(`/api/operations/overview?${params}`);
      const normalized = normalizeOverview(payload);
      setData(normalized); setCompetence(normalized.competence || selectedCompetence); setError("");
    } catch (cause) { setData(null); setError(cause instanceof Error ? cause.message : "Erro ao carregar a operação."); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  const loadCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<{ companies?: Row[] }>("/api/companies");
      const next = (payload.companies ?? []).map(normalizeCompany).filter((company) => company.status === "active");
      setCompanies(next); setCompanyId((current) => next.some((company) => company.id === current) ? current : next[0]?.id ?? ""); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar empresas."); setLoading(false); }
  }, []);

  const loadEmployees = useCallback(async () => {
    if (!companyId) return;
    try {
      const payload = await requestJson<{ employees?: Row[] }>(`/api/employees?companyId=${encodeURIComponent(companyId)}&status=active&limit=100`);
      setEmployees((payload.employees ?? []).map(normalizeEmployee));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar colaboradores."); }
  }, [companyId]);

  const loadLibrary = useCallback(async () => {
    try {
      const payload = await requestJson<{ processes?: Row[]; versions?: Row[] }>("/api/operations/processes");
      setLibraryProcesses((payload.processes ?? []).map(normalizeProcess)); setVersions((payload.versions ?? []).map(normalizeVersion));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar biblioteca."); }
  }, []);

  const openMovement = useCallback(async (movement: Movement) => {
    setBusy(true);
    try {
      const payload = await requestJson<{ movement?: Row }>(`/api/operations/movements/${movement.id}`);
      setEditor({ kind: "movement", movement: payload.movement ? normalizeMovement(payload.movement) : movement });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar a movimentação."); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { const frame = window.requestAnimationFrame(() => { void loadCompanies(); }); return () => window.cancelAnimationFrame(frame); }, [loadCompanies]);
  useEffect(() => { if (!companyId) return; const frame = window.requestAnimationFrame(() => { void loadOverview(companyId, competence); }); return () => window.cancelAnimationFrame(frame); }, [companyId, competence, loadOverview]);
  useEffect(() => { if (tab !== "library") return; const frame = window.requestAnimationFrame(() => { void loadLibrary(); }); return () => window.cancelAnimationFrame(frame); }, [loadLibrary, tab]);
  useEffect(() => { if (editor?.kind !== "movement" || employees.length) return; const frame = window.requestAnimationFrame(() => { void loadEmployees(); }); return () => window.cancelAnimationFrame(frame); }, [editor, employees.length, loadEmployees]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 3800); return () => window.clearTimeout(timer); }, [toast]);

  const selectedCompany = companies.find((company) => company.id === companyId);
  const cycle = data?.cycle ?? null;
  const blockers = useMemo(() => data?.pendingItems.filter((item) => item.blocking && ["open", "in_progress"].includes(item.status)) ?? [], [data]);
  const pendingMovements = data?.movements.filter((item) => ["draft", "pending_approval", "rejected"].includes(item.status)).length ?? 0;
  const pendingApprovals = data?.approvals.filter((item) => item.status === "pending" && item.canDecide).length ?? 0;
  const obligationExceptions = data?.obligations.filter((item) => item.status !== "completed" && (daysUntil(item.dueDate) ?? 99) <= 7).length ?? 0;
  const gateIssues = useMemo(() => {
    if (!data?.cycle) return [];
    const target = nextStatus[data.cycle.status];
    if (target !== "processing" && target !== "closed") return [];
    const issues = blockers.map((item) => item.title);
    const pendingMovementCount = data.movements.filter((item) => ["draft", "pending_approval", "rejected"].includes(item.status)).length;
    if (pendingMovementCount) issues.push(`${pendingMovementCount} movimentação${pendingMovementCount > 1 ? "ões" : ""} sem decisão final`);
    if (target === "closed") {
      const incompleteChecklist = data.closingItems.filter((item) => item.status !== "completed").length;
      const incompleteObligations = data.obligations.filter((item) => item.status !== "completed").length;
      if (incompleteChecklist) issues.push(`${incompleteChecklist} item(ns) de fechamento incompleto(s)`);
      if (incompleteObligations) issues.push(`${incompleteObligations} obrigação(ões) incompleta(s)`);
    }
    return issues;
  }, [blockers, data]);
  const filteredMovements = useMemo(() => {
    const query = movementFilter.toLocaleLowerCase("pt-BR");
    return (data?.movements ?? []).filter((item) => !query || [item.title, item.employeeName, item.socialName, movementLabels[item.movementType]].some((value) => value?.toLocaleLowerCase("pt-BR").includes(query)));
  }, [data, movementFilter]);

  async function mutate<T>(url: string, init: RequestInit, success: string): Promise<T> {
    setBusy(true);
    try {
      const result = await requestJson<T>(url, init); setError(""); setToast(success); return result;
    } finally { setBusy(false); }
  }

  async function refreshAfterMutation() {
    await loadOverview(companyId, competence, true);
    if (tab === "library") await loadLibrary();
  }

  async function handleDialogSubmit(state: NonNullable<EditorState>, form: FormData) {
    if (!companyId) return;
    try {
      if (state.kind === "competence") {
        await mutate("/api/operations/competences", { method: "POST", body: JSON.stringify({ companyId, competence: field(form, "competence"), preClosingDueDate: field(form, "preClosingDueDate") || null, paymentDate: field(form, "paymentDate") || null, postClosingDueDate: field(form, "postClosingDueDate") || null, notes: field(form, "notes") }) }, "Competência aberta com checklist padrão.");
        setCompetence(field(form, "competence"));
      } else if (state.kind === "movement") {
        const movementType = field(form, "movementType");
        const details = movementType === "salary_change" ? { newSalary: Number(field(form, "newSalary")), percentage: Number(field(form, "percentage")), reason: field(form, "reason") }
          : movementType === "vacation" ? { startDate: field(form, "startDate"), endDate: field(form, "endDate"), days: Number(field(form, "days")) }
          : movementType === "leave" ? { startDate: field(form, "startDate"), endDate: field(form, "endDate"), reasonCode: field(form, "reasonCode") }
          : movementType === "termination" ? { terminationType: field(form, "terminationType"), lastWorkingDate: field(form, "lastWorkingDate") }
          : movementType === "transfer" ? { targetCompanyId: field(form, "targetCompanyId"), departmentId: field(form, "departmentId"), positionId: field(form, "positionId"), costCenterId: field(form, "costCenterId") }
          : movementType === "benefit_change" ? { benefit: field(form, "benefit"), action: field(form, "benefitAction"), reference: field(form, "reference") }
          : movementType === "registration_sync" ? { sourceSystem: "solides", externalId: field(form, "externalId"), fields: field(form, "fields").split(",").map((item) => item.trim()).filter(Boolean) }
          : { description: field(form, "description") };
        const body = { companyId, employeeId: field(form, "employeeId") || state.movement?.employeeId, competenceId: cycle?.id || null, movementType, effectiveDate: field(form, "effectiveDate"), title: field(form, "title"), details };
        const payload = await mutate<{ movement?: { id?: string } }>(state.movement ? `/api/operations/movements/${state.movement.id}` : "/api/operations/movements", { method: state.movement ? "PATCH" : "POST", body: JSON.stringify(body) }, state.movement ? "Movimentação atualizada." : "Rascunho criado com segurança.");
        const approverUserId = field(form, "approverUserId");
        const movementId = state.movement?.id || payload.movement?.id;
        if (approverUserId && movementId) await mutate(`/api/operations/movements/${movementId}/submit`, { method: "POST", body: JSON.stringify({ approverUserId }) }, "Movimentação enviada para aprovação.");
      } else if (state.kind === "approval") {
        await mutate(`/api/operations/approvals/${state.approval.id}/decision`, { method: "POST", body: JSON.stringify({ decision: field(form, "decision"), comment: field(form, "comment") }) }, "Decisão registrada na trilha de auditoria.");
      } else if (state.kind === "obligation") {
        await mutate("/api/operations/obligations", { method: "POST", body: JSON.stringify({ companyId, competenceId: cycle?.id, obligationType: field(form, "obligationType"), title: field(form, "title"), dueDate: field(form, "dueDate"), ownerUserId: field(form, "ownerUserId") || null, cardId: field(form, "cardId") || null, notes: field(form, "notes"), protocol: field(form, "protocol"), evidenceUrl: field(form, "evidenceUrl") }) }, "Obrigação incluída no ciclo.");
      } else if (state.kind === "pending") {
        await mutate("/api/operations/pending-items", { method: "POST", body: JSON.stringify({ companyId, competenceId: cycle?.id, severity: field(form, "severity"), title: field(form, "title"), dueDate: field(form, "dueDate") || null, sourceType: field(form, "sourceType"), sourceId: cycle?.id, ownerUserId: field(form, "ownerUserId") || null, blocking: form.get("blocking") === "on" }) }, "Pendência registrada.");
      } else if (state.kind === "pending-resolution") {
        await mutate(`/api/operations/pending-items/${state.item.id}`, { method: "PATCH", body: JSON.stringify({ status: state.status, resolution: field(form, "resolution") }) }, state.status === "resolved" ? "Pendência resolvida." : "Pendência dispensada com motivo.");
      } else if (state.kind === "transition") {
        if (!cycle) return;
        await mutate(`/api/operations/competences/${cycle.id}/transition`, { method: "POST", body: JSON.stringify({ status: state.target }) }, "Ciclo avançado com sucesso.");
      } else if (state.kind === "process") {
        const step = field(form, "firstStep");
        await mutate("/api/operations/processes", { method: "POST", body: JSON.stringify({ code: field(form, "code"), name: field(form, "name"), category: field(form, "category"), configuration: { steps: [{ key: "etapa-1", name: step, gate: true, slaDays: 2 }], transitions: [], approvalRequired: false, checklist: [] } }) }, "Processo criado com versão inicial em rascunho.");
      } else if (state.kind === "process-version") {
        const step = field(form, "firstStep");
        await mutate(`/api/operations/processes/${state.process.id}/versions`, { method: "POST", body: JSON.stringify({ configuration: { steps: [{ key: "etapa-1", name: step, gate: true, slaDays: 2 }], transitions: [], approvalRequired: false, checklist: [] } }) }, "Nova versão criada em rascunho.");
      } else if (state.kind === "process-publish") {
        await mutate(`/api/operations/processes/versions/${state.version.id}/publish`, { method: "POST", body: "{}" }, "Versão publicada para o workspace.");
      }
      setEditor(null); await refreshAfterMutation();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a ação."); }
  }

  async function patchStatus(kind: "closing" | "obligation", id: string, status: string) {
    const url = kind === "closing" ? `/api/operations/closing-items/${id}` : `/api/operations/obligations/${id}`;
    try { await mutate(url, { method: "PATCH", body: JSON.stringify({ status }) }, "Status atualizado."); await refreshAfterMutation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o status."); }
  }

  if (loading && !data) return <CockpitLoading />;
  if (!companies.length && !loading) return <EmptyCompanyState error={error} onRetry={loadCompanies} />;

  const next = cycle ? nextStatus[cycle.status] : undefined;
  return (
    <section className={styles.workspace} aria-label="Operação do Departamento Pessoal">
      <div className={styles.commandBar}>
        <div className={styles.commandSelectors}>
          <label><span>EMPRESA</span><div><Building2 aria-hidden="true" /><select value={companyId} onChange={(event) => { setEmployees([]); setCompanyId(event.target.value); setCompetence(currentCompetence()); }} aria-label="Empresa da operação">{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></div></label>
          <label><span>COMPETÊNCIA</span><div><CalendarClock aria-hidden="true" /><select value={competence} onChange={(event) => setCompetence(event.target.value)} aria-label="Competência da operação"><option value={competence}>{competenceLabel(competence)}</option>{data?.cycles.filter((item) => item.competence !== competence).map((item) => <option value={item.competence} key={item.id}>{competenceLabel(item.competence)}</option>)}</select></div></label>
          <button className={styles.refreshButton} type="button" onClick={() => void loadOverview(companyId, competence, true)} disabled={refreshing} aria-label="Atualizar cockpit"><RefreshCw className={refreshing ? styles.spin : ""} aria-hidden="true" /><span>{refreshing ? "Atualizando" : "Atualizar"}</span></button>
        </div>
        {cycle ? next && data?.permissions.transitionCompetences && <button className={styles.primaryButton} type="button" onClick={() => setEditor({ kind: "transition", target: next })}>Avançar ciclo <ArrowRight aria-hidden="true" /></button> : data?.permissions.manageCompetences && <button className={styles.primaryButton} type="button" onClick={() => setEditor({ kind: "competence" })}><Plus aria-hidden="true" /> Abrir competência</button>}
      </div>

      {error && <ErrorBanner title="Algo exige atenção" message={error} onDismiss={() => setError("")} />}

      <CycleRail cycle={cycle} gateIssues={gateIssues} next={next} onAdvance={data?.permissions.transitionCompetences && next ? () => setEditor({ kind: "transition", target: next }) : undefined} />

      <div className={styles.exceptionStrip}>
        <ExceptionMetric icon={TimerReset} label="Movimentações pendentes" value={pendingMovements} tone={pendingMovements ? "warning" : "safe"} note={pendingMovements ? "Exigem avanço" : "Sem exceções"} />
        <ExceptionMetric icon={UserCheck} label="Aprovações na fila" value={pendingApprovals} tone={pendingApprovals ? "warning" : "safe"} note={pendingApprovals ? "Aguardam decisão" : "Fila limpa"} />
        <ExceptionMetric icon={CalendarClock} label="Prazos em até 7 dias" value={obligationExceptions} tone={obligationExceptions ? "danger" : "safe"} note={obligationExceptions ? "Próximos ou atrasados" : "Agenda segura"} />
        <ExceptionMetric icon={LockKeyhole} label="Bloqueadores" value={blockers.length} tone={blockers.length ? "danger" : "safe"} note={blockers.length ? "Impedem avanço" : "Gates livres"} />
      </div>

      <nav className={styles.localTabs} aria-label="Áreas da operação">{tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={tab === id ? styles.activeTab : ""} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}><Icon aria-hidden="true" />{label}{id === "approvals" && pendingApprovals > 0 && <b>{pendingApprovals}</b>}{id === "pending" && blockers.length > 0 && <b>{blockers.length}</b>}</button>)}</nav>

      <div className={styles.tabSurface}>
        {tab === "overview" && <OverviewPanel data={data} companyName={selectedCompany?.name ?? "Empresa"} />}
        {tab === "movements" && <MovementsPanel movements={filteredMovements} filter={movementFilter} setFilter={setMovementFilter} canManage={Boolean(data?.permissions.manageMovements && cycle)} onCreate={() => setEditor({ kind: "movement" })} onOpen={(movement) => void openMovement(movement)} />}
        {tab === "approvals" && <ApprovalsPanel approvals={data?.approvals ?? []} canDecide={Boolean(data?.permissions.decideApprovals)} onDecide={(approval) => setEditor({ kind: "approval", approval })} />}
        {tab === "closing" && <ClosingPanel items={data?.closingItems ?? []} canManage={Boolean(data?.permissions.manageCompetences)} onStatus={(id, status) => void patchStatus("closing", id, status)} />}
        {tab === "obligations" && <ObligationsPanel items={data?.obligations ?? []} canManage={Boolean(data?.permissions.manageObligations && cycle)} onCreate={() => setEditor({ kind: "obligation" })} onStatus={(id, status) => void patchStatus("obligation", id, status)} />}
        {tab === "pending" && <PendingPanel items={data?.pendingItems ?? []} canManage={Boolean(data?.permissions.managePending && cycle)} onCreate={() => setEditor({ kind: "pending" })} onResolve={(item, status) => setEditor({ kind: "pending-resolution", item, status })} />}
        {tab === "library" && <LibraryPanel processes={libraryProcesses.length ? libraryProcesses : data?.processes ?? []} versions={versions} canManage={Boolean(data?.permissions.manageProcesses)} canPublish={Boolean(data?.permissions.publishProcesses && role === "admin")} onCreate={() => setEditor({ kind: "process" })} onVersion={(process) => setEditor({ kind: "process-version", process })} onPublish={(process, version) => setEditor({ kind: "process-publish", process, version })} />}
      </div>

      {editor && <OperationDialog editor={editor} cycle={cycle} companyId={companyId} competence={competence} employees={employees} approvers={data?.approvers ?? []} busy={busy} onClose={() => setEditor(null)} onSubmit={handleDialogSubmit} />}
      {toast && <div className={styles.toast} role="status"><CheckCircle2 aria-hidden="true" />{toast}</div>}
    </section>
  );
}

function CycleRail({ cycle, gateIssues, next, onAdvance }: { cycle: Cycle | null; gateIssues: string[]; next?: Cycle["status"]; onAdvance?: () => void }) {
  if (!cycle) return <section className={styles.cycleEmpty}><div><CircleDashed aria-hidden="true" /><span><strong>Competência ainda não aberta</strong><small>Abra o ciclo para ativar gates, checklists e prazos desta empresa.</small></span></div></section>;
  const current = cycleStages.findIndex((stage) => stage.status === cycle.status);
  return <section className={styles.cycleRail} aria-label={`Ciclo da competência ${cycle.competence}`}>
    <header><div><span className={styles.eyebrow}>CICLO DE FECHAMENTO</span><strong>{competenceLabel(cycle.competence)}</strong></div><span className={`${styles.cycleHealth} ${gateIssues.length ? styles.healthBlocked : styles.healthSafe}`}>{gateIssues.length ? <LockKeyhole aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}{gateIssues.length ? `${gateIssues.length} gate${gateIssues.length > 1 ? "s" : ""} bloqueado${gateIssues.length > 1 ? "s" : ""}` : "Gates livres"}</span></header>
    <ol>{cycleStages.map((stage, index) => { const done = index < current; const active = index === current; return <li key={stage.status} className={done ? styles.stageDone : active ? styles.stageActive : styles.stageFuture}><span className={styles.stageIndex}>{done ? <Check aria-hidden="true" /> : index + 1}</span><div><small>{active ? "ETAPA ATUAL" : done ? "CONCLUÍDA" : "PRÓXIMA ETAPA"}</small><strong>{stage.label}</strong><span>{stage.note}</span></div>{index < cycleStages.length - 1 && <ChevronRight aria-hidden="true" />}</li>; })}</ol>
    <footer><div>{gateIssues.length ? <><AlertTriangle aria-hidden="true" /><span><strong>Avanço bloqueado</strong><small>{gateIssues[0]}{gateIssues.length > 1 ? ` e mais ${gateIssues.length - 1}` : ""}</small></span></> : <><CheckCircle2 aria-hidden="true" /><span><strong>{next ? `Próximo avanço: ${statusLabels[next]}` : "Competência concluída"}</strong><small>{next ? "O servidor validará pendências, movimentações e obrigações." : "Reabertura exige permissão e motivo auditável."}</small></span></>}</div>{onAdvance && <button type="button" onClick={onAdvance} disabled={gateIssues.length > 0}>{gateIssues.length ? "Resolver bloqueadores" : "Avançar com segurança"}<ArrowRight aria-hidden="true" /></button>}</footer>
  </section>;
}

function ExceptionMetric({ icon: Icon, label, value, note, tone }: { icon: typeof Gauge; label: string; value: number; note: string; tone: "safe" | "warning" | "danger" }) { return <article className={styles.exceptionMetric} data-tone={tone}><span><Icon aria-hidden="true" /></span><div><small>{label}</small><strong>{value}</strong><em>{note}</em></div></article>; }

/** O vocabulário de estados é local; a aparência do selo é compartilhada. */
const pill = (status: string) => <StatusPill status={status} label={statusLabels[status] ?? status} />;

function OverviewPanel({ data, companyName }: { data: OverviewPayload | null; companyName: string }) {
  const cycle = data?.cycle;
  if (!cycle) return <EmptyState icon={CalendarClock} title="Abra a competência para começar" text={`O cockpit de ${companyName} será preenchido com checklists, obrigações e movimentações do mês.`} />;
  const deadlines = [
    { label: "Pré-fechamento", date: cycle.preClosingDueDate }, { label: "Pagamento", date: cycle.paymentDate }, { label: "Pós-fechamento", date: cycle.postClosingDueDate },
  ].filter((item) => item.date);
  return <div className={styles.overviewGrid}>
    <section className={styles.demandLedger}><PanelHeader eyebrow="EXECUÇÃO" title="Demandas da competência" description="Trabalho operacional vinculado ao mês." />{data?.demands.length ? <ul>{data.demands.slice(0, 8).map((demand) => <li key={demand.id}><span className={styles.priorityMark} data-priority={demand.priority} /><div><strong>{demand.title}</strong><small>{demand.processType || "Processo geral"}</small></div><span><small>{demand.legalDueAt ? "PRAZO LEGAL" : "PRAZO"}</small><time>{isoDate(demand.legalDueAt || demand.dueAt)}</time></span></li>)}</ul> : <EmptyState icon={Inbox} title="Nenhuma demanda vinculada" text="As demandas com esta competência aparecerão aqui." />}</section>
    <aside className={styles.deadlineRail}><PanelHeader eyebrow="CALENDÁRIO" title="Marcos legais" description="Datas críticas do ciclo." /><ol>{deadlines.map((item) => { const days = daysUntil(item.date); return <li key={item.label} className={(days ?? 99) < 0 ? styles.deadlineLate : (days ?? 99) <= 5 ? styles.deadlineSoon : ""}><span /><div><strong>{item.label}</strong><time>{isoDate(item.date)}</time></div><em>{days == null ? "—" : days < 0 ? `${Math.abs(days)}d atrasado` : days === 0 ? "Hoje" : `em ${days}d`}</em></li>; })}{!deadlines.length && <li className={styles.mutedLine}>Nenhum marco informado.</li>}</ol></aside>
    <aside className={styles.cycleIndicators}><PanelHeader eyebrow="CONTROLE" title="Indicadores do ciclo" description="Leitura rápida do progresso." /><dl><div><dt>Checklist concluído</dt><dd>{data?.closingItems.length ? Math.round((data.closingItems.filter((item) => item.status === "completed").length / data.closingItems.length) * 100) : 0}%</dd></div><div><dt>Movimentações aprovadas</dt><dd>{data?.movements.filter((item) => ["approved", "applied"].includes(item.status)).length ?? 0}<small> / {data?.movements.length ?? 0}</small></dd></div><div><dt>Obrigações concluídas</dt><dd>{data?.obligations.filter((item) => item.status === "completed").length ?? 0}<small> / {data?.obligations.length ?? 0}</small></dd></div></dl></aside>
  </div>;
}

function MovementsPanel({ movements, filter, setFilter, canManage, onCreate, onOpen }: { movements: Movement[]; filter: string; setFilter: (value: string) => void; canManage: boolean; onCreate: () => void; onOpen: (movement: Movement) => void }) {
  return <><PanelHeader eyebrow="MOVIMENTAÇÕES" title="Entradas que alteram a folha" description="Rascunhos, aprovações e aplicações da competência — sem fluxo de admissão." action={canManage && <button className={styles.primaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Nova movimentação</button>} /><div className={styles.tableTools}><label><Search aria-hidden="true" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Buscar colaborador ou movimentação" aria-label="Buscar movimentação" /></label><span>{movements.length} registro(s)</span></div>{movements.length ? <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th>Colaborador</th><th>Movimentação</th><th>Vigência</th><th>Status</th><th /></tr></thead><tbody>{movements.map((item) => <tr key={item.id}><td data-label="Colaborador"><strong>{item.socialName || item.employeeName}</strong><small>{item.employeeName}</small></td><td data-label="Movimentação"><strong>{item.title}</strong><small>{movementLabels[item.movementType]}</small></td><td data-label="Vigência"><time>{isoDate(item.effectiveDate)}</time></td><td data-label="Status">{pill(item.status)}</td><td>{canManage && ["draft", "rejected"].includes(item.status) && <button className={styles.rowAction} onClick={() => onOpen(item)}>Abrir <ChevronRight aria-hidden="true" /></button>}</td></tr>)}</tbody></table></div> : <EmptyState icon={UsersRound} title="Nenhuma movimentação neste ciclo" text="Crie rascunhos para férias, alterações, afastamentos e conciliações já concluídas na Sólides." action={canManage && <button className={styles.secondaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Criar rascunho</button>} />}</>;
}

function ApprovalsPanel({ approvals, canDecide, onDecide }: { approvals: OverviewPayload["approvals"]; canDecide: boolean; onDecide: (item: OverviewPayload["approvals"][number]) => void }) {
  return <><PanelHeader eyebrow="GOVERNANÇA" title="Fila de aprovações" description="Decisões atribuídas com segregação para salário e desligamento." />{approvals.length ? <div className={styles.approvalQueue}>{approvals.map((item) => <article key={item.id} className={item.status === "pending" ? styles.approvalPending : ""}><span className={styles.approvalSequence}>{String(item.sequence).padStart(2, "0")}</span><div><small>{item.employeeName || "COLABORADOR"}</small><strong>{item.movementTitle}</strong>{pill(item.status)}</div>{item.status === "pending" && canDecide && item.canDecide ? <button className={styles.primaryButton} onClick={() => onDecide(item)}>Decidir <ArrowRight aria-hidden="true" /></button> : <span className={styles.decisionDate}>{item.decidedAt ? isoDate(item.decidedAt) : item.canDecide ? "Aguardando decisão" : "Aguardando responsável"}</span>}</article>)}</div> : <EmptyState icon={UserCheck} title="Fila de aprovações limpa" text="Novas solicitações atribuídas aparecerão aqui para decisão." />}</>;
}

function ClosingPanel({ items, canManage, onStatus }: { items: ClosingItem[]; canManage: boolean; onStatus: (id: string, status: WorkStatus) => void }) {
  const phases: Array<{ id: ClosingItem["phase"]; title: string; eyebrow: string }> = [{ id: "pre_closing", title: "Pré-fechamento", eyebrow: "ANTES DO PROCESSAMENTO" }, { id: "post_closing", title: "Pós-fechamento", eyebrow: "DEPOIS DO PROCESSAMENTO" }];
  return <><PanelHeader eyebrow="CHECKLIST CONTROLADO" title="Fechamento em duas frentes" description="Cada gate mantém estado, responsável e evidência temporal." /><div className={styles.closingColumns}>{phases.map((phase) => { const phaseItems = items.filter((item) => item.phase === phase.id); const complete = phaseItems.filter((item) => item.status === "completed").length; return <section key={phase.id} className={styles.closingColumn}><header><div><span className={styles.eyebrow}>{phase.eyebrow}</span><h3>{phase.title}</h3></div><strong>{complete}/{phaseItems.length}</strong></header>{phaseItems.length ? <ol>{phaseItems.map((item) => <li key={item.id}><span className={item.status === "completed" ? styles.checkDone : item.status === "blocked" ? styles.checkBlocked : ""}>{item.status === "completed" ? <Check aria-hidden="true" /> : item.status === "blocked" ? <LockKeyhole aria-hidden="true" /> : <CircleDot aria-hidden="true" />}</span><div><strong>{item.title}</strong><small>{item.category} {item.dueDate ? `· ${isoDate(item.dueDate)}` : ""}</small></div>{canManage ? <select aria-label={`Status de ${item.title}`} value={item.status} onChange={(event) => onStatus(item.id, event.target.value as WorkStatus)} disabled={false}><option value="pending">Pendente</option><option value="in_progress">Em andamento</option><option value="blocked">Bloqueado</option><option value="completed">Concluído</option></select> : pill(item.status)}</li>)}</ol> : <EmptyState icon={ListChecks} title="Checklist indisponível" text="Os itens padrão são criados quando a competência é aberta." />}</section>; })}</div></>;
}

function ObligationsPanel({ items, canManage, onCreate, onStatus }: { items: Obligation[]; canManage: boolean; onCreate: () => void; onStatus: (id: string, status: Obligation["status"]) => void }) {
  return <><PanelHeader eyebrow="CALENDÁRIO LEGAL" title="Obrigações da competência" description="Prazos, responsáveis e vínculo opcional com demandas." action={canManage && <button className={styles.primaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Nova obrigação</button>} />{items.length ? <div className={styles.obligationList}>{items.map((item) => { const days = daysUntil(item.dueDate); const late = item.status !== "completed" && (days ?? 0) < 0; return <article key={item.id} className={late ? styles.obligationLate : ""}><time><strong>{item.dueDate?.slice(8, 10)}</strong><span>{new Date(`${item.dueDate}T12:00:00`).toLocaleDateString("pt-BR", { month: "short" })}</span></time><div><small>{obligationLabels[item.obligationType] ?? item.obligationType}</small><strong>{item.title}</strong><span>{item.protocol ? `Protocolo ${item.protocol}` : item.status === "completed" ? "Concluída sem protocolo" : item.cardId ? "Vinculada a uma demanda" : "Sem demanda vinculada"}{item.evidenceUrl ? <> · <a href={item.evidenceUrl} target="_blank" rel="noopener noreferrer">Evidência</a></> : null}</span></div><em>{late ? `${Math.abs(days ?? 0)}d atrasada` : days === 0 ? "Vence hoje" : days != null ? `em ${days}d` : "Sem prazo"}</em>{canManage ? <select value={item.status} onChange={(event) => onStatus(item.id, event.target.value as Obligation["status"])} aria-label={`Status de ${item.title}`}><option value="open">Aberta</option><option value="in_progress">Em andamento</option><option value="blocked">Bloqueada</option><option value="completed">Concluída</option></select> : pill(item.status)}</article>; })}</div> : <EmptyState icon={CalendarClock} title="Nenhuma obrigação no ciclo" text="Inclua prazos legais para que o cockpit antecipe riscos." action={canManage && <button className={styles.secondaryButton} onClick={onCreate}>Criar obrigação</button>} />}</>;
}

function PendingPanel({ items, canManage, onCreate, onResolve }: { items: PendingItem[]; canManage: boolean; onCreate: () => void; onResolve: (item: PendingItem, status: "resolved" | "waived") => void }) {
  return <><PanelHeader eyebrow="EXCEÇÕES" title="Pendências e bloqueadores" description="Toda resolução ou dispensa exige motivo e deixa trilha auditável." action={canManage && <button className={styles.primaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Registrar pendência</button>} />{items.length ? <div className={styles.pendingLedger}>{items.map((item) => <article key={item.id} data-severity={item.severity}><span>{item.blocking ? <LockKeyhole aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}</span><div><small>{item.blocking ? "BLOQUEADOR" : item.severity.toUpperCase()} · ORIGEM {item.sourceType.toUpperCase()}</small><strong>{item.title}</strong><p>{item.resolution || (item.dueDate ? `Prazo ${isoDate(item.dueDate)}` : "Sem prazo definido")}</p></div>{pill(item.status)}{canManage && ["open", "in_progress"].includes(item.status) && <div className={styles.pendingActions}><button onClick={() => onResolve(item, "resolved")}>Resolver</button><button onClick={() => onResolve(item, "waived")}>Dispensar</button></div>}</article>)}</div> : <EmptyState icon={ShieldAlert} title="Nenhuma pendência registrada" text="O ciclo não possui exceções conhecidas no momento." />}</>;
}

function LibraryPanel({ processes, versions, canManage, canPublish, onCreate, onVersion, onPublish }: { processes: ProcessDefinition[]; versions: ProcessVersion[]; canManage: boolean; canPublish: boolean; onCreate: () => void; onVersion: (process: ProcessDefinition) => void; onPublish: (process: ProcessDefinition, version: ProcessVersion) => void }) {
  return <><PanelHeader eyebrow="PADRÕES VERSIONADOS" title="Biblioteca de processos" description="Rascunhos evoluem sem alterar a versão publicada em uso." action={canManage && <button className={styles.primaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Novo processo</button>} />{processes.length ? <div className={styles.processLedger}>{processes.map((process) => { const processVersions = versions.filter((version) => version.definitionId === process.id); const draft = processVersions.find((version) => version.status === "draft"); const published = processVersions.find((version) => version.status === "published"); return <article key={process.id}><span className={styles.processCode}>{process.code}</span><div><small>{process.category.toUpperCase()}</small><strong>{process.name}</strong><p>{published ? `Versão ${published.version} publicada` : "Ainda sem versão publicada"}{draft ? ` · v${draft.version} em rascunho` : ""}</p></div><div className={styles.processVersions}><span><strong>v{published?.version ?? process.publishedVersion ?? 0}</strong><small>PUBLICADA</small></span><span><strong>v{draft?.version ?? process.latestVersion ?? 0}</strong><small>MAIS RECENTE</small></span></div><div className={styles.processActions}>{canManage && <button onClick={() => onVersion(process)}><FilePlus2 aria-hidden="true" /> Nova versão</button>}{canPublish && draft && <button className={styles.publishButton} onClick={() => onPublish(process, draft)}><BookOpenCheck aria-hidden="true" /> Publicar</button>}</div></article>; })}</div> : <EmptyState icon={BookOpenCheck} title="Biblioteca ainda vazia" text="Crie o primeiro processo com uma versão inicial em rascunho." action={canManage && <button className={styles.secondaryButton} onClick={onCreate}>Criar processo</button>} />}</>;
}

function CockpitLoading() { return <section className={styles.workspace}><LoadingState size="page" title="Montando o cockpit de fechamento" text="Carregando competências, gates e exceções…" /></section>; }
function EmptyCompanyState({ error, onRetry }: { error: string; onRetry: () => void }) { return <section className={styles.workspace}><EmptyState icon={Building2} title={error ? "Não foi possível carregar as empresas" : "Nenhuma empresa disponível"} text={error || "Solicite acesso a uma empresa ativa para operar competências."} action={<button className={styles.secondaryButton} onClick={onRetry}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} /></section>; }
