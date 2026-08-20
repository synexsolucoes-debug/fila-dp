"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight, BadgeCheck, Building2, CalendarClock, Check, ChevronRight, ClipboardCheck, Coins, FileClock,
  FilePenLine, HeartHandshake, History, LockKeyhole, Plus, RefreshCw, RotateCcw, Send, ShieldCheck,
  Stethoscope, UserCheck, UsersRound, WalletCards,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { EmptyState, ErrorBanner, PageSkeleton, PanelHeader, StatusPill } from "../shared";
import { AuxiliaryDialog } from "./AuxiliaryDialogs";
import { normalizeCompany, normalizeDetail, normalizeOverview, requestJson, type Row } from "./auxiliary.api";
import type {
  AuxiliaryEditor, AuxiliaryModule, AuxiliaryOverview, AuxiliaryTab, CompanyOption, Execution,
  ExecutionDetail, Provider,
} from "./auxiliary.types";
import styles from "./auxiliary.module.css";

const moduleConfig: Record<AuxiliaryModule, { label: string; short: string; description: string; icon: typeof HeartHandshake }> = {
  benefits: { label: "Benefícios", short: "Benefícios", description: "Movimentos e retorno das operadoras", icon: HeartHandshake },
  psychology: { label: "Psicologia", short: "Psicologia", description: "Volumes administrativos agregados", icon: Stethoscope },
  contractors: { label: "Prestadores PJ", short: "PJ", description: "Serviços, notas e pagamentos", icon: WalletCards },
};
const tabs: Array<{ id: AuxiliaryTab; label: string; icon: typeof ClipboardCheck }> = [
  { id: "executions", label: "Entregas", icon: ClipboardCheck },
  { id: "approvals", label: "Aprovações", icon: UserCheck },
  { id: "providers", label: "Fornecedores", icon: Building2 },
  { id: "history", label: "Histórico de versões", icon: History },
];
const statusLabels: Record<string, string> = {
  draft: "Rascunho", pending_approval: "Em aprovação", approved: "Saída validada", rejected: "Rejeitada",
  closed: "Fechada", canceled: "Cancelada", submitted: "Enviada", superseded: "Substituída", pending: "Pendente",
  active: "Ativo", inactive: "Inativo",
};
const providerLabels: Record<AuxiliaryModule, string> = { benefits: "operadora", psychology: "profissional", contractors: "prestador" };
const visibleModules = (role: WorkspaceRole): AuxiliaryModule[] => role === "observer" ? ["benefits", "contractors"] : role === "guest" ? [] : ["benefits", "psychology", "contractors"];
const currentCompetence = () => new Date().toISOString().slice(0, 7);
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const amount = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
const date = (value: string) => {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
};
const competenceLabel = (value: string) => {
  const [year, month] = value.split("-");
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(Number(year), Number(month) - 1, 1));
};

export function AuxiliaryModulesView({ role }: { role: WorkspaceRole }) {
  const availableModules = useMemo(() => visibleModules(role), [role]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [competence, setCompetence] = useState(currentCompetence);
  const [module, setModule] = useState<AuxiliaryModule>(availableModules[0] ?? "benefits");
  const [overviews, setOverviews] = useState<Partial<Record<AuxiliaryModule, AuxiliaryOverview>>>({});
  const [tab, setTab] = useState<AuxiliaryTab>("executions");
  const [editor, setEditor] = useState<AuxiliaryEditor>(null);
  const [selectedDetail, setSelectedDetail] = useState<ExecutionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const loadCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<{ companies?: Row[] }>("/api/companies");
      const next = (payload.companies ?? []).map(normalizeCompany).filter((item) => item.status === "active");
      setCompanies(next); setCompanyId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? ""); setError("");
      if (!next.length) setLoading(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar empresas."); setLoading(false); }
  }, []);

  const fetchOverview = useCallback(async (selectedModule: AuxiliaryModule, selectedCompany: string, selectedCompetence: string) => {
    const params = new URLSearchParams({ companyId: selectedCompany, competence: selectedCompetence, module: selectedModule });
    return normalizeOverview(await requestJson<Row>(`/api/auxiliary/overview?${params}`));
  }, []);

  const loadLedgers = useCallback(async (selectedCompany: string, selectedCompetence: string, quiet = false) => {
    if (!selectedCompany || !availableModules.length) return;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const results = await Promise.all(availableModules.map((item) => fetchOverview(item, selectedCompany, selectedCompetence)));
      const next: Partial<Record<AuxiliaryModule, AuxiliaryOverview>> = {};
      results.forEach((item) => { next[item.module] = item; });
      setOverviews(next); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar módulos auxiliares."); }
    finally { setLoading(false); setRefreshing(false); }
  }, [availableModules, fetchOverview]);

  const refreshCurrentResource = useCallback(async () => {
    if (!companyId) return;
    setRefreshing(true);
    try {
      const next = await fetchOverview(module, companyId, competence);
      setOverviews((current) => ({ ...current, [module]: next })); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao atualizar o módulo."); }
    finally { setRefreshing(false); }
  }, [companyId, competence, fetchOverview, module]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void loadCompanies()); return () => window.cancelAnimationFrame(frame); }, [loadCompanies]);
  useEffect(() => { if (!companyId) return; const frame = window.requestAnimationFrame(() => void loadLedgers(companyId, competence)); return () => window.cancelAnimationFrame(frame); }, [companyId, competence, loadLedgers]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 3800); return () => window.clearTimeout(timer); }, [toast]);

  const data = overviews[module] ?? null;
  const selectedCompany = companies.find((item) => item.id === companyId);
  const executions = data?.executions ?? [];
  const pendingApprovals = executions.filter((item) => item.status === "pending_approval");
  const assignedApprovals = pendingApprovals.filter((item) => item.canDecide);
  const totalOpen = executions.filter((item) => !["closed", "canceled"].includes(item.status)).reduce((sum, item) => sum + item.totalAmount, 0);
  const currentCycle = data?.cycle ?? null;
  const canManage = Boolean(data?.permissions.manage && currentCycle && currentCycle.status !== "closed");

  async function mutate<T>(url: string, init: RequestInit, success: string): Promise<T> {
    setBusy(true);
    try { const result = await requestJson<T>(url, init); setError(""); setToast(success); return result; }
    finally { setBusy(false); }
  }

  async function loadExecutionDetail(execution: Execution, destination: "history" | "decision" = "history") {
    setBusy(true);
    try {
      const detail = normalizeDetail(await requestJson<Row>(`/api/auxiliary/executions/${execution.id}`));
      setSelectedDetail(detail);
      if (destination === "history") setTab("history");
      else {
        const approval = detail.approvals.find((item) => item.status === "pending" && item.canDecide);
        if (!approval) throw new Error("Esta aprovação não está disponível para sua decisão.");
        setEditor({ kind: "decision", execution: { ...execution, input: detail.execution.input, output: detail.execution.output }, approval });
      }
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao abrir a entrega."); }
    finally { setBusy(false); }
  }

  async function handleDialogSubmit(state: NonNullable<AuxiliaryEditor>, form: FormData) {
    if (!data || !companyId) return;
    if (state.kind !== "provider" && !data.cycle) return;
    try {
      if (state.kind === "execution") {
        const modulePayload = buildModulePayload(module, form);
        const body = {
          module, companyId, competenceId: data.cycle!.id, providerId: field(form, "providerId") || null,
          referenceCode: field(form, "referenceCode") || state.execution?.referenceCode, title: field(form, "title"),
          totalAmount: Number(field(form, "totalAmount") || 0), dueDate: field(form, "dueDate") || null,
          input: modulePayload.input, output: modulePayload.output,
        };
        await mutate(state.execution ? `/api/auxiliary/executions/${state.execution.id}` : "/api/auxiliary/executions", {
          method: state.execution ? "PATCH" : "POST", body: JSON.stringify(body),
        }, state.execution ? "Rascunho atualizado." : "Entrega registrada como rascunho.");
      } else if (state.kind === "revision") {
        const payload = buildModulePayload(module, form);
        await mutate(`/api/auxiliary/executions/${state.execution.id}/revisions`, { method: "POST", body: JSON.stringify(payload) }, "Nova revisão criada sem alterar o histórico.");
      } else if (state.kind === "submit") {
        await mutate(`/api/auxiliary/executions/${state.execution.id}/submit`, { method: "POST", body: JSON.stringify({ approverUserId: field(form, "approverUserId") }) }, "Entrega enviada para aprovação atribuída.");
      } else if (state.kind === "decision") {
        await mutate(`/api/auxiliary/approvals/${state.approval.id}/decision`, { method: "POST", body: JSON.stringify({ decision: field(form, "decision"), comment: field(form, "comment") }) }, "Decisão registrada no ledger.");
      } else if (state.kind === "close") {
        await mutate(`/api/auxiliary/executions/${state.execution.id}/close`, { method: "POST", body: "{}" }, "Entrega fechada na competência.");
      } else if (state.kind === "provider") {
        const body = {
          providerType: module === "benefits" ? "benefit_operator" : module === "psychology" ? "psychologist" : "contractor",
          code: field(form, "code") || state.provider?.code, legalName: field(form, "legalName"), tradeName: field(form, "tradeName"),
          taxId: field(form, "taxId"), email: field(form, "email"), phone: field(form, "phone"), status: field(form, "status"),
        };
        await mutate(state.provider ? `/api/auxiliary/providers/${state.provider.id}` : "/api/auxiliary/providers", {
          method: state.provider ? "PATCH" : "POST", body: JSON.stringify(body),
        }, state.provider ? "Fornecedor atualizado." : "Fornecedor cadastrado.");
      }
      setEditor(null); setSelectedDetail(null); await refreshCurrentResource();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a ação."); }
  }

  if (role === "guest") return null;
  if (loading && !data) return <LedgerLoading />;
  if (!companies.length && !loading) return <EmptyState icon={Building2} title="Nenhuma empresa disponível" text={error || "Solicite acesso a uma empresa ativa para operar módulos auxiliares."} action={<button className={styles.secondaryButton} onClick={() => void loadCompanies()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />;

  return <section className={styles.workspace} data-module={module} aria-label="Módulos auxiliares do Departamento Pessoal">
    <div className={styles.commandBar}>
      <div className={styles.commandSelectors}>
        <label><span>EMPRESA</span><div><Building2 aria-hidden="true" /><select value={companyId} onChange={(event) => { setCompanyId(event.target.value); setCompetence(currentCompetence()); setSelectedDetail(null); }} aria-label="Empresa dos módulos auxiliares">{companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></label>
        <label><span>COMPETÊNCIA</span><div><CalendarClock aria-hidden="true" /><select value={competence} onChange={(event) => { setCompetence(event.target.value); setSelectedDetail(null); }} aria-label="Competência dos módulos auxiliares"><option value={competence}>{competenceLabel(competence)}</option>{data?.cycles.filter((item) => item.competence !== competence).map((item) => <option key={item.id} value={item.competence}>{competenceLabel(item.competence)}</option>)}</select></div></label>
        <button className={styles.refreshButton} type="button" onClick={() => void refreshCurrentResource()} disabled={refreshing} aria-label="Atualizar módulo"><RefreshCw className={refreshing ? styles.spin : ""} aria-hidden="true" />{refreshing ? "Atualizando" : "Atualizar"}</button>
      </div>
      <div className={styles.competenceStamp}><span>COMPETÊNCIA ATIVA</span><strong>{competenceLabel(competence)}</strong><small>{selectedCompany?.name}</small></div>
    </div>

    {error && <ErrorBanner title="Algo exige atenção" message={error} onDismiss={() => setError("")} />}

    <nav className={styles.moduleLenses} aria-label="Módulos auxiliares">
      {availableModules.map((item) => { const config = moduleConfig[item]; const Icon = config.icon; const open = (overviews[item]?.executions ?? []).filter((execution) => !["closed", "canceled"].includes(execution.status)).length; return <button key={item} type="button" className={module === item ? styles.activeLens : ""} onClick={() => { setModule(item); setTab("executions"); setSelectedDetail(null); }} aria-pressed={module === item}><span className={styles.lensIcon}><Icon aria-hidden="true" /></span><span><strong>{config.label}</strong><small>{config.description}</small></span><b><strong>{open}</strong><small>EM ABERTO</small></b><ChevronRight aria-hidden="true" /></button>; })}
    </nav>

    {module === "psychology" && <aside className={styles.privacyBanner}><LockKeyhole aria-hidden="true" /><div><strong>Privacidade por desenho</strong><span>{data?.privacyBoundary || "Somente dados administrativos agregados; dados clínicos são proibidos."}</span></div><b>SEM DADOS INDIVIDUAIS</b></aside>}

    <StageLedger executions={executions} />

    <section className={styles.exceptionMetrics} aria-label="Indicadores da competência">
      <ExceptionMetric icon={Coins} label="Valor da competência" value={amount(totalOpen)} note="Entregas não encerradas" tone="neutral" />
      <ExceptionMetric icon={UserCheck} label="Aguardando sua decisão" value={String(assignedApprovals.length)} note={`${pendingApprovals.length} em aprovação atribuída`} tone={assignedApprovals.length ? "warning" : "safe"} />
      <ExceptionMetric icon={RotateCcw} label="Rejeitadas" value={String(executions.filter((item) => item.status === "rejected").length)} note="Exigem nova revisão" tone={executions.some((item) => item.status === "rejected") ? "danger" : "neutral"} />
      <ExceptionMetric icon={ShieldCheck} label="Fechadas" value={String(executions.filter((item) => item.status === "closed").length)} note="Entregas protegidas" tone="safe" />
    </section>

    {!currentCycle ? <section className={styles.cycleMissing}><CalendarClock aria-hidden="true" /><div><strong>Competência ainda não aberta</strong><span>Abra {competenceLabel(competence)} em Operação DP para registrar entregas. Os fornecedores continuam disponíveis para consulta.</span></div></section> : currentCycle.status === "closed" && <section className={styles.cycleClosed}><LockKeyhole aria-hidden="true" /><div><strong>Competência fechada</strong><span>Os registros estão em modo de leitura e permanecem disponíveis para auditoria.</span></div></section>}

    <div className={styles.localTabs} role="tablist" aria-label="Visões do módulo">
      {tabs.map((item) => { const Icon = item.icon; const count = item.id === "executions" ? executions.length : item.id === "approvals" ? pendingApprovals.length : item.id === "providers" ? data?.providers.length ?? 0 : selectedDetail?.revisions.length ?? 0; return <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? styles.activeTab : ""} onClick={() => setTab(item.id)}><Icon aria-hidden="true" />{item.label}<b>{count}</b></button>; })}
    </div>

    <div className={styles.tabSurface} role="tabpanel">
      {tab === "executions" && <ExecutionsPanel module={module} executions={executions} canManage={canManage} permissions={data?.permissions} onCreate={() => setEditor({ kind: "execution" })} onEdit={(execution) => setEditor({ kind: "execution", execution })} onRevise={(execution) => setEditor({ kind: "revision", execution })} onSubmit={(execution) => setEditor({ kind: "submit", execution })} onClose={(execution) => setEditor({ kind: "close", execution })} onHistory={(execution) => void loadExecutionDetail(execution)} />}
      {tab === "approvals" && <ApprovalsPanel executions={pendingApprovals} canDecide={Boolean(data?.permissions.decideApproval)} onDecide={(execution) => void loadExecutionDetail(execution, "decision")} />}
      {tab === "providers" && <ProvidersPanel module={module} providers={data?.providers ?? []} canManage={Boolean(data?.permissions.manage)} onCreate={() => setEditor({ kind: "provider" })} onEdit={(provider) => setEditor({ kind: "provider", provider })} />}
      {tab === "history" && <HistoryPanel detail={selectedDetail} executions={executions} onSelect={(execution) => void loadExecutionDetail(execution)} />}
    </div>

    {editor && data && <AuxiliaryDialog editor={editor} module={module} providers={data.providers} approvers={data.approvers} busy={busy} onClose={() => setEditor(null)} onSubmit={handleDialogSubmit} />}
    {toast && <div className={styles.toast} role="status"><Check aria-hidden="true" />{toast}</div>}
  </section>;
}

function StageLedger({ executions }: { executions: Execution[] }) {
  const stages = [
    { id: "entry", label: "Entrada em rascunho", note: "Preparar e revisar", icon: FilePenLine, count: executions.filter((item) => item.status === "draft" || item.status === "rejected").length },
    { id: "approval", label: "Aprovação", note: "Decisão atribuída", icon: UserCheck, count: executions.filter((item) => item.status === "pending_approval").length },
    { id: "output", label: "Saída validada", note: "Pronta para fechar", icon: BadgeCheck, count: executions.filter((item) => item.status === "approved").length },
    { id: "closed", label: "Fechado", note: "Entrega protegida", icon: LockKeyhole, count: executions.filter((item) => item.status === "closed").length },
  ];
  return <section className={styles.stageLedger} aria-label="Ledger de estágios da entrega"><header><div><span className={styles.eyebrow}>FLUXO DA ENTREGA</span><strong>Entrada → Aprovação → Saída → Fechamento</strong></div><span>{executions.length} registro(s)</span></header><ol>{stages.map((stage, index) => { const Icon = stage.icon; return <li key={stage.id} data-stage={stage.id}><span className={styles.stageIndex}>{String(index + 1).padStart(2, "0")}</span><Icon aria-hidden="true" /><div><strong>{stage.label}</strong><small>{stage.note}</small></div><b>{stage.count}</b>{index < stages.length - 1 && <ArrowRight className={styles.stageArrow} aria-hidden="true" />}</li>; })}</ol></section>;
}

function ExceptionMetric({ icon: Icon, label, value, note, tone }: { icon: typeof Coins; label: string; value: string; note: string; tone: "neutral" | "safe" | "warning" | "danger" }) {
  return <article className={styles.exceptionMetric} data-tone={tone}><span><Icon aria-hidden="true" /></span><div><small>{label}</small><strong>{value}</strong><em>{note}</em></div></article>;
}

/** O vocabulário de estados é local; a aparência do selo é compartilhada. */
const pill = (status: string) => <StatusPill status={status} label={statusLabels[status] ?? status} />;

function ExecutionsPanel({ module, executions, canManage, permissions, onCreate, onEdit, onRevise, onSubmit, onClose, onHistory }: {
  module: AuxiliaryModule; executions: Execution[]; canManage: boolean; permissions?: AuxiliaryOverview["permissions"];
  onCreate: () => void; onEdit: (item: Execution) => void; onRevise: (item: Execution) => void;
  onSubmit: (item: Execution) => void; onClose: (item: Execution) => void; onHistory: (item: Execution) => void;
}) {
  return <><PanelHeader eyebrow="ENTREGAS DA COMPETÊNCIA" title={`Ledger de ${moduleConfig[module].label}`} description="Cada linha preserva referência, revisão e estado até o fechamento." action={canManage && <button className={styles.primaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Nova entrega</button>} />
    {executions.length ? <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th>Referência</th><th>Fornecedor</th><th>Valor</th><th>Revisão</th><th>Vencimento</th><th>Estado</th><th>Ações</th></tr></thead><tbody>{executions.map((item) => <tr key={item.id}><td data-label="Referência"><strong>{item.referenceCode}</strong><small>{item.title}</small></td><td data-label="Fornecedor">{item.providerName || `Sem ${providerLabels[module]}`}</td><td data-label="Valor" className={styles.numeric}>{amount(item.totalAmount)}</td><td data-label="Revisão" className={styles.numeric}>v{item.currentRevision}</td><td data-label="Vencimento"><time>{date(item.dueDate)}</time></td><td data-label="Estado">{pill(item.status)}</td><td data-label="Ações"><div className={styles.rowActions}>
      <button onClick={() => onHistory(item)} aria-label={`Ver histórico de ${item.referenceCode}`}><History aria-hidden="true" /> Histórico</button>
      {canManage && item.status === "draft" && <button onClick={() => onEdit(item)}><FilePenLine aria-hidden="true" /> Editar</button>}
      {canManage && item.status === "rejected" && <button onClick={() => onRevise(item)}><RotateCcw aria-hidden="true" /> Nova revisão</button>}
      {canManage && permissions?.requestApproval && item.status === "draft" && <button className={styles.actionStrong} onClick={() => onSubmit(item)}><Send aria-hidden="true" /> Enviar</button>}
      {canManage && permissions?.close && item.status === "approved" && <button className={styles.actionStrong} onClick={() => onClose(item)}><LockKeyhole aria-hidden="true" /> Fechar</button>}
    </div></td></tr>)}</tbody></table></div> : <EmptyState icon={ClipboardCheck} title="Nenhuma entrega nesta competência" text={`O ledger de ${moduleConfig[module].label} está pronto para receber o primeiro rascunho.`} action={canManage && <button className={styles.secondaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Criar entrega</button>} />}
  </>;
}

function ApprovalsPanel({ executions, canDecide, onDecide }: { executions: Execution[]; canDecide: boolean; onDecide: (item: Execution) => void }) {
  return <><PanelHeader eyebrow="DECISÕES ATRIBUÍDAS" title="Fila de aprovações" description="Somente o responsável designado pode decidir; autoaprovação é bloqueada no servidor." />{executions.length ? <div className={styles.approvalQueue}>{executions.map((item) => <article key={item.id} className={item.canDecide ? styles.assignedApproval : ""}><span className={styles.approvalMark}><UserCheck aria-hidden="true" /></span><div><small>{item.referenceCode} · REVISÃO {item.currentRevision}</small><strong>{item.title}</strong><span>{item.providerName || "Sem fornecedor"} · {amount(item.totalAmount)}</span></div>{pill(item.status)}{canDecide && item.canDecide ? <button className={styles.primaryButton} onClick={() => onDecide(item)}>Decidir <ArrowRight aria-hidden="true" /></button> : <em>Aguardando responsável</em>}</article>)}</div> : <EmptyState icon={BadgeCheck} title="Fila de aprovações limpa" text="As entregas enviadas aparecerão aqui com o responsável atribuído." />}</>;
}

function ProvidersPanel({ module, providers, canManage, onCreate, onEdit }: { module: AuxiliaryModule; providers: Provider[]; canManage: boolean; onCreate: () => void; onEdit: (item: Provider) => void }) {
  const noun = module === "benefits" ? "Operadoras" : module === "psychology" ? "Profissionais e clínicas" : "Prestadores PJ";
  return <><PanelHeader eyebrow="BASE DE FORNECEDORES" title={noun} description="Cadastros reutilizáveis por competência, com status explícito e contato administrativo." action={canManage && <button className={styles.primaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Novo cadastro</button>} />{providers.length ? <div className={styles.providerLedger}>{providers.map((item) => <article key={item.id}><span className={styles.providerCode}>{item.code}</span><div><small>{item.tradeName || "SEM NOME DE EXIBIÇÃO"}</small><strong>{item.legalName}</strong><p>{[item.email, item.phone].filter(Boolean).join(" · ") || "Sem contato cadastrado"}</p></div><span className={styles.providerTax}>{item.taxId || "Documento não informado"}</span>{pill(item.status)}{canManage && <button className={styles.rowButton} onClick={() => onEdit(item)}>Editar <ChevronRight aria-hidden="true" /></button>}</article>)}</div> : <EmptyState icon={UsersRound} title={`Nenhum ${providerLabels[module]} cadastrado`} text="Cadastre o fornecedor antes de vincular uma entrega." action={canManage && <button className={styles.secondaryButton} onClick={onCreate}>Criar cadastro</button>} />}</>;
}

function HistoryPanel({ detail, executions, onSelect }: { detail: ExecutionDetail | null; executions: Execution[]; onSelect: (item: Execution) => void }) {
  if (!detail) return <><PanelHeader eyebrow="TRILHA IMUTÁVEL" title="Histórico de versões" description="Selecione uma entrega para comparar entradas, saídas e decisões preservadas." /><div className={styles.historyPicker}>{executions.map((item) => <button key={item.id} onClick={() => onSelect(item)}><FileClock aria-hidden="true" /><span><strong>{item.referenceCode}</strong><small>{item.title}</small></span><b>v{item.currentRevision}</b><ChevronRight aria-hidden="true" /></button>)}{!executions.length && <EmptyState icon={History} title="Sem histórico nesta competência" text="As revisões serão preservadas quando uma entrega rejeitada for corrigida." />}</div></>;
  const latest = detail.revisions[0];
  return <><PanelHeader eyebrow="TRILHA IMUTÁVEL" title={`${detail.execution.referenceCode} · ${detail.execution.title}`} description={`${detail.revisions.length} revisão(ões) preservada(s) para consulta e auditoria.`} action={<button className={styles.secondaryButton} onClick={() => onSelect(detail.execution)}><RefreshCw aria-hidden="true" /> Atualizar</button>} /><div className={styles.versionLedger}>{detail.revisions.map((revision, index) => { const approval = detail.approvals.find((item) => item.revisionId === revision.id); return <article key={revision.id} className={index === 0 ? styles.currentVersion : ""}><header><span>v{revision.revision}</span><div><small>{index === 0 ? "VERSÃO ATUAL" : "VERSÃO PRESERVADA"}</small><strong>{statusLabels[revision.status] ?? revision.status}</strong></div><time>{date(revision.createdAt)}</time></header><div className={styles.versionCompare}><VersionFields title="Entrada" values={revision.input} /><VersionFields title="Saída" values={revision.output} /></div><footer>{approval ? <><UserCheck aria-hidden="true" /><span><strong>{approval.approverName || "Responsável atribuído"}</strong><small>{statusLabels[approval.status] ?? approval.status}{approval.comment ? ` · ${approval.comment}` : ""}</small></span></> : <><FilePenLine aria-hidden="true" /><span><strong>Sem decisão vinculada</strong><small>Revisão mantida em preparação.</small></span></>}</footer></article>; })}{!latest && <EmptyState icon={History} title="Detalhe sem revisões" text="Atualize o recurso ou tente selecionar outra entrega." />}</div></>;
}

function VersionFields({ title, values }: { title: string; values: Record<string, unknown> }) {
  const entries = Object.entries(values);
  return <section><span>{title.toUpperCase()}</span>{entries.length ? <dl>{entries.map(([key, value]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{formatFieldValue(value)}</dd></div>)}</dl> : <p>Sem dados registrados.</p>}</section>;
}
const fieldLabel = (key: string) => ({ benefitType: "Tipo", action: "Ação", participantsCount: "Participantes", billingReference: "Cobrança", processedCount: "Processados", rejectedCount: "Rejeitados", operatorProtocol: "Protocolo", effectiveDate: "Vigência", serviceKind: "Modalidade", sessionsScheduled: "Agendadas", periodStart: "Início", periodEnd: "Fim", sessionsDelivered: "Realizadas", absences: "Ausências", administrativeProtocol: "Protocolo", serviceDescription: "Serviço", invoiceNumber: "Nota fiscal", servicePeriod: "Período", grossAmount: "Valor bruto", approvedAmount: "Valor aprovado", paymentDueDate: "Vencimento", paymentReference: "Pagamento" } as Record<string, string>)[key] ?? key;
const formatFieldValue = (value: unknown) => value == null || value === "" ? "—" : typeof value === "number" ? new Intl.NumberFormat("pt-BR").format(value) : String(value);

function buildModulePayload(module: AuxiliaryModule, form: FormData) {
  if (module === "benefits") return { input: { benefitType: field(form, "benefitType"), action: field(form, "benefitAction"), participantsCount: Number(field(form, "participantsCount") || 0), billingReference: field(form, "billingReference") }, output: { processedCount: Number(field(form, "processedCount") || 0), rejectedCount: Number(field(form, "rejectedCount") || 0), operatorProtocol: field(form, "operatorProtocol"), effectiveDate: field(form, "effectiveDate") } };
  if (module === "psychology") return { input: { serviceKind: field(form, "serviceKind"), sessionsScheduled: Number(field(form, "sessionsScheduled") || 0), periodStart: field(form, "periodStart"), periodEnd: field(form, "periodEnd") }, output: { sessionsDelivered: Number(field(form, "sessionsDelivered") || 0), absences: Number(field(form, "absences") || 0), administrativeProtocol: field(form, "administrativeProtocol") } };
  return { input: { serviceDescription: field(form, "serviceDescription"), invoiceNumber: field(form, "invoiceNumber"), servicePeriod: field(form, "servicePeriod"), grossAmount: Number(field(form, "grossAmount") || 0) }, output: { approvedAmount: Number(field(form, "approvedAmount") || 0), paymentDueDate: field(form, "paymentDueDate"), paymentReference: field(form, "paymentReference") } };
}

function LedgerLoading() { return <section className={styles.workspace}><PageSkeleton label="Abrindo o ledger de serviços" metrics={3} rows={5} /></section>; }
