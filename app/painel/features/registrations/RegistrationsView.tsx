"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Briefcase, Building2,
  Check,
  ChevronRight,
  CircleAlert,
  Edit3,
  Factory,
  FileSpreadsheet,
  History,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UserRound,
  UserMinus,
  UsersRound,
  Trash2,
  X,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { EmptyState, ErrorBanner, LoadingState, PageSkeleton, StatusPill } from "../shared";
import { ContractorsPanel } from "./ContractorsPanel";
import { EmployeeEpiPanel } from "../epi";
import { SankhyaImportDialog } from "./SankhyaImportDialog";
import styles from "./registrations.module.css";
import type {
  CatalogItem,
  CatalogResource,
  Company,
  CompanyDraft,
  Employee,
  EmployeeDetailTab,
  EmployeeDraft,
  HistoryEvent,
  RegistrationTab,
} from "./registrations.types";

type JsonRecord = Record<string, unknown>;
type CatalogMap = Record<CatalogResource, CatalogItem[]>;

const catalogMeta: Record<CatalogResource, { label: string; singular: string; description: string }> = {
  departments: { label: "Departamentos", singular: "Departamento", description: "Estrutura de times e áreas" },
  positions: { label: "Cargos", singular: "Cargo", description: "Funções e códigos CBO" },
  "cost-centers": { label: "Centros de custo", singular: "Centro de custo", description: "Alocação contábil da operação" },
  "work-schedules": { label: "Jornadas", singular: "Jornada", description: "Cargas horárias e escalas" },
};

const emptyCompany: CompanyDraft = {
  companyType: "branch", parentCompanyId: null, legalName: "", tradeName: "", taxId: "", externalCode: "", email: "", phone: "",
  status: "active", taxRegime: "", stateRegistration: "", municipalRegistration: "", postalCode: "", street: "", streetNumber: "",
  addressComplement: "", district: "", city: "", state: "", country: "Brasil",
};

const emptyEmployee: EmployeeDraft = {
  companyId: "", registrationNumber: "", fullName: "", socialName: "", cpf: "", departmentId: "", positionId: "", costCenterId: "",
  workScheduleId: "", admissionDate: "", birthDate: "", terminationDate: "", employmentStatus: "active", employmentType: "clt",
  workModel: "onsite", email: "", phone: "", notes: "",
};

function text(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value); }
function nullable(value: unknown) { const result = text(value); return result || null; }
function key(raw: JsonRecord, camel: string, snake: string) { return raw[camel] ?? raw[snake]; }

function normalizeCompany(raw: JsonRecord): Company {
  return {
    id: text(raw.id), parentCompanyId: nullable(key(raw, "parentCompanyId", "parent_company_id")),
    isPrincipal: Boolean(key(raw, "isPrincipal", "is_principal")), legalName: text(key(raw, "legalName", "legal_name")),
    tradeName: text(key(raw, "tradeName", "trade_name")), taxId: text(key(raw, "taxId", "tax_id")),
    externalCode: text(key(raw, "externalCode", "external_code")), email: text(raw.email), phone: text(raw.phone),
    status: raw.status === "inactive" ? "inactive" : "active", taxRegime: text(key(raw, "taxRegime", "tax_regime")),
    stateRegistration: text(key(raw, "stateRegistration", "state_registration")), municipalRegistration: text(key(raw, "municipalRegistration", "municipal_registration")),
    postalCode: text(key(raw, "postalCode", "postal_code")), street: text(raw.street), streetNumber: text(key(raw, "streetNumber", "street_number")),
    addressComplement: text(key(raw, "addressComplement", "address_complement")), district: text(raw.district), city: text(raw.city),
    state: text(raw.state), country: text(raw.country) || "Brasil",
  };
}

function normalizeEmployee(raw: JsonRecord): Employee {
  const status = key(raw, "employmentStatus", "employment_status");
  const employmentType = key(raw, "employmentType", "employment_type");
  const workModel = key(raw, "workModel", "work_model");
  return {
    id: text(raw.id), companyId: text(key(raw, "companyId", "company_id")), companyName: text(key(raw, "companyName", "company_name")),
    departmentId: nullable(key(raw, "departmentId", "department_id")), departmentName: text(key(raw, "departmentName", "department_name")),
    positionId: nullable(key(raw, "positionId", "position_id")), positionName: text(key(raw, "positionName", "position_name")),
    costCenterId: nullable(key(raw, "costCenterId", "cost_center_id")), costCenterName: text(key(raw, "costCenterName", "cost_center_name")),
    workScheduleId: nullable(key(raw, "workScheduleId", "work_schedule_id")), workScheduleName: text(key(raw, "workScheduleName", "work_schedule_name")),
    managerEmployeeId: nullable(key(raw, "managerEmployeeId", "manager_employee_id")), registrationNumber: text(key(raw, "registrationNumber", "registration_number")),
    fullName: text(key(raw, "fullName", "full_name")), socialName: text(key(raw, "socialName", "social_name")), cpfLast4: text(key(raw, "cpfLast4", "cpf_last4")),
    email: text(raw.email), phone: text(raw.phone), birthDate: text(key(raw, "birthDate", "birth_date")), admissionDate: text(key(raw, "admissionDate", "admission_date")),
    terminationDate: text(key(raw, "terminationDate", "termination_date")), employmentStatus: status === "on_leave" || status === "terminated" ? status : "active",
    employmentType: employmentType === "intern" || employmentType === "apprentice" || employmentType === "temporary" ? employmentType : "clt",
    workModel: workModel === "hybrid" || workModel === "remote" ? workModel : "onsite",
    sourceSystem: key(raw, "sourceSystem", "source_system") === "solides" ? "solides" : key(raw, "sourceSystem", "source_system") === "sankhya" ? "sankhya" : "manual",
    externalId: text(key(raw, "externalId", "external_id")), notes: text(raw.notes), createdAt: text(key(raw, "createdAt", "created_at")), updatedAt: text(key(raw, "updatedAt", "updated_at")),
  };
}

function normalizeCatalog(raw: JsonRecord): CatalogItem {
  return {
    id: text(raw.id), companyId: text(key(raw, "companyId", "company_id")), code: text(raw.code), name: text(raw.name), status: raw.status === "inactive" ? "inactive" : "active",
    cboCode: text(key(raw, "cboCode", "cbo_code")), weeklyHours: Number(key(raw, "weeklyHours", "weekly_hours")) || null,
    description: text(raw.description), parentDepartmentId: nullable(key(raw, "parentDepartmentId", "parent_department_id")),
  };
}

function parseJson(value: unknown) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as JsonRecord;
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : null; }
  catch { return null; }
}

function normalizeHistory(raw: JsonRecord): HistoryEvent {
  return { id: text(raw.id), actorEmail: text(key(raw, "actorEmail", "actor_email")), action: text(raw.action), before: parseJson(key(raw, "before", "before_json")), after: parseJson(key(raw, "after", "after_json")), metadata: parseJson(key(raw, "metadata", "metadata_json")), createdAt: text(key(raw, "createdAt", "created_at")) };
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!(options?.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, cache: "no-store", headers });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function displayCompany(company: Company) { return company.tradeName || company.legalName; }
function dateLabel(value: string) { if (!value) return "Não informado"; const date = new Date(value.includes("T") ? value : `${value}T12:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(date); }
function initials(value: string) { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "DP"; }
function statusLabel(status: Employee["employmentStatus"]) { return status === "on_leave" ? "Afastado" : status === "terminated" ? "Desligado" : "Ativo"; }
function historyLabel(action: string) { return action.endsWith(".created") ? "Cadastro criado" : action.endsWith(".updated") ? "Dados atualizados" : action.endsWith(".inactivated") ? "Cadastro inativado" : action.replaceAll(".", " · "); }

export function RegistrationsView({ role }: { role: WorkspaceRole }) {
  const canManageCompanies = false;
  const canManageRegistrations = role === "admin" || role === "member";
  const [tab, setTab] = useState<RegistrationTab>("employees");
  // Contador, não booleano: dois cliques seguidos no mesmo botão precisam
  // reabrir o formulário, e um booleano já ligado não avisaria a segunda vez.
  const [contractorCreateSignal, setContractorCreateSignal] = useState(0);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [employeeStatus, setEmployeeStatus] = useState("all");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employeeSearchQuery, setEmployeeSearchQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState("");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [catalogResource, setCatalogResource] = useState<CatalogResource>("departments");
  const [catalogs, setCatalogs] = useState<CatalogMap>({ departments: [], positions: [], "cost-centers": [], "work-schedules": [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogEditor, setCatalogEditor] = useState<CatalogItem | "new" | null>(null);
  const [companyEditor, setCompanyEditor] = useState<Company | "new" | null>(null);
  const [employeeEditor, setEmployeeEditor] = useState<Employee | "new" | null>(null);
  const [employeeImportOpen, setEmployeeImportOpen] = useState(false);
  const [employeeEditing, setEmployeeEditing] = useState(false);
  const [employeeDetailTab, setEmployeeDetailTab] = useState<EmployeeDetailTab>("personal");
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ title: string; description: string; confirmLabel?: string; run: () => Promise<void> } | null>(null);

  const selectedCompany = companies.find((company) => company.id === selectedCompanyId) ?? companies[0] ?? null;
  const visibleEmployees = useMemo(() => {
    const query = employeeSearch.trim().toLocaleLowerCase("pt-BR");
    if (!query) return employees;
    return employees.filter((employee) => [employee.fullName, employee.socialName, employee.registrationNumber, employee.positionName].some((value) => value.toLocaleLowerCase("pt-BR").includes(query)));
  }, [employeeSearch, employees]);

  const loadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    try {
      const payload = await requestJson<{ companies?: JsonRecord[] }>("/api/companies");
      const next = (payload.companies ?? []).map(normalizeCompany);
      setCompanies(next);
      setSelectedCompanyId((current) => next.some((company) => company.id === current) ? current : next.find((company) => company.status === "active")?.id ?? next[0]?.id ?? "");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar empresas."); }
    finally { setCompaniesLoading(false); }
  }, []);

  const loadEmployees = useCallback(async () => {
    setEmployeesLoading(true);
    try {
      const params = new URLSearchParams({ limit: "30" });
      if (selectedCompanyId) params.set("companyId", selectedCompanyId);
      if (employeeStatus !== "all") params.set("status", employeeStatus);
      if (employeeSearchQuery) params.set("search", employeeSearchQuery);
      if (cursor) params.set("cursor", cursor);
      const payload = await requestJson<{ employees?: JsonRecord[]; nextCursor?: string | null }>(`/api/employees?${params}`);
      setEmployees((payload.employees ?? []).map(normalizeEmployee));
      setNextCursor(payload.nextCursor ?? null);
      setError("");
    } catch (cause) { setEmployees([]); setError(cause instanceof Error ? cause.message : "Erro ao carregar colaboradores."); }
    finally { setEmployeesLoading(false); }
  }, [cursor, employeeSearchQuery, employeeStatus, selectedCompanyId]);

  const loadCatalog = useCallback(async (resource: CatalogResource, companyId: string) => {
    if (!companyId) return;
    setCatalogLoading(true);
    try {
      const payload = await requestJson<{ items?: JsonRecord[] }>(`/api/registrations/catalogs/${resource}?companyId=${encodeURIComponent(companyId)}`);
      setCatalogs((current) => ({ ...current, [resource]: (payload.items ?? []).map(normalizeCatalog) }));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar cadastros auxiliares."); }
    finally { setCatalogLoading(false); }
  }, []);

  useEffect(() => { const frame = window.requestAnimationFrame(() => { void loadCompanies(); }); return () => window.cancelAnimationFrame(frame); }, [loadCompanies]);
  useEffect(() => { if (tab !== "employees") return; const frame = window.requestAnimationFrame(() => { void loadEmployees(); }); return () => window.cancelAnimationFrame(frame); }, [loadEmployees, tab]);
  useEffect(() => { if (tab !== "catalogs" || !selectedCompanyId) return; const frame = window.requestAnimationFrame(() => { void loadCatalog(catalogResource, selectedCompanyId); }); return () => window.cancelAnimationFrame(frame); }, [catalogResource, loadCatalog, selectedCompanyId, tab]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(""), 3500); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setEmployeeSearchQuery(employeeSearch.trim());
      setCursor("");
      setCursorHistory([]);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [employeeSearch]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setCompanyEditor(null); setCatalogEditor(null); setEmployeeEditor(null); setEmployeeImportOpen(false); setConfirmAction(null); } };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function loadEmployeeCatalogs(companyId: string) {
    await Promise.all((Object.keys(catalogMeta) as CatalogResource[]).map((resource) => loadCatalog(resource, companyId)));
  }

  function openEmployee(employee: Employee | "new") {
    setEmployeeEditor(employee);
    setEmployeeEditing(employee === "new");
    setEmployeeDetailTab("personal");
    setHistory([]);
    const companyId = employee === "new" ? selectedCompanyId : employee.companyId;
    if (companyId) void loadEmployeeCatalogs(companyId);
  }

  async function openHistory(employee: Employee) {
    setEmployeeDetailTab("history");
    if (history.length) return;
    setHistoryLoading(true);
    try {
      const payload = await requestJson<{ events?: JsonRecord[] }>(`/api/employees/${employee.id}/history`);
      setHistory((payload.events ?? []).map(normalizeHistory));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar histórico."); }
    finally { setHistoryLoading(false); }
  }

  function contextualCreate() {
    if (tab === "companies" && !canManageCompanies) { setToast("Somente administradores podem alterar a estrutura empresarial."); return; }
    if (tab !== "companies" && !canManageRegistrations) { setToast("Seu perfil possui acesso somente para consulta."); return; }
    if (tab === "companies") setCompanyEditor("new");
    if (tab === "employees") openEmployee("new");
    if (tab === "catalogs") setCatalogEditor("new");
    if (tab === "contractors") setContractorCreateSignal((current) => current + 1);
  }

  function selectCompany(id: string) { setSelectedCompanyId(id); setCursor(""); setCursorHistory([]); }
  function selectEmployeeStatus(status: string) { setEmployeeStatus(status); setCursor(""); setCursorHistory([]); }

  async function inactivateCompany(company: Company) {
    setBusy(true);
    try {
      await requestJson(`/api/companies/${company.id}`, { method: "DELETE" });
      setToast("Empresa inativada com segurança."); setCompanyEditor(null); await loadCompanies();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível inativar a empresa."); }
    finally { setBusy(false); setConfirmAction(null); }
  }

  async function inactivateCatalog(item: CatalogItem) {
    setBusy(true);
    try {
      await requestJson(`/api/registrations/catalogs/${catalogResource}/${item.id}`, { method: "DELETE" });
      setToast(`${catalogMeta[catalogResource].singular} inativado.`); setCatalogEditor(null); await loadCatalog(catalogResource, selectedCompanyId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível inativar o cadastro."); }
    finally { setBusy(false); setConfirmAction(null); }
  }

  async function terminateEmployee(employee: Employee, terminationDate: string) {
    setBusy(true);
    try {
      await requestJson(`/api/employees/${employee.id}/terminate`, { method: "POST", body: JSON.stringify({ terminationDate }) });
      setToast("Demissão registrada e histórico preservado."); setEmployeeEditor(null); await loadEmployees();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registrar a demissão."); }
    finally { setBusy(false); setConfirmAction(null); }
  }

  async function deleteEmployee(employee: Employee) {
    setBusy(true);
    try {
      await requestJson(`/api/employees/${employee.id}`, { method: "DELETE" });
      setToast("Colaborador excluído."); setEmployeeEditor(null); await loadEmployees();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível excluir o colaborador."); }
    finally { setBusy(false); setConfirmAction(null); }
  }

  function goNext() { if (!nextCursor) return; setCursorHistory((items) => [...items, cursor]); setCursor(nextCursor); }
  function goBack() { const previous = cursorHistory.at(-1); if (previous === undefined) return; setCursorHistory((items) => items.slice(0, -1)); setCursor(previous); }

  return (
    <section className={styles.root} aria-label="Cadastros operacionais">
      <header className={styles.commandBar}>
        <nav className={styles.tabs} aria-label="Áreas de cadastro">
          <button className={tab === "employees" ? styles.activeTab : ""} onClick={() => setTab("employees")}><UsersRound aria-hidden="true" /> Colaboradores</button>
          <button className={tab === "contractors" ? styles.activeTab : ""} onClick={() => setTab("contractors")}><Briefcase aria-hidden="true" /> Prestadores PJ</button>
          <button className={tab === "catalogs" ? styles.activeTab : ""} onClick={() => setTab("catalogs")}><SlidersHorizontal aria-hidden="true" /> Cadastros auxiliares</button>
        </nav>
        <div className={styles.commandActions}>{tab === "employees" && canManageRegistrations && <button className={styles.secondaryButton} onClick={() => setEmployeeImportOpen(true)} disabled={companiesLoading || !companies.length}><FileSpreadsheet aria-hidden="true" /> Importar Sankhya</button>}<button className={styles.primaryButton} onClick={contextualCreate} disabled={companiesLoading}><Plus aria-hidden="true" /> {tab === "employees" ? "Novo colaborador" : tab === "contractors" ? "Novo prestador" : `Novo ${catalogMeta[catalogResource].singular.toLowerCase()}`}</button></div>
      </header>

      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      {tab === "companies" && (
        <CompaniesPanel companies={companies} loading={companiesLoading} selected={selectedCompany} onSelect={selectCompany} onEdit={(company) => setCompanyEditor(company)} onCreate={contextualCreate} onRefresh={loadCompanies} canManage={canManageCompanies} />
      )}

      {tab === "employees" && (
        <EmployeesPanel companies={companies} companyId={selectedCompanyId} onCompanyChange={selectCompany} status={employeeStatus} onStatusChange={selectEmployeeStatus}
          query={employeeSearch} onQueryChange={setEmployeeSearch} employees={visibleEmployees} loading={employeesLoading} onOpen={openEmployee} onCreate={contextualCreate}
          canManage={canManageRegistrations} canBack={cursorHistory.length > 0} canNext={Boolean(nextCursor)} onBack={goBack} onNext={goNext} />
      )}

      {tab === "contractors" && (
        <ContractorsPanel canManage={canManageRegistrations} createSignal={contractorCreateSignal} />
      )}

      {tab === "catalogs" && (
        <CatalogsPanel companies={companies} companyId={selectedCompanyId} onCompanyChange={selectCompany} resource={catalogResource} onResourceChange={setCatalogResource}
          items={catalogs[catalogResource]} loading={catalogLoading} onEdit={setCatalogEditor} onCreate={contextualCreate} canManage={canManageRegistrations} />
      )}

      {companyEditor && <CompanyEditor company={companyEditor === "new" ? null : companyEditor} companies={companies} busy={busy} onClose={() => setCompanyEditor(null)} onSaved={async () => { setCompanyEditor(null); setToast(companyEditor === "new" ? "Empresa criada." : "Empresa atualizada."); await loadCompanies(); }} onBusy={setBusy} onError={setError} onInactivate={(company) => setConfirmAction({ title: "Inativar empresa?", description: `${displayCompany(company)} deixará de aparecer nos fluxos ativos. O histórico será preservado.`, run: () => inactivateCompany(company) })} />}

      {catalogEditor && selectedCompany && <CatalogEditor resource={catalogResource} item={catalogEditor === "new" ? null : catalogEditor} company={selectedCompany} busy={busy} onClose={() => setCatalogEditor(null)} onBusy={setBusy} onError={setError} onSaved={async () => { setCatalogEditor(null); setToast(`${catalogMeta[catalogResource].singular} salvo.`); await loadCatalog(catalogResource, selectedCompanyId); }} onInactivate={(item) => setConfirmAction({ title: `Inativar ${catalogMeta[catalogResource].singular.toLowerCase()}?`, description: "O item deixa de estar disponível para novas alocações, sem apagar vínculos existentes.", run: () => inactivateCatalog(item) })} />}

      {employeeEditor && <EmployeeDrawer employee={employeeEditor === "new" ? null : employeeEditor} companies={companies} catalogs={catalogs} busy={busy} editing={employeeEditing} activeTab={employeeDetailTab}
        history={history} historyLoading={historyLoading} canManage={canManageRegistrations} onTab={(next) => { if (next === "history" && employeeEditor !== "new") void openHistory(employeeEditor); else setEmployeeDetailTab(next); }}
        onCompanyCatalogs={loadEmployeeCatalogs} onEdit={() => setEmployeeEditing(true)} onClose={() => setEmployeeEditor(null)} onBusy={setBusy} onError={setError}
        onTerminate={(employee, terminationDate) => setConfirmAction({ title: "Confirmar demissão?", description: `${employee.fullName} será marcado como desligado em ${dateLabel(terminationDate)}. O histórico e os vínculos de EPI serão preservados.`, confirmLabel: "Confirmar demissão", run: () => terminateEmployee(employee, terminationDate) })}
        onDelete={(employee) => setConfirmAction({ title: "Excluir colaborador?", description: `${employee.fullName} será removido definitivamente apenas se não possuir histórico operacional. Se houver vínculos, o sistema bloqueará a exclusão.`, confirmLabel: "Excluir", run: () => deleteEmployee(employee) })}
        onSaved={async (saved) => { setEmployeeEditor(saved); setEmployeeEditing(false); setToast(employeeEditor === "new" ? "Colaborador cadastrado." : "Colaborador atualizado."); await loadEmployees(); }} />}

      {employeeImportOpen && <SankhyaImportDialog companies={companies} initialCompanyId={selectedCompanyId} onClose={() => setEmployeeImportOpen(false)} onImported={async (message) => { setEmployeeImportOpen(false); setToast(message); await loadEmployees(); }} />}

      {confirmAction && <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmAction(null); }}><section className={styles.confirm} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><span className={styles.confirmIcon}><CircleAlert /></span><h2 id="confirm-title">{confirmAction.title}</h2><p>{confirmAction.description}</p><div><button className={styles.secondaryButton} onClick={() => setConfirmAction(null)}>Cancelar</button><button className={styles.dangerButton} disabled={busy} onClick={() => void confirmAction.run()}>{busy ? <LoaderCircle className={styles.spin} /> : null} {confirmAction.confirmLabel ?? "Inativar"}</button></div></section></div>}
      {toast && <div className={styles.toast} role="status"><Check aria-hidden="true" /> {toast}</div>}
    </section>
  );
}

function CompaniesPanel({ companies, loading, selected, onSelect, onEdit, onCreate, onRefresh, canManage }: { companies: Company[]; loading: boolean; selected: Company | null; onSelect: (id: string) => void; onEdit: (company: Company) => void; onCreate: () => void; onRefresh: () => Promise<void>; canManage: boolean }) {
  if (loading) return <PageSkeleton label="Organizando a estrutura empresarial" metrics={0} rows={6} />;
  if (!companies.length) return <EmptyState icon={Building2} title="Sua estrutura começa aqui" text="Cadastre a empresa principal e, depois, seus estabelecimentos e filiais." action={<button className={styles.secondaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Cadastrar empresa</button>} />;
  return <div className={styles.masterDetail}>
    <section className={styles.masterPane} aria-label="Empresas e estabelecimentos">
      <header><div><span>ESTRUTURA DO GRUPO</span><strong>{companies.filter((item) => item.status === "active").length} ativos</strong></div><button aria-label="Atualizar lista" onClick={() => void onRefresh()}><RefreshCw /></button></header>
      <div className={styles.companyList}>{companies.map((company) => <button key={company.id} className={`${styles.companyRow} ${selected?.id === company.id ? styles.selectedRow : ""}`} onClick={() => onSelect(company.id)}>
        <span className={company.isPrincipal ? styles.principalMark : styles.branchMark}>{company.isPrincipal ? <Building2 /> : <Factory />}</span>
        <span><strong>{displayCompany(company)}</strong><small>{company.isPrincipal ? "Empresa principal" : "Estabelecimento / filial"} · {company.taxId || "CNPJ não informado"}</small></span>
        {activePill(company.status === "active")}<ChevronRight aria-hidden="true" />
      </button>)}</div>
    </section>
    {selected && <article className={styles.detailPane}>
      <header><div className={styles.companyIdentity}><span>{initials(displayCompany(selected))}</span><div><small>{selected.isPrincipal ? "EMPRESA PRINCIPAL" : "ESTABELECIMENTO"}</small><h2>{displayCompany(selected)}</h2><p>{selected.legalName}</p></div></div>{canManage && <button className={styles.secondaryButton} onClick={() => onEdit(selected)}><Edit3 /> Editar</button>}</header>
      <div className={styles.detailBand}><div><span>Situação</span>{activePill(selected.status === "active")}</div><div><span>CNPJ</span><strong>{selected.taxId || "Não informado"}</strong></div><div><span>Código externo</span><strong>{selected.externalCode || "—"}</strong></div></div>
      <section className={styles.detailSection}><h3><BadgeCheck /> Dados fiscais</h3><dl><div><dt>Regime tributário</dt><dd>{selected.taxRegime || "Não informado"}</dd></div><div><dt>Inscrição estadual</dt><dd>{selected.stateRegistration || "Não informado"}</dd></div><div><dt>Inscrição municipal</dt><dd>{selected.municipalRegistration || "Não informado"}</dd></div></dl></section>
      <section className={styles.detailSection}><h3><MapPin /> Endereço e contato</h3><dl><div><dt>Localidade</dt><dd>{[selected.city, selected.state].filter(Boolean).join(" / ") || "Não informado"}</dd></div><div><dt>Endereço</dt><dd>{[selected.street, selected.streetNumber, selected.district].filter(Boolean).join(", ") || "Não informado"}</dd></div><div><dt>Contato</dt><dd>{selected.email || selected.phone || "Não informado"}</dd></div></dl></section>
    </article>}
  </div>;
}

function EmployeesPanel({ companies, companyId, onCompanyChange, status, onStatusChange, query, onQueryChange, employees, loading, onOpen, onCreate, canManage, canBack, canNext, onBack, onNext }: { companies: Company[]; companyId: string; onCompanyChange: (id: string) => void; status: string; onStatusChange: (status: string) => void; query: string; onQueryChange: (query: string) => void; employees: Employee[]; loading: boolean; onOpen: (employee: Employee | "new") => void; onCreate: () => void; canManage: boolean; canBack: boolean; canNext: boolean; onBack: () => void; onNext: () => void }) {
  return <section className={styles.dataPanel}>
    <header className={styles.filters}><label className={styles.searchField}><Search /><span className={styles.srOnly}>Buscar colaborador</span><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Buscar por nome ou matrícula" /></label><label><span>Empresa</span><select value={companyId} onChange={(event) => onCompanyChange(event.target.value)}>{companies.filter((company) => company.status === "active").map((company) => <option key={company.id} value={company.id}>{displayCompany(company)}</option>)}</select></label><label><span>Status</span><select value={status} onChange={(event) => onStatusChange(event.target.value)}><option value="all">Todos</option><option value="active">Ativos</option><option value="on_leave">Afastados</option><option value="terminated">Desligados</option></select></label></header>
    {loading ? <LoadingState title="Carregando colaboradores" /> : employees.length ? <><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Colaborador</th><th>Matrícula</th><th>Lotação</th><th>Admissão</th><th>Status</th><th><span className={styles.srOnly}>Abrir</span></th></tr></thead><tbody>{employees.map((employee) => <tr key={employee.id} onClick={() => onOpen(employee)}><td data-label="Colaborador"><div className={styles.personCell}><span>{initials(employee.socialName || employee.fullName)}</span><div><strong>{employee.socialName || employee.fullName}</strong><small>{employee.positionName || "Cargo não informado"}</small></div></div></td><td data-label="Matrícula"><strong className={styles.mono}>{employee.registrationNumber}</strong></td><td data-label="Lotação"><span>{employee.departmentName || "Sem departamento"}</span><small>{employee.companyName}</small></td><td data-label="Admissão">{dateLabel(employee.admissionDate)}</td><td data-label="Status">{employeePill(employee.employmentStatus)}</td><td><button aria-label={`Abrir ${employee.fullName}`}><ChevronRight /></button></td></tr>)}</tbody></table></div><footer className={styles.pagination}><span>{employees.length} registro(s) nesta página</span><div><button onClick={onBack} disabled={!canBack}><ArrowLeft /> Anterior</button><button onClick={onNext} disabled={!canNext}>Próxima <ArrowRight /></button></div></footer></> : <EmptyState icon={UsersRound} title={query ? "Nenhum colaborador encontrado" : "Nenhum colaborador nesta seleção"} text={query ? "Revise o termo buscado nesta página." : "Cadastre manualmente apenas admissões já concluídas na origem."} action={canManage ? <button className={styles.secondaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Novo colaborador</button> : undefined} />}
  </section>;
}

function CatalogsPanel({ companies, companyId, onCompanyChange, resource, onResourceChange, items, loading, onEdit, onCreate, canManage }: { companies: Company[]; companyId: string; onCompanyChange: (id: string) => void; resource: CatalogResource; onResourceChange: (resource: CatalogResource) => void; items: CatalogItem[]; loading: boolean; onEdit: (item: CatalogItem) => void; onCreate: () => void; canManage: boolean }) {
  return <div className={styles.catalogLayout}><aside className={styles.catalogNav}><label><span>EMPRESA</span><select value={companyId} onChange={(event) => onCompanyChange(event.target.value)}>{companies.filter((company) => company.status === "active").map((company) => <option key={company.id} value={company.id}>{displayCompany(company)}</option>)}</select></label>{(Object.keys(catalogMeta) as CatalogResource[]).map((keyName) => <button key={keyName} className={resource === keyName ? styles.catalogActive : ""} onClick={() => onResourceChange(keyName)}><span><strong>{catalogMeta[keyName].label}</strong><small>{catalogMeta[keyName].description}</small></span><ChevronRight /></button>)}</aside><section className={styles.dataPanel}><header className={styles.catalogHeader}><div><span>CADASTRO AUXILIAR</span><h2>{catalogMeta[resource].label}</h2><p>{catalogMeta[resource].description}.</p></div>{canManage && <button className={styles.secondaryButton} onClick={onCreate}><Plus /> Adicionar</button>}</header>{loading ? <LoadingState title={`Carregando ${catalogMeta[resource].label.toLowerCase()}`} /> : items.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Código</th><th>Nome</th>{resource === "positions" && <th>CBO</th>}{resource === "work-schedules" && <th>Carga semanal</th>}<th>Status</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id} onClick={() => canManage && onEdit(item)}><td data-label="Código"><strong className={styles.mono}>{item.code}</strong></td><td data-label="Nome"><strong>{item.name}</strong>{item.description && <small>{item.description}</small>}</td>{resource === "positions" && <td data-label="CBO">{item.cboCode || "—"}</td>}{resource === "work-schedules" && <td data-label="Carga semanal">{item.weeklyHours ? `${item.weeklyHours}h` : "—"}</td>}<td data-label="Status">{activePill(item.status === "active")}</td><td><button aria-label={`Editar ${item.name}`} disabled={!canManage}><ChevronRight /></button></td></tr>)}</tbody></table></div> : <EmptyState icon={SlidersHorizontal} title={`Nenhum ${catalogMeta[resource].singular.toLowerCase()} cadastrado`} text="Crie o primeiro item para organizar a lotação dos colaboradores." action={canManage ? <button className={styles.secondaryButton} onClick={onCreate}><Plus aria-hidden="true" /> Adicionar cadastro</button> : undefined} />}</section></div>;
}

function CompanyEditor({ company, companies, busy, onClose, onSaved, onBusy, onError, onInactivate }: { company: Company | null; companies: Company[]; busy: boolean; onClose: () => void; onSaved: () => Promise<void>; onBusy: (value: boolean) => void; onError: (value: string) => void; onInactivate: (company: Company) => void }) {
  const [draft, setDraft] = useState<CompanyDraft>(() => company ? { ...company, companyType: company.isPrincipal ? "principal" : "branch" } : { ...emptyCompany, parentCompanyId: companies.find((item) => item.isPrincipal)?.id ?? null });
  function update<K extends keyof CompanyDraft>(field: K, value: CompanyDraft[K]) { setDraft((current) => ({ ...current, [field]: value })); }
  async function submit(event: FormEvent) { event.preventDefault(); onBusy(true); try { await requestJson(company ? `/api/companies/${company.id}` : "/api/companies", { method: company ? "PATCH" : "POST", body: JSON.stringify(draft) }); await onSaved(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Não foi possível salvar a empresa."); } finally { onBusy(false); } }
  return <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className={styles.editorPanel} onSubmit={submit}><header><div><span>ESTRUTURA EMPRESARIAL</span><h2>{company ? "Editar empresa" : "Nova empresa"}</h2></div><button type="button" onClick={onClose} aria-label="Fechar"><X /></button></header><div className={styles.editorBody}><div className={styles.formGrid}><label><span>Tipo</span><select value={draft.companyType} onChange={(event) => update("companyType", event.target.value as CompanyDraft["companyType"])}><option value="principal">Empresa principal</option><option value="branch">Estabelecimento / filial</option></select></label>{draft.companyType === "branch" && <label><span>Vinculada a</span><select value={draft.parentCompanyId ?? ""} onChange={(event) => update("parentCompanyId", event.target.value || null)}><option value="">Selecione</option>{companies.filter((item) => item.id !== company?.id && item.status === "active" && item.isPrincipal).map((item) => <option key={item.id} value={item.id}>{displayCompany(item)}</option>)}</select></label>}<label className={styles.spanTwo}><span>Razão social *</span><input required value={draft.legalName} onChange={(event) => update("legalName", event.target.value)} /></label><label><span>Nome fantasia</span><input value={draft.tradeName} onChange={(event) => update("tradeName", event.target.value)} /></label><label><span>CNPJ</span><input inputMode="numeric" value={draft.taxId} onChange={(event) => update("taxId", event.target.value)} placeholder="00.000.000/0000-00" /></label><label><span>Regime tributário</span><input value={draft.taxRegime} onChange={(event) => update("taxRegime", event.target.value)} /></label><label><span>Código externo</span><input value={draft.externalCode} onChange={(event) => update("externalCode", event.target.value)} /></label><label><span>Inscrição estadual</span><input value={draft.stateRegistration} onChange={(event) => update("stateRegistration", event.target.value)} /></label><label><span>Inscrição municipal</span><input value={draft.municipalRegistration} onChange={(event) => update("municipalRegistration", event.target.value)} /></label><label><span>E-mail</span><input type="email" value={draft.email} onChange={(event) => update("email", event.target.value)} /></label><label><span>Telefone</span><input value={draft.phone} onChange={(event) => update("phone", event.target.value)} /></label><label><span>CEP</span><input value={draft.postalCode} onChange={(event) => update("postalCode", event.target.value)} /></label><label><span>Logradouro</span><input value={draft.street} onChange={(event) => update("street", event.target.value)} /></label><label><span>Número</span><input value={draft.streetNumber} onChange={(event) => update("streetNumber", event.target.value)} /></label><label><span>Bairro</span><input value={draft.district} onChange={(event) => update("district", event.target.value)} /></label><label><span>Cidade</span><input value={draft.city} onChange={(event) => update("city", event.target.value)} /></label><label><span>UF</span><input maxLength={2} value={draft.state} onChange={(event) => update("state", event.target.value.toUpperCase())} /></label></div></div><footer>{company?.status === "active" && <button type="button" className={styles.textDanger} onClick={() => onInactivate(company)}>Inativar empresa</button>}<span /><button type="button" className={styles.secondaryButton} onClick={onClose}>Cancelar</button><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} /> : <Check />} Salvar</button></footer></form></div>;
}

function CatalogEditor({ resource, item, company, busy, onClose, onBusy, onError, onSaved, onInactivate }: { resource: CatalogResource; item: CatalogItem | null; company: Company; busy: boolean; onClose: () => void; onBusy: (value: boolean) => void; onError: (value: string) => void; onSaved: () => Promise<void>; onInactivate: (item: CatalogItem) => void }) {
  const [code, setCode] = useState(item?.code ?? ""); const [name, setName] = useState(item?.name ?? ""); const [cboCode, setCboCode] = useState(item?.cboCode ?? ""); const [weeklyHours, setWeeklyHours] = useState(String(item?.weeklyHours ?? 44)); const [description, setDescription] = useState(item?.description ?? "");
  async function submit(event: FormEvent) { event.preventDefault(); onBusy(true); try { await requestJson(item ? `/api/registrations/catalogs/${resource}/${item.id}` : `/api/registrations/catalogs/${resource}`, { method: item ? "PATCH" : "POST", body: JSON.stringify({ companyId: company.id, code, name, cboCode, weeklyHours: Number(weeklyHours), description }) }); await onSaved(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Não foi possível salvar o cadastro."); } finally { onBusy(false); } }
  return <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className={styles.compactEditor} onSubmit={submit}><header><div><span>{displayCompany(company)}</span><h2>{item ? "Editar" : "Novo"} {catalogMeta[resource].singular.toLowerCase()}</h2></div><button type="button" onClick={onClose}><X /></button></header><div className={styles.editorBody}><label><span>Código *</span><input required value={code} onChange={(event) => setCode(event.target.value)} /></label><label><span>Nome *</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>{resource === "positions" && <label><span>Código CBO</span><input value={cboCode} onChange={(event) => setCboCode(event.target.value)} /></label>}{resource === "work-schedules" && <><label><span>Carga semanal</span><input type="number" min="1" max="60" value={weeklyHours} onChange={(event) => setWeeklyHours(event.target.value)} /></label><label><span>Descrição da jornada</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label></>}</div><footer>{item?.status === "active" && <button type="button" className={styles.textDanger} onClick={() => onInactivate(item)}>Inativar</button>}<span /><button type="button" className={styles.secondaryButton} onClick={onClose}>Cancelar</button><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} /> : <Check />} Salvar</button></footer></form></div>;
}

function EmployeeDrawer({ employee, companies, catalogs, busy, editing, activeTab, history, historyLoading, canManage, onTab, onCompanyCatalogs, onEdit, onClose, onBusy, onError, onSaved, onTerminate, onDelete }: { employee: Employee | null; companies: Company[]; catalogs: CatalogMap; busy: boolean; editing: boolean; activeTab: EmployeeDetailTab; history: HistoryEvent[]; historyLoading: boolean; canManage: boolean; onTab: (tab: EmployeeDetailTab) => void; onCompanyCatalogs: (companyId: string) => Promise<void>; onEdit: () => void; onClose: () => void; onBusy: (value: boolean) => void; onError: (value: string) => void; onSaved: (employee: Employee) => Promise<void>; onTerminate: (employee: Employee, terminationDate: string) => void; onDelete: (employee: Employee) => void }) {
  const [draft, setDraft] = useState<EmployeeDraft>(() => employee ? { companyId: employee.companyId, registrationNumber: employee.registrationNumber, fullName: employee.fullName, socialName: employee.socialName, cpf: "", departmentId: employee.departmentId ?? "", positionId: employee.positionId ?? "", costCenterId: employee.costCenterId ?? "", workScheduleId: employee.workScheduleId ?? "", admissionDate: employee.admissionDate, birthDate: employee.birthDate, terminationDate: employee.terminationDate, employmentStatus: employee.employmentStatus, employmentType: employee.employmentType, workModel: employee.workModel, email: employee.email, phone: employee.phone, notes: employee.notes } : { ...emptyEmployee, companyId: companies.find((item) => item.status === "active")?.id ?? "" });
  const [terminationDate, setTerminationDate] = useState(() => new Date().toISOString().slice(0, 10));
  function update<K extends keyof EmployeeDraft>(field: K, value: EmployeeDraft[K]) { setDraft((current) => ({ ...current, [field]: value })); }
  async function submit(event: FormEvent) { event.preventDefault(); onBusy(true); try { const body: JsonRecord = { ...draft }; if (!draft.cpf) delete body.cpf; const payload = await requestJson<{ employee: JsonRecord }>(employee ? `/api/employees/${employee.id}` : "/api/employees", { method: employee ? "PATCH" : "POST", body: JSON.stringify(body) }); await onSaved(normalizeEmployee(payload.employee)); } catch (cause) { onError(cause instanceof Error ? cause.message : "Não foi possível salvar o colaborador."); } finally { onBusy(false); } }
  const readOnly = !editing;
  return <div className={styles.drawerOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className={styles.employeeDrawer} role="dialog" aria-modal="true" aria-labelledby="employee-title"><header className={styles.drawerHeader}><div className={styles.employeeHero}><span>{employee ? initials(employee.socialName || employee.fullName) : <UserRound />}</span><div><small>{employee ? `MATRÍCULA ${employee.registrationNumber}` : "NOVO CADASTRO MANUAL"}</small><h2 id="employee-title">{employee ? employee.socialName || employee.fullName : "Novo colaborador"}</h2><p>{employee ? `${employee.positionName || "Sem cargo"} · ${employee.companyName}` : "Registre uma admissão já concluída na origem."}</p></div></div><div>{employee && canManage && !editing && <button className={styles.secondaryButton} onClick={onEdit}><Edit3 /> Editar</button>}<button className={styles.closeButton} onClick={onClose} aria-label="Fechar"><X /></button></div></header><nav className={styles.drawerTabs}>{(["personal", "employment", "contact", "epi", "history"] as EmployeeDetailTab[]).map((item) => <button key={item} className={activeTab === item ? styles.drawerTabActive : ""} onClick={() => onTab(item)} disabled={!employee && (item === "history" || item === "epi")}>{item === "personal" ? "Dados pessoais" : item === "employment" ? "Vínculo e lotação" : item === "contact" ? "Contato" : item === "epi" ? "EPIs" : "Histórico"}</button>)}</nav>
      <form onSubmit={submit} className={styles.drawerForm}><div className={styles.drawerBody}>
        {activeTab === "personal" && <div className={styles.formGrid}><label className={styles.spanTwo}><span>Nome completo *</span><input required readOnly={readOnly} value={draft.fullName} onChange={(event) => update("fullName", event.target.value)} /></label><label className={styles.spanTwo}><span>Nome social</span><input readOnly={readOnly} value={draft.socialName} onChange={(event) => update("socialName", event.target.value)} /></label><label><span>CPF</span><input readOnly={readOnly} inputMode="numeric" autoComplete="off" value={readOnly && employee?.cpfLast4 ? `•••.•••.•••-${employee.cpfLast4}` : draft.cpf} onChange={(event) => update("cpf", event.target.value)} placeholder={employee?.cpfLast4 ? "Preencha apenas para alterar" : "000.000.000-00"} /></label><label><span>Data de nascimento</span><input readOnly={readOnly} type="date" value={draft.birthDate} onChange={(event) => update("birthDate", event.target.value)} /></label><label className={styles.spanTwo}><span>Observações</span><textarea readOnly={readOnly} value={draft.notes} onChange={(event) => update("notes", event.target.value)} /></label></div>}
        {activeTab === "employment" && <><div className={styles.formGrid}><label><span>Empresa *</span><select disabled={readOnly} required value={draft.companyId} onChange={(event) => { update("companyId", event.target.value); void onCompanyCatalogs(event.target.value); }}><option value="">Selecione</option>{companies.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{displayCompany(item)}</option>)}</select></label><label><span>Matrícula *</span><input readOnly={readOnly} required value={draft.registrationNumber} onChange={(event) => update("registrationNumber", event.target.value)} /></label><label><span>Admissão *</span><input readOnly={readOnly} required type="date" value={draft.admissionDate} onChange={(event) => update("admissionDate", event.target.value)} /></label><label><span>Status</span><select disabled={readOnly} value={draft.employmentStatus} onChange={(event) => update("employmentStatus", event.target.value as EmployeeDraft["employmentStatus"])}><option value="active">Ativo</option><option value="on_leave">Afastado</option><option value="terminated">Desligado</option></select></label><label><span>Departamento</span><select disabled={readOnly} value={draft.departmentId} onChange={(event) => update("departmentId", event.target.value)}><option value="">Não informado</option>{catalogs.departments.filter((item) => item.companyId === draft.companyId && item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Cargo</span><select disabled={readOnly} value={draft.positionId} onChange={(event) => update("positionId", event.target.value)}><option value="">Não informado</option>{catalogs.positions.filter((item) => item.companyId === draft.companyId && item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Centro de custo</span><select disabled={readOnly} value={draft.costCenterId} onChange={(event) => update("costCenterId", event.target.value)}><option value="">Não informado</option>{catalogs["cost-centers"].filter((item) => item.companyId === draft.companyId && item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Jornada</span><select disabled={readOnly} value={draft.workScheduleId} onChange={(event) => update("workScheduleId", event.target.value)}><option value="">Não informada</option>{catalogs["work-schedules"].filter((item) => item.companyId === draft.companyId && item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Tipo de vínculo</span><select disabled={readOnly} value={draft.employmentType} onChange={(event) => update("employmentType", event.target.value as EmployeeDraft["employmentType"])}><option value="clt">CLT</option><option value="intern">Estágio</option><option value="apprentice">Aprendiz</option><option value="temporary">Temporário</option></select></label><label><span>Modelo de trabalho</span><select disabled={readOnly} value={draft.workModel} onChange={(event) => update("workModel", event.target.value as EmployeeDraft["workModel"])}><option value="onsite">Presencial</option><option value="hybrid">Híbrido</option><option value="remote">Remoto</option></select></label><label><span>Desligamento</span><input readOnly={readOnly} type="date" value={draft.terminationDate} onChange={(event) => update("terminationDate", event.target.value)} /></label></div>{employee && canManage && readOnly && <section className={styles.employeeActions}><div><strong>Encerramento do vínculo</strong><p>Demissão preserva todo o histórico. Exclusão só é liberada para cadastros sem movimentações.</p></div>{employee.employmentStatus !== "terminated" && <label><span>Data da demissão</span><input type="date" value={terminationDate} min={employee.admissionDate} onChange={(event) => setTerminationDate(event.target.value)} /><button type="button" className={styles.secondaryButton} disabled={!terminationDate} onClick={() => onTerminate(employee, terminationDate)}><UserMinus /> Demitir</button></label>}<button type="button" className={styles.textDangerButton} onClick={() => onDelete(employee)}><Trash2 /> Excluir cadastro</button></section>}</>}
        {activeTab === "contact" && <div className={styles.formGrid}><label className={styles.spanTwo}><span>E-mail</span><input readOnly={readOnly} type="email" value={draft.email} onChange={(event) => update("email", event.target.value)} /></label><label className={styles.spanTwo}><span>Telefone</span><input readOnly={readOnly} value={draft.phone} onChange={(event) => update("phone", event.target.value)} /></label><div className={`${styles.infoNote} ${styles.spanTwo}`}><BadgeCheck /><span><strong>Dados protegidos</strong><small>Informações pessoais ficam apenas no cadastro e não entram no snapshot operacional, URLs ou armazenamento local.</small></span></div></div>}
        {activeTab === "epi" && employee && <EmployeeEpiPanel employeeId={employee.id} />}
        {activeTab === "history" && <HistoryTrail events={history} loading={historyLoading} />}
      </div>{editing && activeTab !== "history" && activeTab !== "epi" && <footer className={styles.drawerFooter}><button type="button" className={styles.secondaryButton} onClick={onClose}>Cancelar</button><button className={styles.primaryButton} disabled={busy}>{busy ? <LoaderCircle className={styles.spin} /> : <Check />} Salvar colaborador</button></footer>}</form>
    </aside></div>;
}

function HistoryTrail({ events, loading }: { events: HistoryEvent[]; loading: boolean }) {
  if (loading) return <LoadingState title="Reconstruindo a trilha do colaborador" />;
  if (!events.length) return <EmptyState icon={History} title="Histórico ainda vazio" text="As alterações auditadas deste colaborador aparecerão aqui em ordem cronológica." />;
  return <section className={styles.historyTrail} aria-label="Histórico do colaborador"><header><span><History /></span><div><small>TRILHA AUDITÁVEL</small><h3>Histórico do colaborador</h3><p>{events.length} evento(s) preservado(s)</p></div></header><ol>{events.map((event, index) => <li key={event.id}><span className={index === 0 ? styles.latestDot : ""}>{index === 0 ? <Check /> : null}</span><article><header><strong>{historyLabel(event.action)}</strong>{index === 0 && <em>Mais recente</em>}</header><p>{event.actorEmail || "Sistema Vinculato"}</p><time>{dateLabel(event.createdAt)}</time>{event.metadata?.sourceSystem === "manual" && <small>Origem: cadastro manual</small>}</article></li>)}</ol></section>;
}

/** Ativo/inativo é o vocabulário de cadastro; o selo é o mesmo do resto do painel. */
const activePill = (active: boolean) => <StatusPill status={active ? "active" : "inactive"} label={active ? "Ativo" : "Inativo"} />;
const employeePill = (status: Employee["employmentStatus"]) => <StatusPill status={status} label={statusLabel(status)} />;
