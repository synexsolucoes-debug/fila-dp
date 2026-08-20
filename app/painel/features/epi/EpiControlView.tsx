"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowLeftRight, BadgeCheck, Boxes, Building2, Check, ClipboardList, Download,
  FileSignature, HardHat, Info, LayoutDashboard, PackageCheck, RefreshCw, Scale, ShieldAlert,
  ShieldCheck, Sparkles, Trash2, Undo2, Users,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import {
  caExpiryTone, epiDamageDecisionLabels, epiDamageReasonLabels, epiDeliveryStatusLabels,
  epiDisposalReasonLabels, epiDisposalStatusLabels, epiDiscountDecisionLabels, epiDiscountStatusLabels,
  epiDiscountTriggerLabels, epiProductStatusLabels, epiProductStatuses, epiRegistrationReasonLabels,
  epiReturnConditionLabels, epiTypeLabels, epiTypes,
} from "@/lib/epi";
import { epiComplianceStatusLabels } from "@/lib/epi-compliance";
import { EmptyState, ErrorBanner, LoadingState, PageSkeleton, PanelHeader, StatusPill } from "../shared";
import { EpiDialog } from "./EpiDialogs";
import { EpiDashboardPanel, EpiPeoplePanel, EpiRequirementsPanel } from "./EpiCompliancePanels";
import {
  currency, dateLabel, normalizeCatalogOption, normalizeDamage, normalizeDashboard, normalizeDelivery,
  normalizeDisposable, normalizeDiscount, normalizeDisposal, normalizeEmployeeOption, normalizeOverview,
  normalizeProduct, normalizeRequirement, normalizeReturn,
  requestJson, type Row,
} from "./epi.api";
import type {
  DisposableProduct, EmployeeOption, EpiCatalogOption, EpiDamage, EpiDashboard, EpiDelivery,
  EpiDiscount, EpiDisposal, EpiEditor, EpiOverview, EpiProduct, EpiRequirement, EpiReturn,
  EpiTab, ReportDefinition, ReportResult,
} from "./epi.types";
import styles from "./epi.module.css";

/**
 * Controle de EPI.
 *
 * A tela é organizada pela jornada do equipamento, não pelas tabelas do banco:
 * estoque, entregas, trocas, devoluções, descarte, desconto e relatórios. Os
 * cartões do topo são atalhos — clicar em "Aguardando descarte" leva à aba, com
 * o filtro já aplicado, porque o número sem o caminho até ele é decoração.
 *
 * Nenhuma tela do módulo aparece vazia sem dizer o que fazer, e nenhuma ação
 * aparece para quem não pode executá-la — as permissões vêm do servidor, que é
 * quem de fato as aplica.
 */
const tabs: Array<{ id: EpiTab; label: string; icon: typeof Boxes }> = [
  { id: "dashboard", label: "Visão geral", icon: LayoutDashboard },
  { id: "people", label: "Colaboradores", icon: Users },
  { id: "requirements", label: "Obrigatoriedade", icon: ShieldCheck },
  { id: "stock", label: "Estoque", icon: Boxes },
  { id: "deliveries", label: "Entregas", icon: PackageCheck },
  { id: "damages", label: "Trocas e danos", icon: ArrowLeftRight },
  { id: "returns", label: "Devoluções", icon: Undo2 },
  { id: "disposals", label: "Descarte", icon: Trash2 },
  { id: "discounts", label: "Descontos", icon: Scale },
  { id: "reports", label: "Relatórios", icon: ClipboardList },
];

const PAGE = 50;

export function EpiControlView({ role }: { role: WorkspaceRole }) {
  const [overview, setOverview] = useState<EpiOverview | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [tab, setTab] = useState<EpiTab>("dashboard");
  const [dashboard, setDashboard] = useState<EpiDashboard | null>(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [peopleStatus, setPeopleStatus] = useState("");
  const [requirements, setRequirements] = useState<EpiRequirement[]>([]);
  const [departments, setDepartments] = useState<EpiCatalogOption[]>([]);
  const [positions, setPositions] = useState<EpiCatalogOption[]>([]);
  const [products, setProducts] = useState<EpiProduct[]>([]);
  const [deliveries, setDeliveries] = useState<EpiDelivery[]>([]);
  const [returns, setReturns] = useState<EpiReturn[]>([]);
  const [damages, setDamages] = useState<EpiDamage[]>([]);
  const [disposals, setDisposals] = useState<EpiDisposal[]>([]);
  const [disposable, setDisposable] = useState<DisposableProduct[]>([]);
  const [discounts, setDiscounts] = useState<EpiDiscount[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [reportCatalog, setReportCatalog] = useState<ReportDefinition[]>([]);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [reportKey, setReportKey] = useState("stock");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<EpiEditor>(null);
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [toast, setToast] = useState("");

  const permissions = overview?.permissions;

  const loadOverview = useCallback(async (selected: string) => {
    const params = new URLSearchParams();
    if (selected) params.set("companyId", selected);
    const payload = normalizeOverview(await requestJson<Row>(`/api/epi/overview?${params}`));
    setOverview(payload);
    return payload;
  }, []);

  useEffect(() => {
    let alive = true;
    const frame = window.requestAnimationFrame(() => void (async () => {
      setLoading(true);
      try {
        const payload = await loadOverview("");
        if (!alive) return;
        const active = payload.companies.find((item) => item.status === "active") ?? payload.companies[0];
        setCompanyId(active?.id ?? "");
        setError("");
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "Erro ao abrir o Controle de EPI.");
      } finally {
        if (alive) setLoading(false);
      }
    })());
    return () => { alive = false; window.cancelAnimationFrame(frame); };
  }, [loadOverview]);

  const query = useCallback((extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (companyId) params.set("companyId", companyId);
    for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value) params.set(key, value);
    return params;
  }, [companyId, filters]);

  const loadTab = useCallback(async (target: EpiTab) => {
    if (!companyId && target !== "stock" && target !== "reports") return;
    setTabLoading(true);
    try {
      if (target === "dashboard" || target === "people") {
        const params = new URLSearchParams({ companyId, month });
        setDashboard(normalizeDashboard(await requestJson<Row>(`/api/epi/dashboard?${params}`)));
      } else if (target === "requirements") {
        const payload = await requestJson<{ requirements?: Row[]; departments?: Row[]; positions?: Row[] }>(
          `/api/epi/requirements?companyId=${encodeURIComponent(companyId)}`,
        );
        setRequirements((payload.requirements ?? []).map(normalizeRequirement));
        setDepartments((payload.departments ?? []).map(normalizeCatalogOption));
        setPositions((payload.positions ?? []).map(normalizeCatalogOption));
      } else if (target === "stock") {
        const params = query(); params.delete("companyId");
        const payload = await requestJson<{ products?: Row[] }>(`/api/epi/products?${params}`);
        setProducts((payload.products ?? []).map(normalizeProduct));
      } else if (target === "deliveries") {
        const payload = await requestJson<{ deliveries?: Row[] }>(`/api/epi/deliveries?${query()}`);
        setDeliveries((payload.deliveries ?? []).map(normalizeDelivery));
      } else if (target === "returns") {
        const payload = await requestJson<{ returns?: Row[] }>(`/api/epi/returns?${query()}`);
        setReturns((payload.returns ?? []).map(normalizeReturn));
      } else if (target === "damages") {
        const payload = await requestJson<{ damages?: Row[] }>(`/api/epi/damages?${query()}`);
        setDamages((payload.damages ?? []).map(normalizeDamage));
      } else if (target === "disposals") {
        const payload = await requestJson<{ disposals?: Row[]; disposable?: Row[] }>(`/api/epi/disposals?${query()}`);
        setDisposals((payload.disposals ?? []).map(normalizeDisposal));
        setDisposable((payload.disposable ?? []).map(normalizeDisposable));
      } else if (target === "discounts") {
        const payload = await requestJson<{ discounts?: Row[] }>(`/api/epi/discounts?${query()}`);
        setDiscounts((payload.discounts ?? []).map(normalizeDiscount));
      } else if (target === "reports") {
        const catalog = await requestJson<{ reports?: ReportDefinition[] }>("/api/epi/reports");
        setReportCatalog(catalog.reports ?? []);
        const params = new URLSearchParams({ report: reportKey, limit: "500" });
        if (companyId) params.set("companyId", companyId);
        if (filters.from) params.set("from", filters.from);
        if (filters.to) params.set("to", filters.to);
        setReport(await requestJson<ReportResult>(`/api/epi/reports?${params}`));
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao carregar o módulo.");
    } finally {
      setTabLoading(false);
    }
  }, [companyId, filters, month, query, reportKey]);

  // As opções de EPI e de colaborador alimentam os formulários. Carregá-las
  // junto com a aba deixaria a gaveta abrir com listas vazias no primeiro
  // clique — que foi como o formulário de entrega nasceu inutilizável.
  const loadOptions = useCallback(async () => {
    try {
      const productPayload = await requestJson<{ products?: Row[] }>("/api/epi/products?limit=200");
      setProducts((current) => current.length ? current : (productPayload.products ?? []).map(normalizeProduct));
      if (!companyId) { setEmployees([]); return; }
      const employeePayload = await requestJson<{ employees?: Row[] }>(`/api/employees?companyId=${encodeURIComponent(companyId)}&status=active&limit=200`);
      setEmployees((employeePayload.employees ?? []).map(normalizeEmployeeOption));
    } catch { /* as listas ficam vazias e o formulário diz o que falta */ }
  }, [companyId]);

  useEffect(() => {
    if (!companyId && tab !== "stock" && tab !== "reports") return;
    const frame = window.requestAnimationFrame(() => void loadTab(tab));
    return () => window.cancelAnimationFrame(frame);
  }, [companyId, tab, loadTab]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadOptions());
    return () => window.cancelAnimationFrame(frame);
  }, [companyId, loadOptions]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 3800); return () => window.clearTimeout(timer); }, [toast]);

  const productOptions = useMemo(() => products, [products]);
  const deliveryOptions = useMemo(() => deliveries
    .filter((item) => item.outstanding > 0 && item.status !== "canceled")
    .map((item) => ({ id: item.id, label: `${item.epiName} · ${item.employeeName} · ${item.outstanding} em poder`, outstanding: item.outstanding })),
  [deliveries]);

  async function submitDialog(payload: Record<string, unknown>) {
    if (!editor) return;
    setBusy(true); setDialogError("");
    try {
      const request = dialogRequest(editor, payload);
      await requestJson(request.url, { method: request.method, body: JSON.stringify(payload) });
      setEditor(null);
      setToast(request.success);
      await Promise.all([loadOverview(companyId), loadTab(tab), loadOptions()]);
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
    } finally {
      setBusy(false);
    }
  }

  async function signDelivery(delivery: EpiDelivery) {
    const signature = window.prompt("Quem assinou o termo de entrega?", delivery.employeeName);
    if (!signature) return;
    setBusy(true);
    try {
      await requestJson(`/api/epi/deliveries/${delivery.id}`, {
        method: "PATCH", body: JSON.stringify({ status: "signed", signatureName: signature }),
      });
      setToast("Termo de entrega marcado como assinado.");
      await Promise.all([loadOverview(companyId), loadTab(tab)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível registrar a assinatura.");
    } finally { setBusy(false); }
  }

  async function sanitizeReturn(item: EpiReturn, action: "start" | "complete") {
    const result = action === "complete" ? window.prompt("Resultado da higienização:", "EPI higienizado e liberado para uso") : "";
    if (action === "complete" && !result) return;
    setBusy(true);
    try {
      await requestJson(`/api/epi/returns/${item.id}/sanitization`, {
        method: "POST", body: JSON.stringify({ action, result }),
      });
      setToast(action === "start" ? "Higienização iniciada." : "Higienização concluída; saldo reposto no local de recebimento.");
      await Promise.all([loadOverview(companyId), loadTab("returns")]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível tratar a higienização."); }
    finally { setBusy(false); }
  }

  async function openReport(key: string) {
    setReportKey(key); setTabLoading(true);
    try {
      const params = new URLSearchParams({ report: key, limit: "500" });
      if (companyId) params.set("companyId", companyId);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      setReport(await requestJson<ReportResult>(`/api/epi/reports?${params}`));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao abrir o relatório.");
    } finally { setTabLoading(false); }
  }

  async function saveRequirement(id: string | null, payload: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      await requestJson(id ? `/api/epi/requirements/${id}` : "/api/epi/requirements", {
        method: id ? "PATCH" : "POST", body: JSON.stringify(payload),
      });
      setToast(id ? "Regra obrigatória atualizada." : "EPI obrigatório adicionado à lotação.");
      await loadTab("requirements");
      const params = new URLSearchParams({ companyId, month });
      setDashboard(normalizeDashboard(await requestJson<Row>(`/api/epi/dashboard?${params}`)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a regra obrigatória.");
      throw cause;
    } finally { setBusy(false); }
  }

  function openMonthlyReport() {
    const [year, selectedMonth] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, selectedMonth, 0)).toISOString().slice(0, 10);
    setFilters({ from: `${month}-01`, to: lastDay });
    setReportKey("monthly_usage");
    setTab("reports");
  }

  function exportReport() {
    const params = new URLSearchParams({ report: reportKey, format: "csv", limit: "5000" });
    if (companyId) params.set("companyId", companyId);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    window.location.href = `/api/epi/reports?${params}`;
  }

  if (role === "guest") {
    return <section className={styles.workspace}>
      <EmptyState icon={ShieldAlert} title="Sem acesso ao Controle de EPI"
        text="O perfil de convidado não alcança os cadastros de segurança do trabalho. Peça ao administrador do grupo a permissão epi.view." />
    </section>;
  }
  if (loading) {
    return <section className={styles.workspace}>
      <PageSkeleton label="Abrindo o Controle de EPI" rows={5} />
    </section>;
  }
  if (error && !overview) {
    return <section className={styles.workspace}>
      <ErrorBanner title="Não foi possível abrir o módulo" message={error} />
      <EmptyState icon={AlertTriangle} title="Controle de EPI indisponível" text="Tente novamente; se persistir, informe o suporte com o horário da tentativa."
        action={<button className={styles.secondaryButton} onClick={() => void loadOverview(companyId)}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />
    </section>;
  }
  if (!overview) {
    return <section className={styles.workspace}>
      <PageSkeleton label="Preparando o estoque compartilhado do grupo" rows={5} />
    </section>;
  }
  const summary = overview.summary;
  const company = overview.companies.find((item) => item.id === companyId);

  return <section className={styles.workspace} aria-label="Controle de EPI">
    <div className={styles.commandBar}>
      <div className={styles.commandSelectors}>
        {overview.companies.length ? <label>
          <span>EMPRESA PARA COLABORADORES E CONSUMO</span>
          <select value={companyId} onChange={(event) => { setCompanyId(event.target.value); setFilters({}); }} aria-label="Empresa do Controle de EPI">
            {overview.companies.map((item) => <option key={item.id} value={item.id}>
              {item.name}{item.taxId ? ` · ${item.taxId}` : ""}{item.status === "inactive" ? " (inativa)" : ""}
            </option>)}
          </select>
        </label> : <div className={styles.noticeBar}><Building2 aria-hidden="true" />
          <span><strong>Sem empresa consumidora disponível</strong>O catálogo continua acessível; entregas exigem uma empresa ativa e permitida.</span>
        </div>}
      </div>
      <div className={styles.commandActions}>
        <button type="button" className={styles.secondaryButton} disabled={tabLoading}
          onClick={() => void Promise.all([loadOverview(companyId), loadTab(tab)])}>
          <RefreshCw className={tabLoading ? styles.spin : ""} aria-hidden="true" />{tabLoading ? "Atualizando" : "Atualizar"}
        </button>
        {permissions?.create && <button type="button" className={styles.primaryButton} onClick={() => { setDialogError(""); setEditor({ kind: "product" }); }}>
          <HardHat aria-hidden="true" /> Cadastrar EPI
        </button>}
      </div>
    </div>

    <div className={styles.noticeBar}><Info aria-hidden="true" />
      <span><strong>Estoque único do grupo</strong>Produtos, códigos e saldos não pertencem a um CNPJ. A empresa selecionada é usada somente nas entregas e demais eventos de consumo.</span>
    </div>

    {error && <ErrorBanner title="Algo exige atenção" message={error} onDismiss={() => setError("")} />}

    {tab !== "dashboard" && <div className={styles.summaryGrid}>
      <SummaryCard icon={Boxes} label="EPIs em estoque" value={summary.stock} note="Unidades disponíveis" onClick={() => setTab("stock")} />
      <SummaryCard icon={PackageCheck} label="EPIs entregues" value={summary.delivered} note="Em poder de colaboradores" onClick={() => setTab("deliveries")} />
      <SummaryCard icon={FileSignature} label="Pendentes de assinatura" value={summary.pendingSignature} note="Termos sem assinatura"
        tone={summary.pendingSignature ? "warning" : "neutral"} onClick={() => { setTab("deliveries"); setFilters({ status: "pending_signature" }); }} />
      <SummaryCard icon={Sparkles} label="Pendentes de higienização" value={summary.pendingSanitizing} note="Fora do estoque até higienizar"
        tone={summary.pendingSanitizing ? "warning" : "neutral"} onClick={() => { setTab("returns"); setFilters({ sanitizing: "true" }); }} />
      <SummaryCard icon={Trash2} label="Aguardando descarte" value={summary.awaitingDisposal} note="Esperam confirmação"
        tone={summary.awaitingDisposal ? "warning" : "neutral"} onClick={() => { setTab("disposals"); setFilters({ status: "awaiting_disposal" }); }} />
      <SummaryCard icon={Scale} label="Descontos em análise" value={summary.discountsInAnalysis} note="Demandas abertas no DP"
        tone={summary.discountsInAnalysis ? "danger" : "neutral"} onClick={() => { setTab("discounts"); setFilters({ open: "true" }); }} />
      <SummaryCard icon={AlertTriangle} label="CA vencido ou vencendo" value={summary.caExpired + summary.caExpiring}
        note={`${summary.caExpired} vencido(s) · ${summary.caExpiring} em ${overview.caWindowDays} dias`}
        tone={summary.caExpired ? "danger" : summary.caExpiring ? "warning" : "safe"} onClick={() => setTab("stock")} />
    </div>}

    <div className={styles.tabs} role="tablist" aria-label="Áreas do Controle de EPI">
      {tabs.map((item) => {
        const Icon = item.icon;
        const count = item.id === "dashboard" ? dashboard?.summary.activeEmployees ?? 0
          : item.id === "people" ? dashboard?.employees.length ?? 0
            : item.id === "requirements" ? requirements.length
              : item.id === "stock" ? products.length : item.id === "deliveries" ? deliveries.length
                : item.id === "returns" ? returns.length : item.id === "damages" ? damages.length
                  : item.id === "disposals" ? disposals.length : item.id === "discounts" ? discounts.length : reportCatalog.length;
        return <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? styles.activeTab : ""}
          onClick={() => { setTab(item.id); setFilters({}); }}>
          <Icon aria-hidden="true" />{item.label}<b>{count}</b>
        </button>;
      })}
    </div>

    {tabLoading && <LoadingState size="compact" title="Carregando" text="Buscando os registros desta aba…" />}

    {!tabLoading && tab === "dashboard" && <EpiDashboardPanel dashboard={dashboard} month={month}
      onMonth={setMonth} onPeople={(status) => { setPeopleStatus(status ?? ""); setTab("people"); }}
      onRequirements={() => setTab("requirements")} onReport={openMonthlyReport} />}

    {!tabLoading && tab === "people" && <EpiPeoplePanel key={peopleStatus || "all"}
      employees={dashboard?.employees ?? []} initialStatus={peopleStatus} products={products}
      onDeliver={(employee, product) => { setDialogError(""); setEditor({ kind: "delivery", product, employee }); }} />}

    {!tabLoading && tab === "requirements" && <EpiRequirementsPanel companyId={companyId}
      requirements={requirements} departments={departments} positions={positions} products={products}
      canManage={Boolean(dashboard?.canManageRequirements ?? permissions?.edit)} busy={busy}
      onCreate={(payload) => saveRequirement(null, payload)} onUpdate={(id, payload) => saveRequirement(id, payload)}
      onReload={() => void loadTab("requirements")} />}

    {!tabLoading && tab === "stock" && <StockPanel
      products={products} filters={filters} onFilters={setFilters} permissions={permissions}
      canConsume={Boolean(companyId)}
      onChanged={() => void Promise.all([loadOverview(companyId), loadTab("stock")])}
      onCreate={() => { setDialogError(""); setEditor({ kind: "product" }); }}
      onEdit={(product) => { setDialogError(""); setEditor({ kind: "product", product }); }}
      onDeliver={(product) => { setDialogError(""); setEditor({ kind: "delivery", product }); }} />}

    {!tabLoading && tab === "deliveries" && <DeliveriesPanel
      deliveries={deliveries} filters={filters} onFilters={setFilters} permissions={permissions} busy={busy}
      onCreate={() => { setDialogError(""); setEditor({ kind: "delivery" }); }}
      onReturn={(delivery) => { setDialogError(""); setEditor({ kind: "return", delivery }); }}
      onDamage={(delivery) => { setDialogError(""); setEditor({ kind: "damage", delivery }); }}
      onSign={(delivery) => void signDelivery(delivery)} />}

    {!tabLoading && tab === "damages" && <DamagesPanel damages={damages} permissions={permissions}
      onCreate={() => { setDialogError(""); setEditor({ kind: "damage" }); }} />}

    {!tabLoading && tab === "returns" && <ReturnsPanel returns={returns} filters={filters} onFilters={setFilters}
      permissions={permissions} busy={busy} onSanitize={(item, action) => void sanitizeReturn(item, action)}
      onGoToDeliveries={() => { setTab("deliveries"); setFilters({ outstanding: "true" }); }} />}

    {!tabLoading && tab === "disposals" && <DisposalsPanel
      disposals={disposals} disposable={disposable} filters={filters} onFilters={setFilters} permissions={permissions}
      onCreate={(product) => { setDialogError(""); setEditor({ kind: "disposal", product }); }}
      onDecide={(disposal, action) => { setDialogError(""); setEditor({ kind: "disposal-decision", disposal, action }); }} />}

    {!tabLoading && tab === "discounts" && <DiscountsPanel discounts={discounts} filters={filters} onFilters={setFilters}
      permissions={permissions} onDecide={(discount) => { setDialogError(""); setEditor({ kind: "discount", discount }); }} />}

    {!tabLoading && tab === "reports" && <ReportsPanel catalog={reportCatalog} report={report} reportKey={reportKey}
      filters={filters} onFilters={setFilters} canExport={Boolean(permissions?.export)}
      onOpen={(key) => void openReport(key)} onExport={exportReport} onReload={() => void openReport(reportKey)} />}

    {editor && <EpiDialog editor={editor} products={productOptions} employees={employees} deliveries={deliveryOptions} companyId={companyId}
      busy={busy} error={dialogError} onClose={() => { setEditor(null); setDialogError(""); }} onSubmit={submitDialog} />}

    {toast && <div className={styles.toast} role="status"><Check aria-hidden="true" />{toast}</div>}

    {company?.status === "inactive" && <p className={styles.fieldHint}>
      Esta empresa está inativa: os registros continuam disponíveis para consulta e auditoria, mas novos cadastros são recusados.
    </p>}
  </section>;
}

function SummaryCard({ icon: Icon, label, value, note, tone, onClick }: {
  icon: typeof Boxes; label: string; value: number; note: string;
  tone?: "neutral" | "safe" | "warning" | "danger"; onClick?: () => void;
}) {
  const content = <>
    <span><Icon aria-hidden="true" />{label}</span>
    <strong>{new Intl.NumberFormat("pt-BR").format(value)}</strong>
    <small>{note}</small>
  </>;
  if (!onClick) return <article className={styles.summaryCard} data-tone={tone ?? "neutral"}>{content}</article>;
  return <button type="button" className={styles.summaryCard} data-tone={tone ?? "neutral"} onClick={onClick}>{content}</button>;
}

const pill = (status: string, label: string) => <StatusPill status={status} label={label} />;

function StockPanel({ products, filters, onFilters, permissions, canConsume, onChanged, onCreate, onEdit, onDeliver }: {
  products: EpiProduct[]; filters: Record<string, string>; onFilters: (value: Record<string, string>) => void;
  permissions?: EpiOverview["permissions"]; onCreate: () => void; onEdit: (product: EpiProduct) => void;
  onDeliver: (product: EpiProduct) => void; canConsume: boolean; onChanged: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return <>
    <PanelHeader eyebrow="ESTOQUE COMPARTILHADO DO GRUPO" title="EPIs cadastrados"
      description="Produto, código e saldo pertencem ao Workspace e são separados somente por local físico."
      action={permissions?.create && <button className={styles.primaryButton} onClick={onCreate}><HardHat aria-hidden="true" /> Cadastrar EPI</button>} />
    {permissions?.stockAdjust && <StockOperations products={products} onChanged={onChanged} />}
    <FilterBar filters={filters} onFilters={onFilters} fields={[
      { name: "search", label: "NOME", type: "text" },
      { name: "ca", label: "CA", type: "text" },
      { name: "size", label: "TAMANHO", type: "text" },
      { name: "status", label: "STATUS", options: epiProductStatuses.map((item) => [item, epiProductStatusLabels[item]]) },
      { name: "type", label: "TIPO", options: epiTypes.map((item) => [item, epiTypeLabels[item]]) },
      { name: "from", label: "CADASTRO DE", type: "date" },
      { name: "to", label: "ATÉ", type: "date" },
    ]} />
    {products.length ? <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead><tr>
          <th>EPI</th><th>CA</th><th>Tamanho</th><th className={styles.numeric}>Estoque</th>
          <th className={styles.numeric}>Com colaboradores</th><th className={styles.numeric}>Valor</th>
          <th>Validade do CA</th><th>Status</th><th aria-label="Ações" />
        </tr></thead>
        <tbody>{products.map((product) => {
          const tone = caExpiryTone(product.caExpiresOn || null, today);
          return <tr key={product.id}>
            <td><strong>{product.name}</strong><small>{epiTypeLabels[product.epiType] ?? product.epiType} · {product.brand} {product.model}</small></td>
            <td>{product.caNumber}</td>
            <td>{product.size}</td>
            <td className={styles.numeric}>{product.stockQuantity}<small>{product.stockLocations.length
              ? product.stockLocations.filter((item) => item.quantity > 0).map((item) => `${item.name}: ${item.quantity}`).join(" · ")
              : "Sem saldo por local"}</small></td>
            <td className={styles.numeric}>{product.assignedQuantity}</td>
            <td className={styles.numeric}>{currency(product.unitValue)}</td>
            <td>{product.caExpiresOn
              ? <>{dateLabel(product.caExpiresOn)}{tone !== "valid" && <small>{tone === "expired" ? "CA vencido" : "Vence em breve"}</small>}</>
              : <small>Não informada</small>}</td>
            <td>{pill(product.status, epiProductStatusLabels[product.status] ?? product.status)}</td>
            <td><div className={styles.rowActions}>
              {permissions?.deliver && canConsume && product.stockQuantity > 0 && <button onClick={() => onDeliver(product)}>
                <PackageCheck aria-hidden="true" /> Entregar
              </button>}
              {permissions?.edit && <button onClick={() => onEdit(product)}>Editar</button>}
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <EmptyState icon={Boxes} title="Nenhum EPI cadastrado neste grupo"
      text="Cadastre o primeiro equipamento e escolha o local físico da entrada para começar a controlar o saldo compartilhado."
      action={permissions?.create && <button className={styles.secondaryButton} onClick={onCreate}><HardHat aria-hidden="true" /> Cadastrar EPI</button>} />}
  </>;
}

type StockLocationOption = { id: string; code: string; name: string; status: string; is_default: number; total_quantity: number };

function StockOperations({ products, onChanged }: { products: EpiProduct[]; onChanged: () => void }) {
  const [locations, setLocations] = useState<StockLocationOption[]>([]);
  const [mode, setMode] = useState<"entry" | "transfer" | "location">("entry");
  const [form, setForm] = useState<Record<string, string>>({ movementDate: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const payload = await requestJson<{ locations?: StockLocationOption[] }>("/api/epi/stock/locations");
      setLocations(payload.locations ?? []);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Não foi possível carregar os locais."); }
  }, []);
  useEffect(() => { const frame = requestAnimationFrame(() => void load()); return () => cancelAnimationFrame(frame); }, [load]);
  const set = (name: string, value: string) => setForm((current) => ({ ...current, [name]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const idempotencyKey = crypto.randomUUID();
      if (mode === "location") {
        await requestJson("/api/epi/stock/locations", { method: "POST", body: JSON.stringify({
          code: form.code, name: form.name, description: form.description, isDefault: form.isDefault === "true",
        }) });
        setMessage("Local de estoque criado.");
      } else if (mode === "entry") {
        await requestJson("/api/epi/stock/entries", { method: "POST", body: JSON.stringify({
          productId: form.productId, stockLocationId: form.stockLocationId,
          quantity: Number(form.quantity), movementDate: form.movementDate, reason: form.reason,
          notes: form.notes, idempotencyKey,
        }) });
        setMessage("Entrada registrada no saldo compartilhado.");
      } else {
        await requestJson("/api/epi/stock/transfers", { method: "POST", body: JSON.stringify({
          productId: form.productId, sourceStockLocationId: form.sourceStockLocationId,
          targetStockLocationId: form.targetStockLocationId, quantity: Number(form.quantity),
          movementDate: form.movementDate, notes: form.notes, idempotencyKey,
        }) });
        setMessage("Transferência concluída entre os locais.");
      }
      setForm({ movementDate: new Date().toISOString().slice(0, 10) });
      await load(); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Não foi possível movimentar o estoque."); }
    finally { setBusy(false); }
  }
  return <section className={styles.stockOperations} aria-label="Operações de estoque">
    <div className={styles.stockOperationTabs}>
      <strong>Operações de estoque</strong>
      <button type="button" data-active={mode === "entry"} onClick={() => setMode("entry")}>Entrada</button>
      <button type="button" data-active={mode === "transfer"} onClick={() => setMode("transfer")}>Entre locais</button>
      <button type="button" data-active={mode === "location"} onClick={() => setMode("location")}>Novo local</button>
      <small>{locations.length} local(is) · saldo total {locations.reduce((sum, item) => sum + Number(item.total_quantity ?? 0), 0)}</small>
    </div>
    {mode === "transfer" && <div className={styles.noticeBar}><Info aria-hidden="true" />
      <span><strong>Movimentação física</strong>Move saldo entre locais do mesmo grupo; nunca entre CNPJs.</span>
    </div>}
    <form className={styles.stockOperationForm} onSubmit={(event) => void submit(event)}>
      {mode === "location" ? <>
        <label><span>CÓDIGO</span><input required value={form.code ?? ""} onChange={(event) => set("code", event.target.value)} placeholder="ALMOX" /></label>
        <label><span>NOME DO LOCAL</span><input required value={form.name ?? ""} onChange={(event) => set("name", event.target.value)} placeholder="Almoxarifado central" /></label>
        <label><span>DESCRIÇÃO</span><input value={form.description ?? ""} onChange={(event) => set("description", event.target.value)} /></label>
      </> : <>
        <label><span>EPI</span><select required value={form.productId ?? ""} onChange={(event) => set("productId", event.target.value)}>
          <option value="">Selecione</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name} · CA {item.caNumber}</option>)}
        </select></label>
        {mode === "entry" ? <label><span>LOCAL DE DESTINO</span><select required value={form.stockLocationId ?? ""} onChange={(event) => set("stockLocationId", event.target.value)}>
          <option value="">Selecione</option>{locations.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label> : <>
          <label><span>ORIGEM</span><select required value={form.sourceStockLocationId ?? ""} onChange={(event) => set("sourceStockLocationId", event.target.value)}>
            <option value="">Selecione</option>{locations.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label><span>DESTINO</span><select required value={form.targetStockLocationId ?? ""} onChange={(event) => set("targetStockLocationId", event.target.value)}>
            <option value="">Selecione</option>{locations.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </>}
        <label><span>QUANTIDADE</span><input required type="number" min="1" value={form.quantity ?? ""} onChange={(event) => set("quantity", event.target.value)} /></label>
        <label><span>DATA</span><input required type="date" value={form.movementDate ?? ""} onChange={(event) => set("movementDate", event.target.value)} /></label>
        <label><span>OBSERVAÇÃO</span><input value={form.notes ?? ""} onChange={(event) => set("notes", event.target.value)} /></label>
      </>}
      <button className={styles.secondaryButton} disabled={busy}>{busy ? "Salvando…" : mode === "location" ? "Criar local" : "Confirmar operação"}</button>
    </form>
    {message && <p className={styles.operationMessage}>{message}</p>}
  </section>;
}

function DeliveriesPanel({ deliveries, filters, onFilters, permissions, busy, onCreate, onReturn, onDamage, onSign }: {
  deliveries: EpiDelivery[]; filters: Record<string, string>; onFilters: (value: Record<string, string>) => void;
  permissions?: EpiOverview["permissions"]; busy: boolean; onCreate: () => void;
  onReturn: (delivery: EpiDelivery) => void; onDamage: (delivery: EpiDelivery) => void; onSign: (delivery: EpiDelivery) => void;
}) {
  return <>
    <PanelHeader eyebrow="ENTREGAS" title="EPIs entregues a colaboradores"
      description="Quem está com o quê, desde quando, e o estado do termo de entrega."
      action={permissions?.deliver && <button className={styles.primaryButton} onClick={onCreate}><PackageCheck aria-hidden="true" /> Nova entrega</button>} />
    <FilterBar filters={filters} onFilters={onFilters} fields={[
      { name: "status", label: "STATUS", options: (["delivered", "pending_signature", "signed", "canceled"] as const).map((item) => [item, epiDeliveryStatusLabels[item]]) },
      { name: "outstanding", label: "SOMENTE EM PODER", options: [["true", "Sim"]] },
      { name: "from", label: "ENTREGA DE", type: "date" },
      { name: "to", label: "ATÉ", type: "date" },
    ]} />
    {deliveries.length ? <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead><tr>
          <th>Colaborador</th><th>EPI</th><th>Data</th><th className={styles.numeric}>Qtd.</th>
          <th className={styles.numeric}>Em poder</th><th>Status</th><th aria-label="Ações" />
        </tr></thead>
        <tbody>{deliveries.map((delivery) => <tr key={delivery.id}>
          <td><strong>{delivery.employeeName}</strong><small>{delivery.registrationNumber} · {delivery.positionName || "Sem cargo"}</small></td>
          <td><strong>{delivery.epiName}</strong><small>CA {delivery.caNumber || "—"} · {delivery.size || "—"}</small></td>
          <td>{dateLabel(delivery.deliveredOn)}</td>
          <td className={styles.numeric}>{delivery.quantity}</td>
          <td className={styles.numeric}>{delivery.outstanding}</td>
          <td>{pill(delivery.status, epiDeliveryStatusLabels[delivery.status] ?? delivery.status)}</td>
          <td><div className={styles.rowActions}>
            {permissions?.deliver && delivery.status === "pending_signature" && <button disabled={busy} onClick={() => onSign(delivery)}>
              <BadgeCheck aria-hidden="true" /> Assinar
            </button>}
            {permissions?.receiveReturn && delivery.outstanding > 0 && <button onClick={() => onReturn(delivery)}>
              <Undo2 aria-hidden="true" /> Devolver
            </button>}
            {permissions?.damage && delivery.outstanding > 0 && <button onClick={() => onDamage(delivery)}>
              <ArrowLeftRight aria-hidden="true" /> Trocar
            </button>}
          </div></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={PackageCheck} title="Nenhuma entrega registrada"
      text="Assim que um EPI for entregue, ele aparece aqui com o termo, o colaborador e a data."
      action={permissions?.deliver && <button className={styles.secondaryButton} onClick={onCreate}>Registrar entrega</button>} />}
  </>;
}

function DamagesPanel({ damages, permissions, onCreate }: {
  damages: EpiDamage[]; permissions?: EpiOverview["permissions"]; onCreate: () => void;
}) {
  return <>
    <PanelHeader eyebrow="TROCA POR DANIFICAÇÃO" title="Ocorrências e decisões"
      description="Motivo apurado, decisão tomada e o que ela provocou — troca, descarte, higienização ou análise de desconto."
      action={permissions?.damage && <button className={styles.primaryButton} onClick={onCreate}><ArrowLeftRight aria-hidden="true" /> Registrar danificação</button>} />
    {damages.length ? <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead><tr>
          <th>Data</th><th>Colaborador</th><th>EPI</th><th className={styles.numeric}>Qtd.</th>
          <th>Motivo</th><th>Decisão</th><th>Desdobramento</th>
        </tr></thead>
        <tbody>{damages.map((damage) => <tr key={damage.id}>
          <td>{dateLabel(damage.occurredOn)}</td>
          <td><strong>{damage.employeeName}</strong></td>
          <td><strong>{damage.epiName}</strong>{damage.replacementEpiName && <small>Substituído por {damage.replacementEpiName}</small>}</td>
          <td className={styles.numeric}>{damage.quantity}</td>
          <td>{epiDamageReasonLabels[damage.damageReason] ?? damage.damageReason}</td>
          <td>{pill(damage.decision, epiDamageDecisionLabels[damage.decision] ?? damage.decision)}</td>
          <td><small>
            {damage.discountRequestId ? "Demanda de desconto aberta" : damage.disposalId ? "Encaminhado ao descarte" : "Sem desdobramento"}
          </small></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={ArrowLeftRight} title="Nenhuma danificação registrada"
      text="Registre a ocorrência com a evidência e a decisão para manter a rastreabilidade da troca."
      action={permissions?.damage && <button className={styles.secondaryButton} onClick={onCreate}>Registrar danificação</button>} />}
  </>;
}

function ReturnsPanel({ returns, filters, onFilters, permissions, busy, onSanitize, onGoToDeliveries }: {
  returns: EpiReturn[]; filters: Record<string, string>; onFilters: (value: Record<string, string>) => void;
  permissions?: EpiOverview["permissions"]; busy: boolean;
  onSanitize: (item: EpiReturn, action: "start" | "complete") => void; onGoToDeliveries: () => void;
}) {
  return <>
    <PanelHeader eyebrow="DEVOLUÇÕES" title="EPIs devolvidos"
      description="A condição informada na devolução define o destino: estoque, higienização, descarte ou análise de desconto." />
    <FilterBar filters={filters} onFilters={onFilters} fields={[
      { name: "condition", label: "CONDIÇÃO", options: Object.entries(epiReturnConditionLabels) },
      { name: "sanitizing", label: "PENDENTE HIGIENIZAÇÃO", options: [["true", "Sim"]] },
      { name: "from", label: "DEVOLUÇÃO DE", type: "date" },
      { name: "to", label: "ATÉ", type: "date" },
    ]} />
    {returns.length ? <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead><tr>
          <th>Data</th><th>Colaborador</th><th>EPI</th><th className={styles.numeric}>Qtd.</th>
          <th>Condição</th><th>Destino</th><th aria-label="Ações" />
        </tr></thead>
        <tbody>{returns.map((item) => <tr key={item.id}>
          <td>{dateLabel(item.returnedOn)}</td>
          <td><strong>{item.employeeName}</strong></td>
          <td><strong>{item.epiName}</strong><small>CA {item.caNumber || "—"} · {item.size || "—"}</small></td>
          <td className={styles.numeric}>{item.quantity}</td>
          <td>{pill(item.condition, epiReturnConditionLabels[item.condition] ?? item.condition)}</td>
          <td><small>{[
            item.backToStock ? "Voltou ao estoque" : "",
            item.needsSanitizing ? "Higienização" : "",
            item.sendToDisposal ? "Descarte" : "",
            item.generateDpDemand ? "Demanda de desconto no DP" : "",
          ].filter(Boolean).join(" · ") || "Sem desdobramento"}</small></td>
          <td><div className={styles.rowActions}>
            {permissions?.receiveReturn && item.sanitizationStatus === "awaiting" && <button disabled={busy} onClick={() => onSanitize(item, "start")}>Iniciar higienização</button>}
            {permissions?.receiveReturn && ["awaiting", "in_progress"].includes(item.sanitizationStatus) && <button disabled={busy} onClick={() => onSanitize(item, "complete")}>Concluir e repor</button>}
          </div></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={Undo2} title="Nenhuma devolução registrada"
      text="A devolução parte da entrega: abra a aba de entregas e registre a devolução do EPI que está com o colaborador."
      action={<button className={styles.secondaryButton} onClick={onGoToDeliveries}>Ver entregas em aberto</button>} />}
  </>;
}

function DisposalsPanel({ disposals, disposable, filters, onFilters, permissions, onCreate, onDecide }: {
  disposals: EpiDisposal[]; disposable: DisposableProduct[]; filters: Record<string, string>;
  onFilters: (value: Record<string, string>) => void; permissions?: EpiOverview["permissions"];
  onCreate: (product?: DisposableProduct) => void;
  onDecide: (disposal: EpiDisposal, action: "confirm" | "cancel" | "reevaluate") => void;
}) {
  return <>
    <PanelHeader eyebrow="JANELA DE DESCARTE" title="Descarte de EPI"
      description="Confirmar é definitivo: o equipamento não volta ao estoque e o registro passa a ser imutável."
      action={permissions?.dispose && <button className={styles.primaryButton} onClick={() => onCreate()}><Trash2 aria-hidden="true" /> Abrir descarte</button>} />
    <FilterBar filters={filters} onFilters={onFilters} fields={[
      { name: "status", label: "STATUS", options: Object.entries(epiDisposalStatusLabels) },
      { name: "reason", label: "MOTIVO", options: Object.entries(epiDisposalReasonLabels) },
      { name: "from", label: "DE", type: "date" },
      { name: "to", label: "ATÉ", type: "date" },
    ]} />

    {disposable.length > 0 && <div className={styles.noticeBar}>
      <AlertTriangle aria-hidden="true" />
      <span>
        <strong>{disposable.length} EPI(s) em estado que pede descarte e sem registro aberto</strong>
        {disposable.slice(0, 3).map((item) => `${item.name} (${epiProductStatusLabels[item.status] ?? item.status})`).join(", ")}
        {disposable.length > 3 ? ` e mais ${disposable.length - 3}.` : "."}
        {permissions?.dispose && <> <button type="button" className={styles.ghostButton} onClick={() => onCreate(disposable[0])}>Abrir descarte</button></>}
      </span>
    </div>}

    {disposals.length ? <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead><tr>
          <th>Data</th><th>EPI</th><th>Colaborador</th><th className={styles.numeric}>Qtd.</th>
          <th>Motivo</th><th>Origem</th><th>Status</th><th aria-label="Ações" />
        </tr></thead>
        <tbody>{disposals.map((disposal) => <tr key={disposal.id}>
          <td>{dateLabel(disposal.disposalDate)}</td>
          <td><strong>{disposal.epiName}</strong><small>CA {disposal.caNumber || "—"} · {disposal.size || "—"}</small></td>
          <td>{disposal.employeeName || <small>Sem vínculo</small>}</td>
          <td className={styles.numeric}>{disposal.quantity}</td>
          <td>{epiDisposalReasonLabels[disposal.disposalReason] ?? disposal.disposalReason}</td>
          <td><small>{disposal.originType === "manual" ? "Estoque" : disposal.originType === "return" ? "Devolução" : "Troca por dano"}</small></td>
          <td>{pill(disposal.status, epiDisposalStatusLabels[disposal.status] ?? disposal.status)}</td>
          <td><div className={styles.rowActions}>
            {permissions?.dispose && disposal.status === "awaiting_disposal" && <>
              <button onClick={() => onDecide(disposal, "confirm")}><Trash2 aria-hidden="true" /> Confirmar</button>
              <button onClick={() => onDecide(disposal, "reevaluate")}>Reavaliar</button>
              <button className={styles.dangerButton} onClick={() => onDecide(disposal, "cancel")}>Cancelar</button>
            </>}
          </div></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={Trash2} title="Nenhum descarte na janela"
      text="Devoluções danificadas e trocas por dano chegam aqui automaticamente. Você também pode abrir um descarte a partir do estoque."
      action={permissions?.dispose && <button className={styles.secondaryButton} onClick={() => onCreate()}>Abrir descarte</button>} />}
  </>;
}

function DiscountsPanel({ discounts, filters, onFilters, permissions, onDecide }: {
  discounts: EpiDiscount[]; filters: Record<string, string>; onFilters: (value: Record<string, string>) => void;
  permissions?: EpiOverview["permissions"]; onDecide: (discount: EpiDiscount) => void;
}) {
  return <>
    <PanelHeader eyebrow="ANÁLISE DE DESCONTO" title="Casos abertos para o Departamento Pessoal"
      description="Cada caso tem uma demanda no quadro. O desconto nunca é lançado automaticamente: ele depende do parecer registrado aqui." />
    <FilterBar filters={filters} onFilters={onFilters} fields={[
      { name: "status", label: "STATUS", options: Object.entries(epiDiscountStatusLabels) },
      { name: "open", label: "SOMENTE EM ABERTO", options: [["true", "Sim"]] },
      { name: "from", label: "OCORRÊNCIA DE", type: "date" },
      { name: "to", label: "ATÉ", type: "date" },
    ]} />
    {discounts.length ? <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead><tr>
          <th>Ocorrência</th><th>Colaborador</th><th>EPI</th><th>Motivo</th>
          <th className={styles.numeric}>Em análise</th><th className={styles.numeric}>Decidido</th>
          <th>Status</th><th aria-label="Ações" />
        </tr></thead>
        <tbody>{discounts.map((discount) => <tr key={discount.id}>
          <td>{dateLabel(discount.occurredOn)}</td>
          <td><strong>{discount.employeeName}</strong><small>{discount.registrationNumber}</small></td>
          <td><strong>{discount.epiName}</strong><small>CA {discount.caNumber || "—"} · {discount.quantity} un.</small></td>
          <td><small>{epiDiscountTriggerLabels[discount.triggerReason] ?? discount.triggerReason}</small></td>
          <td className={styles.numeric}>{currency(discount.totalValue)}</td>
          <td className={styles.numeric}>{discount.decision ? currency(discount.decidedValue) : "—"}</td>
          <td>{pill(discount.status, epiDiscountStatusLabels[discount.status] ?? discount.status)}
            {discount.decision && <small>{epiDiscountDecisionLabels[discount.decision] ?? discount.decision}</small>}
            {discount.movementId && <small>Central de Movimentações · {discount.competence}</small>}</td>
          <td><div className={styles.rowActions}>
            {permissions?.analyzeDiscount && !["refused", "canceled", "finished"].includes(discount.status)
              && <button onClick={() => onDecide(discount)}><Scale aria-hidden="true" /> Decidir</button>}
          </div></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={Scale} title="Nenhum caso em análise"
      text="Extravio, não devolução e dano por uso inadequado abrem a demanda automaticamente. Nada aqui significa nenhum desconto pendente." />}
  </>;
}

function ReportsPanel({ catalog, report, reportKey, filters, onFilters, canExport, onOpen, onExport, onReload }: {
  catalog: ReportDefinition[]; report: ReportResult | null; reportKey: string;
  filters: Record<string, string>; onFilters: (value: Record<string, string>) => void;
  canExport: boolean; onOpen: (key: string) => void; onExport: () => void; onReload: () => void;
}) {
  if (!catalog.length) {
    return <EmptyState icon={ClipboardList} title="Relatórios indisponíveis"
      text="Não foi possível carregar o catálogo de relatórios. Atualize a tela para tentar novamente."
      action={<button className={styles.secondaryButton} onClick={onReload}><RefreshCw aria-hidden="true" /> Atualizar</button>} />;
  }
  return <div className={styles.reportLayout}>
    <nav className={styles.reportPicker} aria-label="Relatórios do Controle de EPI">
      {catalog.map((item) => <button key={item.key} type="button" className={item.key === reportKey ? styles.activeReport : ""}
        onClick={() => onOpen(item.key)} aria-current={item.key === reportKey ? "true" : undefined}>
        <strong>{item.title}</strong><small>{item.description}</small>
      </button>)}
    </nav>
    <div>
      <PanelHeader eyebrow="RELATÓRIO" title={report?.title ?? "Selecione um relatório"}
        description={report?.description ?? "Escolha um relatório à esquerda para ver os dados do período."}
        action={report && canExport && <button className={styles.secondaryButton} onClick={onExport}>
          <Download aria-hidden="true" /> Exportar CSV
        </button>} />
      <FilterBar filters={filters} onFilters={onFilters} fields={[
        { name: "from", label: "DE", type: "date" },
        { name: "to", label: "ATÉ", type: "date" },
      ]} onApply={onReload} />
      {report && report.rows.length ? <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead><tr>{report.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
          <tbody>{report.rows.map((row, index) => <tr key={index}>
            {report.columns.map((column) => <td key={column.key}>{formatCell(row[column.key])}</td>)}
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState icon={ClipboardList} title="Nenhum dado no período"
        text="Ajuste o período ou a empresa selecionada. O relatório respeita as empresas às quais você tem acesso." />}
      {!canExport && report && <p className={styles.fieldHint}>
        A exportação exige a permissão epi.export. Peça ao administrador do grupo se precisar levar estes dados para fora do produto.
      </p>}
    </div>
  </div>;
}

function formatCell(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(text)) return dateLabel(text);
  const labels: Record<string, string> = {
    ...epiProductStatusLabels, ...epiRegistrationReasonLabels, ...epiDeliveryStatusLabels,
    ...epiReturnConditionLabels, ...epiDamageReasonLabels, ...epiDamageDecisionLabels,
    ...epiDisposalReasonLabels, ...epiDisposalStatusLabels, ...epiDiscountStatusLabels,
    ...epiDiscountDecisionLabels, ...epiDiscountTriggerLabels, ...epiTypeLabels, ...epiComplianceStatusLabels,
  };
  return labels[text] ?? text;
}

function FilterBar({ filters, onFilters, fields, onApply }: {
  filters: Record<string, string>;
  onFilters: (value: Record<string, string>) => void;
  fields: Array<{ name: string; label: string; type?: "text" | "date"; options?: Array<[string, string]> }>;
  onApply?: () => void;
}) {
  return <div className={styles.filterBar}>
    {fields.map((field) => <label key={field.name}>
      <span>{field.label}</span>
      {field.options
        ? <select value={filters[field.name] ?? ""} onChange={(event) => onFilters({ ...filters, [field.name]: event.target.value })}>
          <option value="">Todos</option>
          {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        : <input type={field.type ?? "text"} value={filters[field.name] ?? ""}
          onChange={(event) => onFilters({ ...filters, [field.name]: event.target.value })} />}
    </label>)}
    {(Object.values(filters).some(Boolean) || onApply) && <button type="button" className={styles.ghostButton}
      onClick={() => { if (onApply) onApply(); else onFilters({}); }}>
      {onApply ? "Aplicar período" : "Limpar filtros"}
    </button>}
  </div>;
}

function dialogRequest(editor: NonNullable<EpiEditor>, payload: Record<string, unknown>) {
  switch (editor.kind) {
    case "product":
      return editor.product
        ? { url: `/api/epi/products/${editor.product.id}`, method: "PATCH", success: "Cadastro de EPI atualizado." }
        : { url: "/api/epi/products", method: "POST", success: "EPI cadastrado e estoque registrado." };
    case "delivery":
      return { url: "/api/epi/deliveries", method: "POST", success: "Entrega registrada e estoque atualizado." };
    case "return":
      return { url: "/api/epi/returns", method: "POST", success: "Devolução registrada com o destino do equipamento." };
    case "damage":
      return { url: "/api/epi/damages", method: "POST", success: "Danificação registrada com a decisão tomada." };
    case "disposal":
      return { url: "/api/epi/disposals", method: "POST", success: "Descarte aberto e aguardando confirmação." };
    case "disposal-decision":
      return {
        url: `/api/epi/disposals/${editor.disposal.id}`, method: "POST",
        success: payload.action === "confirm" ? "Descarte confirmado." : payload.action === "cancel" ? "Descarte cancelado." : "Equipamento enviado para reavaliação.",
      };
    case "discount":
      return { url: `/api/epi/discounts/${editor.discount.id}`, method: "POST", success: "Decisão registrada na análise e na demanda." };
  }
}
