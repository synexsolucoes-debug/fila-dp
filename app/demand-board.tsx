"use client";

import { FormEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Status = "available" | "in_progress" | "waiting" | "done";
type Priority = "low" | "medium" | "high" | "urgent";
type ActiveStatus = "active" | "inactive";
type View = "overview" | "demands" | "mine" | "reports" | "settings" | "users" | "companies";

type User = { name: string; email: string; role: "admin" | "analyst" };
type TeamMember = { id: number; name: string; email: string };
type ManagedUser = {
  id: number;
  displayName: string;
  email: string;
  role: "admin" | "analyst";
  status: ActiveStatus;
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string | null;
};

type Company = {
  id: number;
  legalName: string;
  tradeName: string;
  cnpj: string | null;
  status: ActiveStatus;
  createdAt?: string;
  updatedAt?: string;
  demandCount?: number;
};

type Label = { id: number; name: string; color: string; status: ActiveStatus };
type ChecklistTemplate = { id: number; category: string; text: string; sortOrder: number; status: ActiveStatus };
type ChecklistItem = { id: number; text: string; completed: number | boolean; completedAt: string | null; completedBy: string | null; sortOrder: number };

type Demand = {
  id: number;
  title: string;
  description: string;
  category: string;
  company: string;
  companyId: number | null;
  employee: string | null;
  requester: string;
  source: string;
  priority: Priority;
  dueDate: string;
  status: Status;
  assignee: string | null;
  assigneeEmail: string | null;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  labels: Label[];
  checklistTotal: number;
  checklistCompleted: number;
};

type TimelineEvent = {
  id: number;
  eventType: "system" | "comment";
  action?: string;
  details?: string;
  text?: string;
  userName: string;
  userEmail?: string;
  fieldChanged?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  justification?: string | null;
  createdAt: string;
};

type UserHistory = {
  id: number;
  action: string;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  actorName: string;
  createdAt: string;
};

const STATUS: Array<{ id: Status; label: string }> = [
  { id: "available", label: "Disponíveis" },
  { id: "in_progress", label: "Em andamento" },
  { id: "waiting", label: "Aguardando informações" },
  { id: "done", label: "Concluídas" },
];

const CATEGORIES = ["Admissão", "Férias", "Rescisão", "Ponto", "Folha", "Benefícios", "Afastamento", "eSocial", "Atendimento", "Outros"];
const CATEGORY_COLORS: Record<string, string> = {
  Admissão: "green", Férias: "blue", Rescisão: "red", Ponto: "amber",
  Folha: "violet", Benefícios: "orange", Afastamento: "slate",
  eSocial: "indigo", Atendimento: "teal", Outros: "gray",
};

const initialDemands: Demand[] = [
  {
    id: 1, title: "Admissão – Mariana Costa", description: "Conferir documentação admissional.", category: "Admissão",
    company: "Empresa Alfa Ltda.", companyId: null, employee: "Mariana Costa", requester: "Recrutamento", source: "E-mail",
    priority: "high", dueDate: "2026-07-18", status: "available", assignee: null, assigneeEmail: null, version: 1,
    updatedAt: "2026-07-17 12:00:00", labels: [], checklistTotal: 5, checklistCompleted: 0,
  },
];

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10M9 20v-6h6v6"/></>,
    inbox: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M8 5V3h8v2M8 12h2l2 2 2-2h2"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 3.5-6 8-6s7.2 1.8 8 6"/></>,
    chart: <><path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7M2 20h20"/></>,
    gear: <><circle cx="12" cy="12" r="3"/><path d="m19 13.5 2 1.2-2 3.4-2.1-1a8 8 0 0 1-2.2 1.3l-.2 2.3h-4l-.2-2.3A8 8 0 0 1 8 17.1l-2.1 1-2-3.4 2-1.2a8 8 0 0 1 0-2.6l-2-1.2 2-3.4 2.1 1a8 8 0 0 1 2.2-1.3l.2-2.3h4l.2 2.3A8 8 0 0 1 17 7.3l2.1-1 2 3.4-2 1.2a8 8 0 0 1 0 2.6Z"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    filter: <path d="M4 5h16l-6 7v6l-4 2v-8Z"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    building: <><path d="M5 21V5h10v16M15 10h4v11M8 8h1M11 8h1M8 12h1M11 12h1M8 16h1M11 16h1M3 21h18"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
    alert: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    edit: <><path d="m4 20 4.2-1 10.9-10.9-3.2-3.2L5 15.8 4 20Z"/><path d="m14.8 6 3.2 3.2"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    comment: <><path d="M4 5h16v11H8l-4 4V5Z"/></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

const initials = (name: string) => name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const parseTimestamp = (value?: string | null) => value ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`) : null;
const formatDateTime = (value?: string | null) => {
  const date = parseTimestamp(value);
  return date ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date) : "Nunca acessou";
};
const formatCnpj = (value?: string | null) => {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length !== 14) return value || "—";
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

function dueLabel(dueDate: string, status: Status) {
  if (status === "done") return { text: "Concluída", className: "ok" };
  if (status === "waiting") return { text: "Aguardando", className: "warn" };
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const due = new Date(`${dueDate}T12:00:00`);
  const diff = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { text: `Atrasada ${Math.abs(diff)}d`, className: "late" };
  if (diff === 0) return { text: "SLA hoje", className: "ok" };
  return { text: `Até ${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(due)}`, className: "neutral" };
}

function isAged(demand: Demand) {
  const updated = parseTimestamp(demand.updatedAt);
  return demand.status === "waiting" && Boolean(updated) && Date.now() - updated!.getTime() > 3 * 86400000;
}

export default function DemandBoard({ currentUser }: { currentUser: User }) {
  const [demands, setDemands] = useState(initialDemands);
  const [activeUser, setActiveUser] = useState(currentUser);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [view, setView] = useState<View>("demands");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState<Priority | "all">("all");
  const [labelFilter, setLabelFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [labelsExpanded, setLabelsExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [newDemandOpen, setNewDemandOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [quickEditId, setQuickEditId] = useState<number | null>(null);
  const [selectedDemand, setSelectedDemand] = useState<Demand | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [demandCanEdit, setDemandCanEdit] = useState(false);
  const [demandEditMode, setDemandEditMode] = useState(false);
  const [demandModalError, setDemandModalError] = useState("");
  const [userModal, setUserModal] = useState<ManagedUser | "new" | null>(null);
  const [userHistory, setUserHistory] = useState<UserHistory[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState("all");
  const [userStatusFilter, setUserStatusFilter] = useState("all");
  const [inactiveConfirm, setInactiveConfirm] = useState<{ payload: Record<string, unknown>; count: number } | null>(null);
  const [companyModal, setCompanyModal] = useState<Company | "new" | null>(null);
  const [companySearch, setCompanySearch] = useState("");
  const [companyStatusFilter, setCompanyStatusFilter] = useState("all");
  const [labelModal, setLabelModal] = useState<Label | "new" | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3200);
  }

  function replaceDemand(demand: Demand) {
    setDemands((list) => list.map((item) => item.id === demand.id ? demand : item));
    setSelectedDemand((current) => current?.id === demand.id ? demand : current);
  }

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/users", { cache: "no-store" });
    const data = await response.json() as { users?: ManagedUser[] };
    if (response.ok) setUsers(data.users ?? []);
  }, []);

  const loadConfiguration = useCallback(async () => {
    const suffix = "?status=all";
    const [companiesResponse, labelsResponse, templatesResponse] = await Promise.all([
      fetch(`/api/companies${suffix}`, { cache: "no-store" }),
      fetch(`/api/labels${suffix}`, { cache: "no-store" }),
      fetch(`/api/checklist-templates${suffix}`, { cache: "no-store" }),
    ]);
    const companiesData = await companiesResponse.json() as { companies?: Company[] };
    const labelsData = await labelsResponse.json() as { labels?: Label[] };
    const templatesData = await templatesResponse.json() as { templates?: ChecklistTemplate[] };
    if (companiesResponse.ok) setCompanies(companiesData.companies ?? []);
    if (labelsResponse.ok) setLabels(labelsData.labels ?? []);
    if (templatesResponse.ok) setTemplates(templatesData.templates ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/demands", { cache: "no-store" });
        const data = await response.json() as { demands?: Demand[]; user?: User; team?: TeamMember[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Não foi possível carregar as demandas.");
        if (cancelled) return;
        const user = data.user ?? currentUser;
        setDemands(data.demands ?? []);
        setTeam(data.team ?? []);
        setActiveUser(user);
        await loadConfiguration();
        await loadUsers();
      } catch (error) {
        if (!cancelled) flash(error instanceof Error ? error.message : "Erro ao carregar os dados.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [currentUser, loadConfiguration, loadUsers]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key.toLowerCase() === "f" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        event.preventDefault();
        setView("demands");
        searchRef.current?.focus();
      }
      if (event.key === "Escape") setQuickEditId(null);
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  const filtered = useMemo(() => {
    const tokens = query.toLocaleLowerCase("pt-BR").split(/\s+/).filter(Boolean);
    return demands.filter((demand) => {
      const haystack = [
        demand.title, demand.description, demand.company, demand.category, demand.employee,
        demand.requester, demand.assignee, ...demand.labels.map((label) => label.name),
      ].filter(Boolean).join(" ").toLocaleLowerCase("pt-BR");
      return tokens.every((token) => haystack.includes(token))
        && (priority === "all" || demand.priority === priority)
        && (labelFilter === "all" || demand.labels.some((label) => label.id === Number(labelFilter)))
        && (companyFilter === "all" || demand.companyId === Number(companyFilter))
        && (assigneeFilter === "all" || (assigneeFilter === "unassigned" ? !demand.assigneeEmail : demand.assigneeEmail === assigneeFilter))
        && (view !== "mine" || demand.assigneeEmail === activeUser.email);
    });
  }, [demands, query, priority, labelFilter, companyFilter, assigneeFilter, view, activeUser.email]);

  const filteredUsers = useMemo(() => users.filter((user) => {
    const text = `${user.displayName} ${user.email}`.toLowerCase();
    return text.includes(userSearch.toLowerCase())
      && (userRoleFilter === "all" || user.role === userRoleFilter)
      && (userStatusFilter === "all" || user.status === userStatusFilter);
  }), [users, userSearch, userRoleFilter, userStatusFilter]);

  const filteredCompanies = useMemo(() => companies.filter((company) => {
    const text = `${company.tradeName} ${company.legalName} ${company.cnpj ?? ""}`.toLowerCase();
    return text.includes(companySearch.toLowerCase()) && (companyStatusFilter === "all" || company.status === companyStatusFilter);
  }), [companies, companySearch, companyStatusFilter]);

  const counts = useMemo(() => ({
    available: demands.filter((d) => d.status === "available").length,
    active: demands.filter((d) => d.status === "in_progress").length,
    overdue: demands.filter((d) => d.status !== "done" && new Date(`${d.dueDate}T23:59:59`) < new Date()).length,
  }), [demands]);

  const activeFilters = [priority, labelFilter, companyFilter, assigneeFilter].filter((value) => value !== "all").length;

  async function claimDemand(id: number) {
    setSaving(true);
    try {
      const response = await fetch(`/api/demands/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "claim" }) });
      const data = await response.json() as { demand?: Demand; error?: string };
      if (!response.ok || !data.demand) throw new Error(data.error ?? "Não foi possível assumir a demanda.");
      replaceDemand(data.demand);
      flash("Demanda assumida com sucesso.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao assumir demanda."); }
    finally { setSaving(false); }
  }

  async function moveDemand(id: number, status: Status) {
    setSaving(true);
    try {
      const response = await fetch(`/api/demands/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move", status }) });
      const data = await response.json() as { demand?: Demand; error?: string; message?: string };
      if (!response.ok || !data.demand) throw new Error(data.message ?? data.error ?? "Não foi possível movimentar a demanda.");
      replaceDemand(data.demand);
      flash("Status atualizado.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao movimentar demanda."); }
    finally { setSaving(false); }
  }

  async function createDemand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const form = new FormData(event.currentTarget);
      const payload = { ...Object.fromEntries(form.entries()), labelIds: form.getAll("labelIds").map(Number) };
      const response = await fetch("/api/demands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json() as { demand?: Demand; error?: string };
      if (!response.ok || !data.demand) throw new Error(data.error ?? "Não foi possível cadastrar.");
      setDemands((list) => [data.demand!, ...list]);
      setNewDemandOpen(false);
      setView("demands");
      flash(data.demand.checklistTotal ? `Demanda criada com ${data.demand.checklistTotal} etapas automáticas.` : "Demanda cadastrada.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao cadastrar demanda."); }
    finally { setSaving(false); }
  }

  async function openDemand(id: number) {
    setDemandModalError("");
    setDemandEditMode(false);
    setSaving(true);
    try {
      const [detailResponse, timelineResponse, checklistResponse] = await Promise.all([
        fetch(`/api/demands/${id}`, { cache: "no-store" }),
        fetch(`/api/demands/${id}/timeline`, { cache: "no-store" }),
        fetch(`/api/demands/${id}/checklist`, { cache: "no-store" }),
      ]);
      const detail = await detailResponse.json() as { demand?: Demand; canEdit?: boolean; error?: string };
      const timelineData = await timelineResponse.json() as { timeline?: TimelineEvent[] };
      const checklistData = await checklistResponse.json() as { checklist?: ChecklistItem[]; canEdit?: boolean };
      if (!detailResponse.ok || !detail.demand) throw new Error(detail.error ?? "Não foi possível abrir a demanda.");
      setSelectedDemand(detail.demand);
      setDemandCanEdit(Boolean(detail.canEdit));
      setTimeline(timelineData.timeline ?? []);
      setChecklist(checklistData.checklist ?? []);
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao abrir demanda."); }
    finally { setSaving(false); }
  }

  async function refreshTimeline(id: number) {
    const response = await fetch(`/api/demands/${id}/timeline`, { cache: "no-store" });
    const data = await response.json() as { timeline?: TimelineEvent[] };
    if (response.ok) setTimeline(data.timeline ?? []);
  }

  async function saveDemand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDemand) return;
    const data = new FormData(event.currentTarget);
    const labelIds = data.getAll("labelIds").map(Number);
    const payload: Record<string, unknown> = {
      version: selectedDemand.version,
      priority: data.get("priority"), dueDate: data.get("dueDate"), description: data.get("description"),
      justification: data.get("justification"),
    };
    Object.assign(payload, {
      category: data.get("category"), source: data.get("source"), companyId: Number(data.get("companyId")),
      employee: data.get("employee"), requester: data.get("requester"),
    });
    setSaving(true);
    setDemandModalError("");
    try {
      const response = await fetch(`/api/demands/${selectedDemand.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { demand?: Demand; error?: string; message?: string };
      if (!response.ok || !result.demand) throw new Error(result.message ?? result.error ?? "Não foi possível salvar a demanda.");
      let demand = result.demand;
      const currentLabels = demand.labels.map((label) => label.id).sort().join(",");
      const nextLabels = [...labelIds].sort().join(",");
      if (currentLabels !== nextLabels) {
        const labelsResponse = await fetch(`/api/demands/${demand.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "quick_update", version: demand.version, labelIds }),
        });
        const labelsResult = await labelsResponse.json() as { demand?: Demand; error?: string; message?: string };
        if (!labelsResponse.ok || !labelsResult.demand) throw new Error(labelsResult.message ?? labelsResult.error ?? "Os dados foram salvos, mas as etiquetas não foram atualizadas.");
        demand = labelsResult.demand;
      }
      replaceDemand(demand);
      setDemandEditMode(false);
      await refreshTimeline(demand.id);
      flash("Alterações salvas e registradas na atividade.");
    } catch (error) { setDemandModalError(error instanceof Error ? error.message : "Erro ao salvar demanda."); }
    finally { setSaving(false); }
  }

  async function quickUpdateDemand(id: number, changes: { dueDate?: string; assigneeEmail?: string; labelIds?: number[] }) {
    const original = demands.find((item) => item.id === id);
    if (!original) return;
    const optimistic: Demand = {
      ...original,
      dueDate: changes.dueDate ?? original.dueDate,
      labels: changes.labelIds ? labels.filter((label) => changes.labelIds!.includes(label.id)) : original.labels,
    };
    if (changes.assigneeEmail !== undefined) {
      const member = team.find((item) => item.email === changes.assigneeEmail);
      optimistic.assigneeEmail = member?.email ?? null;
      optimistic.assignee = member?.name ?? null;
      optimistic.status = member ? (original.status === "available" ? "in_progress" : original.status) : "available";
    }
    replaceDemand(optimistic);
    setQuickEditId(null);
    try {
      const response = await fetch(`/api/demands/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quick_update", version: original.version, ...changes }),
      });
      const result = await response.json() as { demand?: Demand; error?: string; message?: string };
      if (!response.ok || !result.demand) throw new Error(result.message ?? result.error ?? "Não foi possível aplicar a ação rápida.");
      replaceDemand(result.demand);
      flash("Cartão atualizado.");
    } catch (error) {
      replaceDemand(original);
      flash(error instanceof Error ? error.message : "A alteração foi desfeita.");
    }
  }

  async function toggleChecklistItem(item: ChecklistItem, completed: boolean) {
    if (!selectedDemand) return;
    setChecklist((list) => list.map((entry) => entry.id === item.id ? { ...entry, completed } : entry));
    try {
      const response = await fetch(`/api/demands/${selectedDemand.id}/checklist/${item.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed }),
      });
      const data = await response.json() as { checklist?: ChecklistItem[]; demand?: Demand; error?: string };
      if (!response.ok || !data.checklist || !data.demand) throw new Error(data.error ?? "Não foi possível atualizar o checklist.");
      setChecklist(data.checklist);
      replaceDemand(data.demand);
      await refreshTimeline(selectedDemand.id);
    } catch (error) {
      setChecklist((list) => list.map((entry) => entry.id === item.id ? { ...entry, completed: item.completed } : entry));
      flash(error instanceof Error ? error.message : "Erro no checklist.");
    }
  }

  async function addChecklistItem(text: string) {
    if (!selectedDemand) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/demands/${selectedDemand.id}/checklist`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      const data = await response.json() as { checklist?: ChecklistItem[]; demand?: Demand; error?: string };
      if (!response.ok || !data.checklist || !data.demand) throw new Error(data.error ?? "Não foi possível adicionar o item.");
      setChecklist(data.checklist);
      replaceDemand(data.demand);
      await refreshTimeline(selectedDemand.id);
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao adicionar item."); }
    finally { setSaving(false); }
  }

  async function addComment(text: string) {
    if (!selectedDemand) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/demands/${selectedDemand.id}/timeline`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      const data = await response.json() as { demand?: Demand; error?: string };
      if (!response.ok || !data.demand) throw new Error(data.error ?? "Não foi possível publicar o comentário.");
      replaceDemand(data.demand);
      await refreshTimeline(selectedDemand.id);
      flash("Comentário adicionado.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao comentar."); }
    finally { setSaving(false); }
  }

  async function openUser(user: ManagedUser | "new") {
    setUserModal(user);
    setUserHistory([]);
    if (user !== "new") {
      const response = await fetch(`/api/users/${user.id}/history`, { cache: "no-store" });
      const data = await response.json() as { history?: UserHistory[] };
      if (response.ok) setUserHistory(data.history ?? []);
    }
  }

  async function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await persistUser(Object.fromEntries(new FormData(event.currentTarget).entries()), false);
  }

  async function persistUser(payload: Record<string, unknown>, confirmInactive: boolean) {
    setSaving(true);
    try {
      const isNew = userModal === "new";
      const url = isNew ? "/api/users" : `/api/users/${(userModal as ManagedUser).id}`;
      const response = await fetch(url, { method: isNew ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, confirmInactive }) });
      const data = await response.json() as { user?: ManagedUser; error?: string; message?: string; activeDemandCount?: number };
      if (response.status === 409 && data.error === "ACTIVE_DEMANDS") {
        setInactiveConfirm({ payload, count: data.activeDemandCount ?? 0 });
        return;
      }
      if (!response.ok || !data.user) throw new Error(data.message ?? data.error ?? "Não foi possível salvar o usuário.");
      setUsers((list) => isNew ? [...list, data.user!].sort((a, b) => a.displayName.localeCompare(b.displayName)) : list.map((item) => item.id === data.user!.id ? data.user! : item));
      setTeam((list) => data.user!.status === "active"
        ? [...list.filter((item) => item.id !== data.user!.id), { id: data.user!.id, name: data.user!.displayName, email: data.user!.email }].sort((a, b) => a.name.localeCompare(b.name))
        : list.filter((item) => item.id !== data.user!.id));
      setUserModal(null);
      setInactiveConfirm(null);
      flash(isNew ? "Usuário cadastrado." : "Usuário atualizado.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao salvar usuário."); }
    finally { setSaving(false); }
  }

  async function persistCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const isNew = companyModal === "new";
      const response = await fetch(isNew ? "/api/companies" : `/api/companies/${(companyModal as Company).id}`, {
        method: isNew ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await response.json() as { company?: Company; error?: string };
      if (!response.ok || !data.company) throw new Error(data.error ?? "Não foi possível salvar a empresa.");
      setCompanies((list) => isNew ? [...list, data.company!].sort((a, b) => a.tradeName.localeCompare(b.tradeName)) : list.map((item) => item.id === data.company!.id ? { ...item, ...data.company! } : item));
      setCompanyModal(null);
      flash(isNew ? "Empresa cadastrada." : "Empresa atualizada sem afetar o histórico.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao salvar empresa."); }
    finally { setSaving(false); }
  }

  async function persistLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const isNew = labelModal === "new";
      const response = await fetch(isNew ? "/api/labels" : `/api/labels/${(labelModal as Label).id}`, {
        method: isNew ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await response.json() as { label?: Label; error?: string };
      if (!response.ok || !data.label) throw new Error(data.error ?? "Não foi possível salvar a etiqueta.");
      setLabels((list) => isNew ? [...list, data.label!].sort((a, b) => a.name.localeCompare(b.name)) : list.map((item) => item.id === data.label!.id ? data.label! : item));
      setLabelModal(null);
      flash(isNew ? "Etiqueta criada." : "Etiqueta atualizada.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao salvar etiqueta."); }
    finally { setSaving(false); }
  }

  async function addTemplate(category: string, text: string) {
    setSaving(true);
    try {
      const response = await fetch("/api/checklist-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, text }) });
      const data = await response.json() as { template?: ChecklistTemplate; error?: string };
      if (!response.ok || !data.template) throw new Error(data.error ?? "Não foi possível criar a etapa.");
      setTemplates((list) => [...list, data.template!].sort((a, b) => a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder));
      flash("Etapa adicionada ao modelo.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao salvar modelo."); }
    finally { setSaving(false); }
  }

  async function toggleTemplate(template: ChecklistTemplate) {
    const status: ActiveStatus = template.status === "active" ? "inactive" : "active";
    try {
      const response = await fetch(`/api/checklist-templates/${template.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      const data = await response.json() as { template?: ChecklistTemplate; error?: string };
      if (!response.ok || !data.template) throw new Error(data.error ?? "Não foi possível atualizar a etapa.");
      setTemplates((list) => list.map((item) => item.id === data.template!.id ? data.template! : item));
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao atualizar modelo."); }
  }

  const navItems: Array<{ id: View; label: string; icon: string }> = [
    { id: "overview", label: "Visão geral", icon: "home" },
    { id: "demands", label: "Demandas", icon: "inbox" },
    { id: "mine", label: "Minha fila", icon: "user" },
    { id: "reports", label: "Relatórios", icon: "chart" },
    { id: "settings", label: "Configurações", icon: "gear" },
    { id: "companies" as View, label: "Empresas", icon: "building" },
    { id: "users" as View, label: "Usuários", icon: "user" },
  ];

  const title = ({ mine: "Minha fila", overview: "Visão geral", reports: "Relatórios", settings: "Configurações", users: "Gestão de usuários", companies: "Gestão de empresas", demands: "Fila DP" } as Record<View, string>)[view];

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span>F</span><strong>Fila DP</strong></div>
      <nav aria-label="Navegação principal">
        {navItems.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><Icon name={item.icon}/><span>{item.label}</span></button>)}
      </nav>
      <div className="profile"><span className="avatar large">{initials(activeUser.name)}</span><div><strong>{activeUser.name}</strong><small>{activeUser.role === "admin" ? "Administrador" : "Analista · acesso completo"}</small></div><span className="chevron">⌄</span></div>
    </aside>

    <section className="workspace">
      <header className="topbar">
        <div><p className="eyebrow">Gestão de demandas</p><h1>{title}</h1></div>
        {!(["users", "companies"] as View[]).includes(view) && <div className="kpis" aria-label="Indicadores da fila">
          <div className="kpi green"><span className="kpi-icon"><Icon name="user"/></span><div><small>Disponíveis</small><strong>{counts.available}</strong></div></div>
          <div className="kpi blue"><span className="kpi-icon"><Icon name="clock"/></span><div><small>Em andamento</small><strong>{counts.active}</strong></div></div>
          <div className="kpi coral"><span className="kpi-icon"><Icon name="alert"/></span><div><small>Atrasadas</small><strong>{counts.overdue}</strong></div></div>
        </div>}
        {view === "users"
          ? <button className="primary" onClick={() => openUser("new")}><Icon name="plus"/>Novo usuário</button>
          : view === "companies"
            ? <button className="primary" onClick={() => setCompanyModal("new")}><Icon name="plus"/>Nova empresa</button>
            : <button className="primary" onClick={() => setNewDemandOpen(true)}><Icon name="plus"/>Nova demanda</button>}
      </header>

      {(view === "demands" || view === "mine") && <>
        <div className="toolbar">
          <label className="search super-search"><Icon name="search"/><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Super busca: ex. Férias Maria"/><kbd>F</kbd></label>
          <div className="filter-wrap">
            <button className="secondary" onClick={() => setFilterOpen(!filterOpen)}><Icon name="filter"/>Filtros {activeFilters > 0 && <b>{activeFilters}</b>}<span>⌄</span></button>
            {filterOpen && <div className="filter-menu super-filter">
              <label>Prioridade<select value={priority} onChange={(event) => setPriority(event.target.value as Priority | "all")}><option value="all">Todas</option><option value="urgent">Urgente</option><option value="high">Alta</option><option value="medium">Média</option><option value="low">Baixa</option></select></label>
              <label>Etiqueta<select value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}><option value="all">Todas</option>{labels.filter((label) => label.status === "active").map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
              <label>Empresa<select value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)}><option value="all">Todas</option>{companies.filter((company) => company.status === "active").map((company) => <option key={company.id} value={company.id}>{company.tradeName}</option>)}</select></label>
              <label>Responsável<select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}><option value="all">Todos</option><option value="unassigned">Sem responsável</option>{team.map((member) => <option key={member.id} value={member.email}>{member.name}</option>)}</select></label>
              <button onClick={() => { setPriority("all"); setLabelFilter("all"); setCompanyFilter("all"); setAssigneeFilter("all"); }}>Limpar filtros</button>
            </div>}
          </div>
          {(loading || saving) && <span className="sync-state">{loading ? "Carregando..." : "Salvando..."}</span>}
          <span className="result-count">{filtered.length} demandas</span>
        </div>
        <div className="board">
          {STATUS.map((column) => {
            const items = filtered.filter((demand) => demand.status === column.id);
            return <section className="column" key={column.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedId) moveDemand(draggedId, column.id); setDraggedId(null); }}>
              <header><div><span className="grip">⠿</span><strong>{column.label}</strong></div><span className={`count ${column.id}`}>{items.length}</span></header>
              <div className="card-list">
                {items.map((demand) => <DemandCard key={demand.id} demand={demand} currentUser={activeUser} team={team} availableLabels={labels.filter((label) => label.status === "active")} labelsExpanded={labelsExpanded} quickOpen={quickEditId === demand.id} onToggleLabels={() => setLabelsExpanded((value) => !value)} onQuickOpen={() => setQuickEditId(quickEditId === demand.id ? null : demand.id)} onQuickSave={(changes) => quickUpdateDemand(demand.id, changes)} onClaim={claimDemand} onOpen={openDemand} onDragStart={setDraggedId}/>)}
                {items.length === 0 && <div className="empty-column">Nenhuma demanda nesta etapa</div>}
              </div>
            </section>;
          })}
        </div>
      </>}

      {view === "overview" && <Overview demands={demands} currentUser={activeUser} onOpenBoard={() => setView("demands")}/>} 
      {view === "reports" && <Reports demands={demands}/>} 
      {view === "settings" && <Settings currentUser={activeUser} labels={labels} templates={templates} onManageUsers={() => setView("users")} onManageCompanies={() => setView("companies")} onNewLabel={() => setLabelModal("new")} onEditLabel={setLabelModal} onAddTemplate={addTemplate} onToggleTemplate={toggleTemplate}/>} 
      {view === "users" && <UsersView users={filteredUsers} search={userSearch} roleFilter={userRoleFilter} statusFilter={userStatusFilter} setSearch={setUserSearch} setRoleFilter={setUserRoleFilter} setStatusFilter={setUserStatusFilter} onEdit={openUser}/>} 
      {view === "companies" && <CompaniesView companies={filteredCompanies} search={companySearch} statusFilter={companyStatusFilter} setSearch={setCompanySearch} setStatusFilter={setCompanyStatusFilter} onEdit={setCompanyModal}/>} 
    </section>

    {newDemandOpen && <NewDemandModal companies={companies.filter((company) => company.status === "active")} labels={labels.filter((label) => label.status === "active")} templates={templates.filter((template) => template.status === "active")} onClose={() => setNewDemandOpen(false)} onSubmit={createDemand}/>} 
    {selectedDemand && <DemandDetailModal demand={selectedDemand} timeline={timeline} checklist={checklist} labels={labels.filter((label) => label.status === "active" || selectedDemand.labels.some((item) => item.id === label.id))} companies={companies.filter((company) => company.status === "active" || company.id === selectedDemand.companyId)} canEdit={demandCanEdit} editMode={demandEditMode} saving={saving} error={demandModalError} onEdit={() => setDemandEditMode(true)} onCancelEdit={() => { setDemandEditMode(false); setDemandModalError(""); }} onClose={() => setSelectedDemand(null)} onSubmit={saveDemand} onReload={() => openDemand(selectedDemand.id)} onToggleChecklist={toggleChecklistItem} onAddChecklist={addChecklistItem} onComment={addComment}/>} 
    {userModal && <UserModal user={userModal} history={userHistory} saving={saving} onClose={() => setUserModal(null)} onSubmit={submitUser}/>} 
    {inactiveConfirm && <ConfirmInactive count={inactiveConfirm.count} onCancel={() => setInactiveConfirm(null)} onConfirm={() => persistUser(inactiveConfirm.payload, true)}/>} 
    {companyModal && <CompanyModal company={companyModal} saving={saving} onClose={() => setCompanyModal(null)} onSubmit={persistCompany}/>} 
    {labelModal && <LabelModal label={labelModal} saving={saving} onClose={() => setLabelModal(null)} onSubmit={persistLabel}/>} 
    {notice && <div className="toast" role="status">{notice}</div>}
  </main>;
}

function DemandCard({ demand, currentUser, team, availableLabels, labelsExpanded, quickOpen, onToggleLabels, onQuickOpen, onQuickSave, onClaim, onOpen, onDragStart }: {
  demand: Demand;
  currentUser: User;
  team: TeamMember[];
  availableLabels: Label[];
  labelsExpanded: boolean;
  quickOpen: boolean;
  onToggleLabels: () => void;
  onQuickOpen: () => void;
  onQuickSave: (changes: { dueDate?: string; assigneeEmail?: string; labelIds?: number[] }) => void;
  onClaim: (id: number) => void;
  onOpen: (id: number) => void;
  onDragStart: (id: number) => void;
}) {
  const due = dueLabel(demand.dueDate, demand.status);
  const canQuickEdit = demand.status !== "done";
  const claim = (event: MouseEvent) => { event.stopPropagation(); onClaim(demand.id); };
  const aged = isAged(demand);
  return <article className={`demand-card ${aged ? "aged" : ""}`} draggable onDragStart={() => onDragStart(demand.id)} onClick={() => onOpen(demand.id)}>
    {demand.labels.length > 0 && <div className={`visual-labels ${labelsExpanded ? "expanded" : "compact"}`}>
      {demand.labels.map((label) => <button key={label.id} style={{ "--label-color": label.color } as React.CSSProperties} title={label.name} onClick={(event) => { event.stopPropagation(); onToggleLabels(); }}>{labelsExpanded ? label.name : ""}</button>)}
    </div>}
    <div className="card-title"><span className="drag-handle">⠿</span><strong>{demand.title}</strong>{canQuickEdit && <button className="quick-trigger" aria-label={`Ações rápidas de ${demand.title}`} onClick={(event) => { event.stopPropagation(); onQuickOpen(); }}><Icon name="edit"/></button>}</div>
    {quickOpen && <QuickActions demand={demand} team={team} labels={availableLabels} onClose={onQuickOpen} onSave={onQuickSave}/>} 
    <div className="card-tags"><span className={`tag ${CATEGORY_COLORS[demand.category] ?? "gray"}`}>{demand.category}</span><span className={`priority ${demand.priority}`}>{({ low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" } as Record<Priority, string>)[demand.priority]}</span></div>
    <p className="company"><Icon name="building"/>{demand.company}</p>
    <div className="card-meta-row">
      {demand.checklistTotal > 0 && <span className={`check-count ${demand.checklistCompleted === demand.checklistTotal ? "complete" : ""}`}><Icon name="check"/>{demand.checklistCompleted}/{demand.checklistTotal}</span>}
      {aged && <span className="aging-alert" title="Sem atualização há mais de 3 dias"><Icon name="alert"/>Parada há +3 dias</span>}
    </div>
    <div className="card-footer">{demand.assignee ? <div className="assignee"><span className="avatar">{initials(demand.assignee)}</span><span>{demand.assignee}</span></div> : <button className="claim" onClick={claim}>Assumir demanda</button>}<span className={`due ${due.className}`}>{due.text}</span></div>
    {demand.assigneeEmail === currentUser.email && demand.status !== "done" && <span className="mine-marker">Sua demanda</span>}
  </article>;
}

function QuickActions({ demand, team, labels, onClose, onSave }: { demand: Demand; team: TeamMember[]; labels: Label[]; onClose: () => void; onSave: (changes: { dueDate?: string; assigneeEmail?: string; labelIds?: number[] }) => void }) {
  const [dueDate, setDueDate] = useState(demand.dueDate);
  const [assigneeEmail, setAssigneeEmail] = useState(demand.assigneeEmail ?? "");
  const [labelIds, setLabelIds] = useState(demand.labels.map((label) => label.id));
  return <div className="quick-actions" onClick={(event) => event.stopPropagation()}>
    <header><strong>Ações rápidas</strong><button onClick={onClose} aria-label="Fechar"><Icon name="close"/></button></header>
    <label>Prazo<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)}/></label>
    <label>Responsável<select value={assigneeEmail} onChange={(event) => setAssigneeEmail(event.target.value)}><option value="">Sem responsável</option>{team.map((member) => <option key={member.id} value={member.email}>{member.name}</option>)}</select></label>
    <fieldset><legend>Etiquetas</legend>{labels.map((label) => <label key={label.id}><input type="checkbox" checked={labelIds.includes(label.id)} onChange={(event) => setLabelIds((list) => event.target.checked ? [...list, label.id] : list.filter((id) => id !== label.id))}/><i style={{ background: label.color }}/><span>{label.name}</span></label>)}</fieldset>
    <button className="primary compact-button" onClick={() => onSave({ dueDate, labelIds, assigneeEmail })}>Aplicar agora</button>
  </div>;
}

function Overview({ demands, currentUser, onOpenBoard }: { demands: Demand[]; currentUser: User; onOpenBoard: () => void }) {
  const mine = demands.filter((d) => d.assigneeEmail === currentUser.email && d.status !== "done");
  const aged = demands.filter(isAged).length;
  const categories = Object.entries(demands.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.category]: (acc[d.category] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = Math.max(1, ...categories.map(([, value]) => value));
  return <div className="dashboard-grid">
    <section className="panel welcome"><div><span className="panel-kicker">Bom trabalho, {currentUser.name.split(" ")[0]}</span><h2>Você tem {mine.length} demandas em andamento</h2><p>{aged ? `${aged} cartão(ões) aguardam informações há mais de três dias.` : "A fila está sem gargalos antigos em espera."}</p><button className="primary small" onClick={onOpenBoard}>Abrir quadro</button></div><div className="welcome-mark">DP</div></section>
    <section className="panel"><div className="panel-header"><div><span className="panel-kicker">Distribuição</span><h2>Demandas por categoria</h2></div><span className="muted">Total {demands.length}</span></div><div className="bars">{categories.map(([name, value]) => <div className="bar-row" key={name}><span>{name}</span><div><i style={{ width: `${(value / max) * 100}%` }}/></div><strong>{value}</strong></div>)}</div></section>
    <section className="panel"><div className="panel-header"><div><span className="panel-kicker">Próximos prazos</span><h2>Atenção hoje</h2></div></div><div className="deadline-list">{demands.filter((d) => d.status !== "done").slice(0, 4).map((d) => <div key={d.id}><span className={`tag ${CATEGORY_COLORS[d.category]}`}>{d.category}</span><div><strong>{d.title}</strong><small>{d.company}</small></div><span className={`due ${dueLabel(d.dueDate, d.status).className}`}>{dueLabel(d.dueDate, d.status).text}</span></div>)}</div></section>
  </div>;
}

function Reports({ demands }: { demands: Demand[] }) {
  const done = demands.filter((d) => d.status === "done").length;
  const total = demands.length;
  const percent = total ? Math.round(done / total * 100) : 0;
  const sourcesList = ["E-mail", "WhatsApp", "Verbal"].map((source) => ({ source, value: demands.filter((d) => d.source === source).length }));
  return <div className="reports-grid">
    <section className="panel report-hero"><span className="panel-kicker">Resumo operacional</span><h2>{percent}% das demandas concluídas</h2><div className="progress"><i style={{ width: `${percent}%` }}/></div><p>{done} concluídas de {total} cadastradas.</p></section>
    <section className="panel"><div className="panel-header"><div><span className="panel-kicker">Origem</span><h2>Canais de entrada</h2></div></div><div className="source-list">{sourcesList.map((item) => <div key={item.source}><span>{item.source}</span><strong>{item.value}</strong></div>)}</div></section>
    <section className="panel wide"><div className="panel-header"><div><span className="panel-kicker">Equipe</span><h2>Carga por analista</h2></div></div><div className="analyst-table">{Array.from(new Set(demands.map((d) => d.assignee).filter(Boolean))).map((name) => <div key={name}><span className="avatar">{initials(name!)}</span><strong>{name}</strong><span>{demands.filter((d) => d.assignee === name && d.status !== "done").length} ativas</span><span>{demands.filter((d) => d.assignee === name && d.status === "done").length} concluídas</span></div>)}</div></section>
  </div>;
}

function Settings({ currentUser, labels, templates, onManageUsers, onManageCompanies, onNewLabel, onEditLabel, onAddTemplate, onToggleTemplate }: {
  currentUser: User;
  labels: Label[];
  templates: ChecklistTemplate[];
  onManageUsers: () => void;
  onManageCompanies: () => void;
  onNewLabel: () => void;
  onEditLabel: (label: Label) => void;
  onAddTemplate: (category: string, text: string) => void;
  onToggleTemplate: (template: ChecklistTemplate) => void;
}) {
  const [templateCategory, setTemplateCategory] = useState("Admissão");
  const [templateText, setTemplateText] = useState("");
  return <div className="settings-grid">
    <section className="panel"><span className="panel-kicker">Conta</span><h2>Seu perfil</h2><div className="profile-card"><span className="avatar xlarge">{initials(currentUser.name)}</span><div><strong>{currentUser.name}</strong><span>{currentUser.email}</span><small>{currentUser.role === "admin" ? "Administrador" : "Analista com acesso completo"}</small></div></div></section>
    <section className="panel"><span className="panel-kicker">Tipos de demanda</span><h2>Categorias ativas</h2><div className="category-cloud">{CATEGORIES.map((category) => <span className={`tag ${CATEGORY_COLORS[category]}`} key={category}>{category}</span>)}</div></section>
    <>
      <section className="panel wide admin-links"><div><span className="panel-kicker">Cadastros mestres</span><h2>Equipe e empresas</h2><p>Controle quem acessa o sistema e mantenha a lista de empresas usada nas demandas.</p></div><div><button className="secondary" onClick={onManageCompanies}>Gerenciar empresas</button><button className="primary" onClick={onManageUsers}>Gerenciar usuários</button></div></section>
      <section className="panel wide config-section"><div className="panel-header"><div><span className="panel-kicker">Contexto visual</span><h2>Etiquetas configuráveis</h2></div><button className="secondary" onClick={onNewLabel}><Icon name="plus"/>Nova etiqueta</button></div><div className="label-admin-grid">{labels.map((label) => <button key={label.id} className={label.status} onClick={() => onEditLabel(label)}><i style={{ background: label.color }}/><span><strong>{label.name}</strong><small>{label.status === "active" ? "Ativa" : "Inativa"}</small></span><Icon name="edit"/></button>)}</div></section>
      <section className="panel wide config-section"><div className="panel-header"><div><span className="panel-kicker">Padronização</span><h2>Modelos automáticos de checklist</h2></div></div><form className="template-add" onSubmit={(event) => { event.preventDefault(); if (templateText.trim()) { onAddTemplate(templateCategory, templateText.trim()); setTemplateText(""); } }}><select value={templateCategory} onChange={(event) => setTemplateCategory(event.target.value)}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select><input value={templateText} onChange={(event) => setTemplateText(event.target.value)} placeholder="Nova etapa do processo..." maxLength={240}/><button className="primary compact-button">Adicionar etapa</button></form><div className="template-groups">{CATEGORIES.filter((category) => templates.some((template) => template.category === category)).map((category) => <section key={category}><h3><span className={`tag ${CATEGORY_COLORS[category]}`}>{category}</span><small>{templates.filter((template) => template.category === category && template.status === "active").length} etapas ativas</small></h3>{templates.filter((template) => template.category === category).map((template) => <div className={template.status} key={template.id}><span>{template.text}</span><button onClick={() => onToggleTemplate(template)}>{template.status === "active" ? "Desativar" : "Reativar"}</button></div>)}</section>)}</div></section>
    </>
  </div>;
}

function UsersView({ users, search, roleFilter, statusFilter, setSearch, setRoleFilter, setStatusFilter, onEdit }: { users: ManagedUser[]; search: string; roleFilter: string; statusFilter: string; setSearch: (v: string) => void; setRoleFilter: (v: string) => void; setStatusFilter: (v: string) => void; onEdit: (user: ManagedUser) => void }) {
  return <section className="panel users-panel"><div className="users-toolbar"><label className="search"><Icon name="search"/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome ou e-mail..."/></label><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">Todos os perfis</option><option value="analyst">Analistas</option><option value="admin">Administradores</option></select><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Todos os status</option><option value="active">Ativos</option><option value="inactive">Inativos</option></select><span className="result-count">{users.length} usuários</span></div>{users.length ? <div className="users-table"><div className="table-head"><span>Nome</span><span>E-mail</span><span>Perfil</span><span>Status</span><span>Último acesso</span><span>Ações</span></div>{users.map((user) => <div className="user-row" key={user.id}><div className="user-identity"><span className="avatar">{initials(user.displayName)}</span><strong>{user.displayName}</strong></div><span>{user.email}</span><span className="role-badge">{user.role === "admin" ? "Administrador" : "Analista"}</span><span className={`status-badge ${user.status}`}>{user.status === "active" ? "Ativo" : "Inativo"}</span><span>{formatDateTime(user.lastAccessAt)}</span><button className="table-action" onClick={() => onEdit(user)}>Editar</button></div>)}</div> : <EmptyState title="Nenhum usuário encontrado" text="Altere os filtros ou cadastre um novo usuário."/>}</section>;
}

function CompaniesView({ companies, search, statusFilter, setSearch, setStatusFilter, onEdit }: { companies: Company[]; search: string; statusFilter: string; setSearch: (value: string) => void; setStatusFilter: (value: string) => void; onEdit: (company: Company) => void }) {
  return <section className="panel users-panel"><div className="users-toolbar"><label className="search"><Icon name="search"/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar empresa, razão social ou CNPJ..."/></label><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Todos os status</option><option value="active">Ativas</option><option value="inactive">Inativas</option></select><span className="result-count">{companies.length} empresas</span></div>{companies.length ? <div className="companies-table"><div className="company-head"><span>Nome fantasia</span><span>Razão social</span><span>CNPJ</span><span>Demandas</span><span>Status</span><span>Ações</span></div>{companies.map((company) => <div className="company-row" key={company.id}><div className="user-identity"><span className="company-avatar"><Icon name="building"/></span><strong>{company.tradeName}</strong></div><span>{company.legalName}</span><span>{formatCnpj(company.cnpj)}</span><span>{company.demandCount ?? 0}</span><span className={`status-badge ${company.status}`}>{company.status === "active" ? "Ativa" : "Inativa"}</span><button className="table-action" onClick={() => onEdit(company)}>Editar</button></div>)}</div> : <EmptyState title="Nenhuma empresa encontrada" text="Cadastre a primeira empresa para abrir novas demandas."/>}</section>;
}

function DemandDetailModal({ demand, timeline, checklist, labels, companies, canEdit, editMode, saving, error, onEdit, onCancelEdit, onClose, onSubmit, onReload, onToggleChecklist, onAddChecklist, onComment }: {
  demand: Demand;
  timeline: TimelineEvent[];
  checklist: ChecklistItem[];
  labels: Label[];
  companies: Company[];
  canEdit: boolean;
  editMode: boolean;
  saving: boolean;
  error: string;
  onEdit: () => void;
  onCancelEdit: () => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onReload: () => void;
  onToggleChecklist: (item: ChecklistItem, completed: boolean) => void;
  onAddChecklist: (text: string) => void;
  onComment: (text: string) => void;
}) {
  const [tab, setTab] = useState<"details" | "activity">("details");
  return <div className="modal-backdrop"><section className="modal detail-modal" role="dialog" aria-modal="true" aria-labelledby="demand-detail-title">
    <header><div><span className="panel-kicker">Demanda #{demand.id} · versão {demand.version}</span><h2 id="demand-detail-title">{demand.title}</h2><p>{demand.company}</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close"/></button></header>
    <div className="modal-tabs"><button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>Detalhes e checklist</button><button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Atividade <span>{timeline.length}</span></button></div>
    {tab === "details" ? <form onSubmit={onSubmit} className="detail-form">
      <div className="form-grid">
        <label><span>Tipo</span><select name="category" defaultValue={demand.category} disabled={!editMode}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label><span>Canal de origem</span><select name="source" defaultValue={demand.source} disabled={!editMode}><option>E-mail</option><option>WhatsApp</option><option>Verbal</option></select></label>
        <label className="full"><span>Empresa</span><select name="companyId" defaultValue={demand.companyId ?? ""} disabled={!editMode}><option value="">Selecione</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.tradeName}{company.status === "inactive" ? " (inativa)" : ""}</option>)}</select></label>
        <label><span>Funcionário</span><input name="employee" defaultValue={demand.employee ?? ""} disabled={!editMode}/></label>
        <label><span>Solicitante</span><input name="requester" defaultValue={demand.requester} disabled={!editMode}/></label>
        <label><span>Prioridade</span><select name="priority" defaultValue={demand.priority} disabled={!editMode}><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
        <label><span>Prazo</span><input name="dueDate" type="date" defaultValue={demand.dueDate} disabled={!editMode}/></label>
        <label className="full"><span>Descrição</span><textarea name="description" rows={4} defaultValue={demand.description} disabled={!editMode}/></label>
        <fieldset className="label-picker full"><legend>Etiquetas visuais</legend>{labels.map((label) => <label key={label.id}><input name="labelIds" value={label.id} type="checkbox" defaultChecked={demand.labels.some((item) => item.id === label.id)} disabled={!editMode}/><i style={{ background: label.color }}/><span>{label.name}</span></label>)}</fieldset>
        {editMode && demand.status === "done" && <label className="full justification"><span>Motivo da edição *</span><textarea name="justification" rows={3} required placeholder="Explique por que uma demanda concluída precisa ser alterada..."/></label>}
      </div>
      {error && <div className="form-error"><span>{error}</span>{error.includes("alterada por outro usuário") && <button type="button" onClick={onReload}>Recarregar dados</button>}</div>}
      <ChecklistPanel checklist={checklist} canEdit={canEdit} saving={saving} onToggle={onToggleChecklist} onAdd={onAddChecklist}/>
      <footer>{editMode ? <><button type="button" className="secondary" onClick={onCancelEdit}>Cancelar edição</button><button className="primary" disabled={saving}>Salvar alterações</button></> : <>{!canEdit && <span className="readonly-note">Visualização somente leitura</span>}{canEdit && <button type="button" className="primary" onClick={onEdit}>Editar demanda</button>}</>}</footer>
    </form> : <ActivityTimeline timeline={timeline} saving={saving} onComment={onComment}/>} 
  </section></div>;
}

function ChecklistPanel({ checklist, canEdit, saving, onToggle, onAdd }: { checklist: ChecklistItem[]; canEdit: boolean; saving: boolean; onToggle: (item: ChecklistItem, completed: boolean) => void; onAdd: (text: string) => void }) {
  const completed = checklist.filter((item) => Boolean(item.completed)).length;
  const percent = checklist.length ? Math.round(completed / checklist.length * 100) : 0;
  const [text, setText] = useState("");
  return <section className="checklist-panel"><div className="checklist-heading"><div><span className="panel-kicker">Fluxo do processo</span><h3>Checklist</h3></div><strong>{completed}/{checklist.length} · {percent}%</strong></div><div className="checklist-progress"><i style={{ width: `${percent}%` }}/></div>{checklist.length ? <div className="checklist-items">{checklist.map((item) => <label key={item.id} className={item.completed ? "completed" : ""}><input type="checkbox" checked={Boolean(item.completed)} disabled={!canEdit} onChange={(event) => onToggle(item, event.target.checked)}/><span className="custom-check"><Icon name="check"/></span><span><strong>{item.text}</strong>{item.completedAt && <small>Concluído por {item.completedBy ?? "usuário"} em {formatDateTime(item.completedAt)}</small>}</span></label>)}</div> : <div className="empty-checklist">Nenhuma etapa cadastrada para esta demanda.</div>}{canEdit && <div className="checklist-add"><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Adicionar uma etapa específica..." maxLength={240}/><button type="button" className="secondary" disabled={saving || !text.trim()} onClick={() => { onAdd(text.trim()); setText(""); }}><Icon name="plus"/>Adicionar</button></div>}</section>;
}

function ActivityTimeline({ timeline, saving, onComment }: { timeline: TimelineEvent[]; saving: boolean; onComment: (text: string) => void }) {
  const [text, setText] = useState("");
  const actionLabel: Record<string, string> = { created: "Demanda criada", claimed: "Demanda assumida", status_changed: "Status alterado", edited: "Campo editado", returned: "Devolvida para a fila", reopened: "Demanda reaberta", checklist_updated: "Checklist atualizado", checklist_added: "Item de checklist criado", checklist_created: "Checklist automático criado" };
  return <div className="activity-shell"><div className="activity-list">{timeline.length ? timeline.map((item) => item.eventType === "comment" ? <article className="comment-event" key={`comment-${item.id}`}><span className="avatar">{initials(item.userName)}</span><div><header><strong>{item.userName}</strong><time>{formatDateTime(item.createdAt)}</time></header><p>{item.text}</p></div></article> : <article className="system-event" key={`system-${item.id}`}><span className="activity-icon"><Icon name={item.action?.startsWith("checklist") ? "check" : "edit"}/></span><div><strong>{item.fieldChanged ? `${item.fieldChanged}: ${item.oldValue || "—"} → ${item.newValue || "—"}` : actionLabel[item.action ?? ""] ?? item.details}</strong><p>{item.details && item.fieldChanged ? `${item.details} · ` : ""}por {item.userName} em {formatDateTime(item.createdAt)}</p>{item.justification && <blockquote>Motivo: {item.justification}</blockquote>}</div></article>) : <EmptyState title="Nenhuma atividade ainda" text="Alterações e comentários aparecerão juntos aqui."/>}</div><form className="comment-composer" onSubmit={(event) => { event.preventDefault(); if (text.trim()) { onComment(text.trim()); setText(""); } }}><span className="avatar">DP</span><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Adicionar um comentário para a equipe..." maxLength={2000} rows={3}/><button className="primary" disabled={saving || !text.trim()}><Icon name="comment"/>Comentar</button></form></div>;
}

function UserModal({ user, history, saving, onClose, onSubmit }: { user: ManagedUser | "new"; history: UserHistory[]; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const isNew = user === "new";
  const data = isNew ? null : user;
  const [tab, setTab] = useState<"details" | "history">("details");
  return <div className="modal-backdrop"><section className="modal user-modal" role="dialog" aria-modal="true" aria-labelledby="user-modal-title"><header><div><span className="panel-kicker">Administração de acesso</span><h2 id="user-modal-title">{isNew ? "Novo usuário" : "Editar usuário"}</h2><p>{isNew ? "O acesso será feito pela conta ChatGPT do e-mail informado." : data?.email}</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close"/></button></header>{!isNew && <div className="modal-tabs"><button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>Dados</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Histórico <span>{history.length}</span></button></div>}{tab === "details" ? <form onSubmit={onSubmit}><div className="form-grid"><label className="full"><span>Nome completo *</span><input name="name" minLength={3} required defaultValue={data?.displayName ?? ""}/></label><label className="full"><span>E-mail *</span><input name="email" type="email" required defaultValue={data?.email ?? ""}/></label><label><span>Perfil *</span><select name="role" defaultValue={data?.role ?? "analyst"}><option value="analyst">Analista</option><option value="admin">Administrador</option></select></label>{!isNew && <label><span>Status</span><select name="status" defaultValue={data?.status ?? "active"}><option value="active">Ativo</option><option value="inactive">Inativo</option></select></label>}</div><div className="access-note"><strong>Acesso seguro</strong><p>O usuário entrará com a conta ChatGPT vinculada ao e-mail cadastrado.</p></div><footer><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={saving}>{isNew ? "Cadastrar usuário" : "Salvar alterações"}</button></footer></form> : <div className="history-list">{history.length ? history.map((item) => <article key={item.id}><span className="history-dot edited"/><div><strong>{item.fieldChanged ? `${item.fieldChanged}: ${item.oldValue || "—"} → ${item.newValue || "—"}` : "Usuário criado"}</strong><p>por {item.actorName} em {formatDateTime(item.createdAt)}</p></div></article>) : <EmptyState title="Nenhuma alteração registrada"/>}</div>}</section></div>;
}

function CompanyModal({ company, saving, onClose, onSubmit }: { company: Company | "new"; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const isNew = company === "new";
  const data = isNew ? null : company;
  return <div className="modal-backdrop"><section className="modal user-modal" role="dialog" aria-modal="true"><header><div><span className="panel-kicker">Cadastro mestre</span><h2>{isNew ? "Nova empresa" : "Editar empresa"}</h2><p>Empresas inativas continuam visíveis no histórico.</p></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></header><form onSubmit={onSubmit}><div className="form-grid"><label className="full"><span>Nome fantasia *</span><input name="tradeName" required minLength={2} defaultValue={data?.tradeName ?? ""}/></label><label className="full"><span>Razão social *</span><input name="legalName" required minLength={2} defaultValue={data?.legalName ?? ""}/></label><label><span>CNPJ</span><input name="cnpj" inputMode="numeric" defaultValue={data?.cnpj ?? ""} placeholder="00.000.000/0000-00"/></label>{!isNew && <label><span>Status</span><select name="status" defaultValue={data?.status}><option value="active">Ativa</option><option value="inactive">Inativa</option></select></label>}</div><div className="access-note"><strong>Sem exclusão</strong><p>Ao inativar, a empresa sai das novas demandas, mas permanece nos cartões antigos e relatórios.</p></div><footer><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={saving}>{isNew ? "Cadastrar empresa" : "Salvar empresa"}</button></footer></form></section></div>;
}

function LabelModal({ label, saving, onClose, onSubmit }: { label: Label | "new"; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const isNew = label === "new";
  const data = isNew ? null : label;
  return <div className="modal-backdrop"><section className="modal user-modal" role="dialog" aria-modal="true"><header><div><span className="panel-kicker">Sinalização visual</span><h2>{isNew ? "Nova etiqueta" : "Editar etiqueta"}</h2><p>Use nomes curtos que comuniquem risco ou dependência.</p></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></header><form onSubmit={onSubmit}><div className="form-grid"><label className="full"><span>Nome *</span><input name="name" required minLength={2} defaultValue={data?.name ?? ""} placeholder="Ex.: Risco de Multa"/></label><label><span>Cor</span><input className="color-input" name="color" type="color" defaultValue={data?.color ?? "#dc3f45"}/></label>{!isNew && <label><span>Status</span><select name="status" defaultValue={data?.status}><option value="active">Ativa</option><option value="inactive">Inativa</option></select></label>}</div><footer><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={saving}>{isNew ? "Criar etiqueta" : "Salvar etiqueta"}</button></footer></form></section></div>;
}

function ConfirmInactive({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop confirm-layer"><section className="confirm-modal"><span className="confirm-icon">!</span><h2>Inativar usuário com demandas ativas</h2><p>Este usuário possui <strong>{count} demanda(s)</strong> em andamento. Elas continuarão atribuídas até serem reatribuídas manualmente.</p><footer><button className="secondary" onClick={onCancel}>Cancelar</button><button className="danger-button" onClick={onConfirm}>Confirmar inativação</button></footer></section></div>;
}

function NewDemandModal({ companies, labels, templates, onClose, onSubmit }: { companies: Company[]; labels: Label[]; templates: ChecklistTemplate[]; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [category, setCategory] = useState("");
  const automaticCount = templates.filter((template) => template.category === category).length;
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-demand-title"><header><div><span className="panel-kicker">Cadastro interno</span><h2 id="new-demand-title">Nova demanda</h2><p>Registre a solicitação recebida pela equipe de DP.</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close"/></button></header><form onSubmit={onSubmit}><div className="form-grid"><label><span>Tipo de demanda</span><select name="category" required value={category} onChange={(event) => setCategory(event.target.value)}><option value="" disabled>Selecione</option>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label><label><span>Canal de origem</span><select name="source" required><option>E-mail</option><option>WhatsApp</option><option>Verbal</option></select></label><label className="full"><span>Empresa</span><select name="companyId" required defaultValue=""><option value="" disabled>Selecione uma empresa ativa</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.tradeName}</option>)}</select>{!companies.length && <small className="field-warning">Cadastre uma empresa antes de abrir a demanda.</small>}</label><label><span>Funcionário relacionado</span><input name="employee" placeholder="Opcional para demandas gerais"/></label><label><span>Solicitante</span><input name="requester" required placeholder="Nome ou setor"/></label><label><span>Prioridade</span><select name="priority" defaultValue="medium"><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label><label><span>Prazo</span><input name="dueDate" type="date" required/></label><label className="full"><span>Descrição</span><textarea name="description" rows={3}/></label>{labels.length > 0 && <fieldset className="label-picker full"><legend>Etiquetas iniciais</legend>{labels.map((label) => <label key={label.id}><input name="labelIds" value={label.id} type="checkbox"/><i style={{ background: label.color }}/><span>{label.name}</span></label>)}</fieldset>}{category && <div className="automation-note full"><Icon name="check"/><div><strong>Checklist automático</strong><p>{automaticCount ? `${automaticCount} etapas serão adicionadas ao criar esta demanda.` : "Este tipo ainda não possui um modelo; você poderá adicionar etapas no cartão."}</p></div></div>}</div><footer><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={!companies.length}>Adicionar à fila</button></footer></form></section></div>;
}

function EmptyState({ title, text }: { title: string; text?: string }) {
  return <div className="empty-users"><strong>{title}</strong>{text && <p>{text}</p>}</div>;
}
