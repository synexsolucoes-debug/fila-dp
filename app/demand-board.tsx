"use client";

import { FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";

type Status = "available" | "in_progress" | "waiting" | "done";
type Priority = "low" | "medium" | "high" | "urgent";
type View = "overview" | "demands" | "mine" | "reports" | "settings" | "users";

type User = { name: string; email: string; role: "admin" | "analyst" };
type ManagedUser = {
  id: number;
  displayName: string;
  email: string;
  role: "admin" | "analyst";
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string | null;
};

type Demand = {
  id: number;
  title: string;
  description: string;
  category: string;
  company: string;
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
};

type DemandHistory = {
  id: number;
  action: string;
  details: string;
  userName: string;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  justification: string | null;
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

const CATEGORY_COLORS: Record<string, string> = {
  Admissão: "green", Férias: "blue", Rescisão: "red", Ponto: "amber",
  Folha: "violet", Benefícios: "orange", Afastamento: "slate",
  eSocial: "indigo", Atendimento: "teal", Outros: "gray",
};

const initialDemands: Demand[] = [
  { id: 1, title: "Admissão – Mariana Costa", description: "Conferir documentação admissional.", category: "Admissão", company: "Empresa Alfa Ltda.", employee: "Mariana Costa", requester: "Recrutamento", source: "E-mail", priority: "high", dueDate: "2026-07-18", status: "available", assignee: null, assigneeEmail: null, version: 1 },
  { id: 2, title: "Ajuste de ponto – Carlos Souza", description: "Ajustar marcação do dia 16.", category: "Ponto", company: "Empresa Alfa Ltda.", employee: "Carlos Souza", requester: "Gestor imediato", source: "WhatsApp", priority: "urgent", dueDate: "2026-07-17", status: "in_progress", assignee: "Rian Oliveira", assigneeEmail: "rian@filadp.local", version: 2 },
  { id: 3, title: "Benefício – Ana Paula", description: "Inclusão no benefício alimentação.", category: "Benefícios", company: "Empresa Eta Ltda.", employee: "Ana Paula", requester: "Gestor imediato", source: "Verbal", priority: "medium", dueDate: "2026-07-20", status: "waiting", assignee: "Rian Oliveira", assigneeEmail: "rian@filadp.local", version: 2 },
  { id: 4, title: "Férias – Gabriel Martins", description: "Férias processadas e conferidas.", category: "Férias", company: "Empresa Alfa Ltda.", employee: "Gabriel Martins", requester: "Gestor imediato", source: "E-mail", priority: "low", dueDate: "2026-07-15", status: "done", assignee: "Rian Oliveira", assigneeEmail: "rian@filadp.local", version: 3 },
];

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10M9 20v-6h6v6"/></>,
    inbox: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M8 5V3h8v2M8 12h2l2 2 2-2h2"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 3.5-6 8-6s7.2 1.8 8 6"/></>,
    chart: <><path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7M2 20h20"/></>,
    gear: <><circle cx="12" cy="12" r="3"/><path d="m19 13.5 2 1.2-2 3.4-2.1-1a8 8 0 0 1-2.2 1.3l-.2 2.3h-4l-.2-2.3A8 8 0 0 1 8 17.1l-2.1 1-2-3.4 2-1.2a8 8 0 0 1 0-2.6l-2-1.2 2-3.4 2.1 1a8 8 0 0 1 2.2-1.3l.2-2.3h4l.2 2.3A8 8 0 0 1 17 7.3l2.1-1 2 3.4-2 1.2a8 8 0 0 1 0 2.6Z"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    filter: <path d="M4 5h16l-6 7v6l-4 2v-8Z"/>, plus: <path d="M12 5v14M5 12h14"/>,
    building: <><path d="M5 21V5h10v16M15 10h4v11M8 8h1M11 8h1M8 12h1M11 12h1M8 16h1M11 16h1M3 21h18"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
    alert: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

const initials = (name: string) => name.split(" ").slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const formatDateTime = (value?: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`)) : "Nunca acessou";

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

export default function DemandBoard({ currentUser }: { currentUser: User }) {
  const [demands, setDemands] = useState(initialDemands);
  const [activeUser, setActiveUser] = useState(currentUser);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [view, setView] = useState<View>("demands");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState<Priority | "all">("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [newDemandOpen, setNewDemandOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [selectedDemand, setSelectedDemand] = useState<Demand | null>(null);
  const [demandHistory, setDemandHistory] = useState<DemandHistory[]>([]);
  const [demandCanEdit, setDemandCanEdit] = useState(false);
  const [demandEditMode, setDemandEditMode] = useState(false);
  const [demandModalError, setDemandModalError] = useState("");
  const [userModal, setUserModal] = useState<ManagedUser | "new" | null>(null);
  const [userHistory, setUserHistory] = useState<UserHistory[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState("all");
  const [userStatusFilter, setUserStatusFilter] = useState("all");
  const [inactiveConfirm, setInactiveConfirm] = useState<{ payload: Record<string, unknown>; count: number } | null>(null);

  function flash(message: string) { setNotice(message); window.setTimeout(() => setNotice(""), 2800); }

  async function loadUsers() {
    const response = await fetch("/api/users", { cache: "no-store" });
    const data = await response.json() as { users?: ManagedUser[] };
    if (response.ok) setUsers(data.users ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/demands", { cache: "no-store" });
        const data = await response.json() as { demands?: Demand[]; user?: User; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Não foi possível carregar as demandas.");
        if (!cancelled) {
          setDemands(data.demands ?? []);
          if (data.user) setActiveUser(data.user);
        }
        if ((data.user ?? currentUser).role === "admin") await loadUsers();
      } catch (error) { if (!cancelled) flash(error instanceof Error ? error.message : "Erro ao carregar os dados."); }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [currentUser]);

  const filtered = useMemo(() => demands.filter((demand) => {
    const text = `${demand.title} ${demand.company} ${demand.category} ${demand.assignee ?? ""}`.toLowerCase();
    return text.includes(query.toLowerCase()) && (priority === "all" || demand.priority === priority) && (view !== "mine" || demand.assigneeEmail === activeUser.email);
  }), [demands, priority, query, view, activeUser.email]);

  const filteredUsers = useMemo(() => users.filter((user) => {
    const text = `${user.displayName} ${user.email}`.toLowerCase();
    return text.includes(userSearch.toLowerCase()) && (userRoleFilter === "all" || user.role === userRoleFilter) && (userStatusFilter === "all" || user.status === userStatusFilter);
  }), [users, userSearch, userRoleFilter, userStatusFilter]);

  const counts = useMemo(() => ({
    available: demands.filter((d) => d.status === "available").length,
    active: demands.filter((d) => d.status === "in_progress").length,
    overdue: demands.filter((d) => d.status !== "done" && new Date(`${d.dueDate}T23:59:59`) < new Date()).length,
  }), [demands]);

  async function claimDemand(id: number) {
    setSaving(true);
    try {
      const response = await fetch(`/api/demands/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "claim" }) });
      const data = await response.json() as { demand?: Demand; error?: string };
      if (!response.ok || !data.demand) throw new Error(data.error ?? "Não foi possível assumir a demanda.");
      setDemands((list) => list.map((item) => item.id === id ? data.demand! : item)); flash("Demanda assumida com sucesso.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao assumir demanda."); }
    finally { setSaving(false); }
  }

  async function moveDemand(id: number, status: Status) {
    setSaving(true);
    try {
      const response = await fetch(`/api/demands/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move", status }) });
      const data = await response.json() as { demand?: Demand; error?: string; message?: string };
      if (!response.ok || !data.demand) throw new Error(data.message ?? data.error ?? "Não foi possível movimentar a demanda.");
      setDemands((list) => list.map((item) => item.id === id ? data.demand! : item)); flash("Status atualizado.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao movimentar demanda."); }
    finally { setSaving(false); }
  }

  async function createDemand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true);
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const response = await fetch("/api/demands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json() as { demand?: Demand; error?: string };
      if (!response.ok || !data.demand) throw new Error(data.error ?? "Não foi possível cadastrar.");
      setDemands((list) => [data.demand!, ...list]); setNewDemandOpen(false); setView("demands"); flash("Demanda cadastrada.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao cadastrar demanda."); }
    finally { setSaving(false); }
  }

  async function openDemand(id: number) {
    setDemandModalError(""); setDemandEditMode(false); setSaving(true);
    try {
      const [detailResponse, historyResponse] = await Promise.all([fetch(`/api/demands/${id}`, { cache: "no-store" }), fetch(`/api/demands/${id}/history`, { cache: "no-store" })]);
      const detail = await detailResponse.json() as { demand?: Demand; canEdit?: boolean; error?: string };
      const history = await historyResponse.json() as { history?: DemandHistory[] };
      if (!detailResponse.ok || !detail.demand) throw new Error(detail.error ?? "Não foi possível abrir a demanda.");
      setSelectedDemand(detail.demand); setDemandCanEdit(Boolean(detail.canEdit)); setDemandHistory(history.history ?? []);
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao abrir demanda."); }
    finally { setSaving(false); }
  }

  async function saveDemand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selectedDemand) return;
    const data = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = {
      version: selectedDemand.version,
      priority: data.get("priority"), dueDate: data.get("dueDate"), description: data.get("description"),
      justification: data.get("justification"),
    };
    if (activeUser.role === "admin") Object.assign(payload, {
      category: data.get("category"), source: data.get("source"), company: data.get("company"),
      employee: data.get("employee"), requester: data.get("requester"),
    });
    setSaving(true); setDemandModalError("");
    try {
      const response = await fetch(`/api/demands/${selectedDemand.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { demand?: Demand; error?: string; message?: string };
      if (!response.ok || !result.demand) throw new Error(result.message ?? result.error ?? "Não foi possível salvar a demanda.");
      setSelectedDemand(result.demand); setDemands((list) => list.map((item) => item.id === result.demand!.id ? result.demand! : item));
      setDemandEditMode(false); await refreshDemandHistory(result.demand.id); flash("Alterações salvas e registradas no histórico.");
    } catch (error) { setDemandModalError(error instanceof Error ? error.message : "Erro ao salvar demanda."); }
    finally { setSaving(false); }
  }

  async function refreshDemandHistory(id: number) {
    const response = await fetch(`/api/demands/${id}/history`, { cache: "no-store" });
    const data = await response.json() as { history?: DemandHistory[] };
    if (response.ok) setDemandHistory(data.history ?? []);
  }

  async function openUser(user: ManagedUser | "new") {
    setUserModal(user); setUserHistory([]);
    if (user !== "new") {
      const response = await fetch(`/api/users/${user.id}/history`, { cache: "no-store" });
      const data = await response.json() as { history?: UserHistory[] };
      if (response.ok) setUserHistory(data.history ?? []);
    }
  }

  async function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    await persistUser(payload, false);
  }

  async function persistUser(payload: Record<string, unknown>, confirmInactive: boolean) {
    setSaving(true);
    try {
      const isNew = userModal === "new";
      const url = isNew ? "/api/users" : `/api/users/${(userModal as ManagedUser).id}`;
      const response = await fetch(url, { method: isNew ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, confirmInactive }) });
      const data = await response.json() as { user?: ManagedUser; error?: string; message?: string; activeDemandCount?: number; accessMessage?: string };
      if (response.status === 409 && data.error === "ACTIVE_DEMANDS") {
        setInactiveConfirm({ payload, count: data.activeDemandCount ?? 0 }); return;
      }
      if (!response.ok || !data.user) throw new Error(data.message ?? data.error ?? "Não foi possível salvar o usuário.");
      setUsers((list) => isNew ? [...list, data.user!].sort((a, b) => a.displayName.localeCompare(b.displayName)) : list.map((item) => item.id === data.user!.id ? data.user! : item));
      setUserModal(null); setInactiveConfirm(null); flash(isNew ? "Usuário cadastrado. O acesso será feito pela conta ChatGPT informada." : "Usuário atualizado.");
    } catch (error) { flash(error instanceof Error ? error.message : "Erro ao salvar usuário."); }
    finally { setSaving(false); }
  }

  const navItems: Array<{ id: View; label: string; icon: string }> = [
    { id: "overview", label: "Visão geral", icon: "home" }, { id: "demands", label: "Demandas", icon: "inbox" },
    { id: "mine", label: "Minha fila", icon: "user" }, { id: "reports", label: "Relatórios", icon: "chart" },
    { id: "settings", label: "Configurações", icon: "gear" },
    ...(activeUser.role === "admin" ? [{ id: "users" as View, label: "Usuários", icon: "user" }] : []),
  ];

  const title = ({ mine: "Minha fila", overview: "Visão geral", reports: "Relatórios", settings: "Configurações", users: "Gestão de usuários", demands: "Fila DP" } as Record<View, string>)[view];

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span>F</span><strong>Fila DP</strong></div>
      <nav aria-label="Navegação principal">{navItems.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><Icon name={item.icon}/><span>{item.label}</span></button>)}</nav>
      <div className="profile"><span className="avatar large">{initials(activeUser.name)}</span><div><strong>{activeUser.name}</strong><small>{activeUser.role === "admin" ? "Administrador" : "Analista de DP"}</small></div><span className="chevron">⌄</span></div>
    </aside>

    <section className="workspace">
      <header className="topbar">
        <div><p className="eyebrow">Gestão de demandas</p><h1>{title}</h1></div>
        {view !== "users" && <div className="kpis" aria-label="Indicadores da fila">
          <div className="kpi green"><span className="kpi-icon"><Icon name="user"/></span><div><small>Disponíveis</small><strong>{counts.available}</strong></div></div>
          <div className="kpi blue"><span className="kpi-icon"><Icon name="clock"/></span><div><small>Em andamento</small><strong>{counts.active}</strong></div></div>
          <div className="kpi coral"><span className="kpi-icon"><Icon name="alert"/></span><div><small>Atrasadas</small><strong>{counts.overdue}</strong></div></div>
        </div>}
        {view === "users" ? <button className="primary" onClick={() => openUser("new")}><Icon name="plus"/>Novo usuário</button> : <button className="primary" onClick={() => setNewDemandOpen(true)}><Icon name="plus"/>Nova demanda</button>}
      </header>

      {(view === "demands" || view === "mine") && <>
        <div className="toolbar"><label className="search"><Icon name="search"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar demandas..."/></label><div className="filter-wrap"><button className="secondary" onClick={() => setFilterOpen(!filterOpen)}><Icon name="filter"/>Filtros <span>⌄</span></button>{filterOpen && <div className="filter-menu"><strong>Prioridade</strong>{["all", "urgent", "high", "medium", "low"].map((item) => <button key={item} onClick={() => { setPriority(item as Priority | "all"); setFilterOpen(false); }} className={priority === item ? "selected" : ""}>{({ all: "Todas", urgent: "Urgente", high: "Alta", medium: "Média", low: "Baixa" } as Record<string, string>)[item]}</button>)}</div>}</div>{priority !== "all" && <button className="filter-chip" onClick={() => setPriority("all")}>Prioridade: {priority} ×</button>}{(loading || saving) && <span className="sync-state">{loading ? "Carregando..." : "Salvando..."}</span>}<span className="result-count">{filtered.length} demandas</span></div>
        <div className="board">{STATUS.map((column) => { const items = filtered.filter((demand) => demand.status === column.id); return <section className="column" key={column.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedId) moveDemand(draggedId, column.id); setDraggedId(null); }}><header><div><span className="grip">⠿</span><strong>{column.label}</strong></div><span className={`count ${column.id}`}>{items.length}</span></header><div className="card-list">{items.map((demand) => <DemandCard key={demand.id} demand={demand} currentUser={activeUser} onClaim={claimDemand} onOpen={openDemand} onDragStart={setDraggedId}/>)}{items.length === 0 && <div className="empty-column">Nenhuma demanda nesta etapa</div>}</div></section>; })}</div>
      </>}

      {view === "overview" && <Overview demands={demands} currentUser={activeUser} onOpenBoard={() => setView("demands")}/>} 
      {view === "reports" && <Reports demands={demands}/>} 
      {view === "settings" && <Settings currentUser={activeUser} onManageUsers={() => setView("users")}/>} 
      {view === "users" && <UsersView users={filteredUsers} search={userSearch} roleFilter={userRoleFilter} statusFilter={userStatusFilter} setSearch={setUserSearch} setRoleFilter={setUserRoleFilter} setStatusFilter={setUserStatusFilter} onEdit={openUser}/>} 
    </section>

    {newDemandOpen && <NewDemandModal onClose={() => setNewDemandOpen(false)} onSubmit={createDemand}/>} 
    {selectedDemand && <DemandDetailModal demand={selectedDemand} history={demandHistory} canEdit={demandCanEdit} editMode={demandEditMode} currentUser={activeUser} saving={saving} error={demandModalError} onEdit={() => setDemandEditMode(true)} onCancelEdit={() => { setDemandEditMode(false); setDemandModalError(""); }} onClose={() => setSelectedDemand(null)} onSubmit={saveDemand} onReload={() => openDemand(selectedDemand.id)}/>} 
    {userModal && <UserModal user={userModal} history={userHistory} saving={saving} onClose={() => setUserModal(null)} onSubmit={submitUser}/>} 
    {inactiveConfirm && <ConfirmInactive count={inactiveConfirm.count} onCancel={() => setInactiveConfirm(null)} onConfirm={() => persistUser(inactiveConfirm.payload, true)}/>} 
    {notice && <div className="toast" role="status">{notice}</div>}
  </main>;
}

function DemandCard({ demand, currentUser, onClaim, onOpen, onDragStart }: { demand: Demand; currentUser: User; onClaim: (id: number) => void; onOpen: (id: number) => void; onDragStart: (id: number) => void }) {
  const due = dueLabel(demand.dueDate, demand.status);
  const claim = (event: MouseEvent) => { event.stopPropagation(); onClaim(demand.id); };
  return <article className="demand-card" draggable onDragStart={() => onDragStart(demand.id)} onClick={() => onOpen(demand.id)}>
    <div className="card-title"><span className="drag-handle">⠿</span><strong>{demand.title}</strong><button aria-label={`Abrir ${demand.title}`} onClick={(event) => { event.stopPropagation(); onOpen(demand.id); }}>⋮</button></div>
    <div className="card-tags"><span className={`tag ${CATEGORY_COLORS[demand.category] ?? "gray"}`}>{demand.category}</span><span className={`priority ${demand.priority}`}>{({ low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" } as Record<Priority, string>)[demand.priority]}</span></div>
    <p className="company"><Icon name="building"/>{demand.company}</p><div className="card-footer">{demand.assignee ? <div className="assignee"><span className="avatar">{initials(demand.assignee)}</span><span>{demand.assignee}</span></div> : <button className="claim" onClick={claim}>Assumir demanda</button>}<span className={`due ${due.className}`}>{due.text}</span></div>
    {demand.assigneeEmail === currentUser.email && demand.status !== "done" && <span className="mine-marker">Sua demanda</span>}
  </article>;
}

function Overview({ demands, currentUser, onOpenBoard }: { demands: Demand[]; currentUser: User; onOpenBoard: () => void }) {
  const mine = demands.filter((d) => d.assigneeEmail === currentUser.email && d.status !== "done");
  const categories = Object.entries(demands.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.category]: (acc[d.category] ?? 0) + 1 }), {})).sort((a,b) => b[1]-a[1]).slice(0,5);
  const max = Math.max(1, ...categories.map(([, value]) => value));
  return <div className="dashboard-grid"><section className="panel welcome"><div><span className="panel-kicker">Bom trabalho, {currentUser.name.split(" ")[0]}</span><h2>Você tem {mine.length} demandas em andamento</h2><p>Priorize os itens com prazo mais próximo e mantenha a fila atualizada.</p><button className="primary small" onClick={onOpenBoard}>Abrir quadro</button></div><div className="welcome-mark">DP</div></section><section className="panel"><div className="panel-header"><div><span className="panel-kicker">Distribuição</span><h2>Demandas por categoria</h2></div><span className="muted">Total {demands.length}</span></div><div className="bars">{categories.map(([name,value]) => <div className="bar-row" key={name}><span>{name}</span><div><i style={{width:`${(value/max)*100}%`}}/></div><strong>{value}</strong></div>)}</div></section><section className="panel"><div className="panel-header"><div><span className="panel-kicker">Próximos prazos</span><h2>Atenção hoje</h2></div></div><div className="deadline-list">{demands.filter((d) => d.status !== "done").slice(0,4).map((d) => <div key={d.id}><span className={`tag ${CATEGORY_COLORS[d.category]}`}>{d.category}</span><div><strong>{d.title}</strong><small>{d.company}</small></div><span className={`due ${dueLabel(d.dueDate,d.status).className}`}>{dueLabel(d.dueDate,d.status).text}</span></div>)}</div></section></div>;
}

function Reports({ demands }: { demands: Demand[] }) {
  const done = demands.filter((d) => d.status === "done").length; const total = demands.length; const percent = total ? Math.round(done / total * 100) : 0;
  const sourcesList = ["E-mail", "WhatsApp", "Verbal"].map((source) => ({ source, value: demands.filter((d) => d.source === source).length }));
  return <div className="reports-grid"><section className="panel report-hero"><span className="panel-kicker">Resumo operacional</span><h2>{percent}% das demandas concluídas</h2><div className="progress"><i style={{width:`${percent}%`}}/></div><p>{done} concluídas de {total} cadastradas.</p></section><section className="panel"><div className="panel-header"><div><span className="panel-kicker">Origem</span><h2>Canais de entrada</h2></div></div><div className="source-list">{sourcesList.map((item) => <div key={item.source}><span>{item.source}</span><strong>{item.value}</strong></div>)}</div></section><section className="panel wide"><div className="panel-header"><div><span className="panel-kicker">Equipe</span><h2>Carga por analista</h2></div></div><div className="analyst-table">{Array.from(new Set(demands.map((d) => d.assignee).filter(Boolean))).map((name) => <div key={name}><span className="avatar">{initials(name!)}</span><strong>{name}</strong><span>{demands.filter((d) => d.assignee === name && d.status !== "done").length} ativas</span><span>{demands.filter((d) => d.assignee === name && d.status === "done").length} concluídas</span></div>)}</div></section></div>;
}

function Settings({ currentUser, onManageUsers }: { currentUser: User; onManageUsers: () => void }) {
  return <div className="settings-grid"><section className="panel"><span className="panel-kicker">Conta</span><h2>Seu perfil</h2><div className="profile-card"><span className="avatar xlarge">{initials(currentUser.name)}</span><div><strong>{currentUser.name}</strong><span>{currentUser.email}</span><small>{currentUser.role === "admin" ? "Administrador" : "Analista de DP"}</small></div></div></section><section className="panel"><span className="panel-kicker">Tipos de demanda</span><h2>Categorias ativas</h2><div className="category-cloud">{Object.keys(CATEGORY_COLORS).map((category) => <span className={`tag ${CATEGORY_COLORS[category]}`} key={category}>{category}</span>)}</div></section>{currentUser.role === "admin" && <section className="panel wide manage-users-callout"><div><span className="panel-kicker">Administração</span><h2>Usuários e permissões</h2><p>Cadastre analistas, altere perfis e controle acessos inativos com auditoria completa.</p></div><button className="primary" onClick={onManageUsers}>Gerenciar usuários</button></section>}</div>;
}

function UsersView({ users, search, roleFilter, statusFilter, setSearch, setRoleFilter, setStatusFilter, onEdit }: { users: ManagedUser[]; search: string; roleFilter: string; statusFilter: string; setSearch: (v:string)=>void; setRoleFilter:(v:string)=>void; setStatusFilter:(v:string)=>void; onEdit:(u:ManagedUser)=>void }) {
  return <section className="panel users-panel"><div className="users-toolbar"><label className="search"><Icon name="search"/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="Buscar por nome ou e-mail..."/></label><select value={roleFilter} onChange={(e)=>setRoleFilter(e.target.value)}><option value="all">Todos os perfis</option><option value="analyst">Analistas</option><option value="admin">Administradores</option></select><select value={statusFilter} onChange={(e)=>setStatusFilter(e.target.value)}><option value="all">Todos os status</option><option value="active">Ativos</option><option value="inactive">Inativos</option></select><span className="result-count">{users.length} usuários</span></div>{users.length ? <div className="users-table"><div className="table-head"><span>Nome</span><span>E-mail</span><span>Perfil</span><span>Status</span><span>Último acesso</span><span>Ações</span></div>{users.map((user)=><div className="user-row" key={user.id}><div className="user-identity"><span className="avatar">{initials(user.displayName)}</span><strong>{user.displayName}</strong></div><span>{user.email}</span><span className="role-badge">{user.role === "admin" ? "Administrador" : "Analista"}</span><span className={`status-badge ${user.status}`}>{user.status === "active" ? "Ativo" : "Inativo"}</span><span>{formatDateTime(user.lastAccessAt)}</span><button className="table-action" onClick={()=>onEdit(user)}>Editar</button></div>)}</div> : <div className="empty-users"><strong>Nenhum usuário encontrado</strong><p>Altere os filtros ou cadastre um novo usuário.</p></div>}</section>;
}

function DemandDetailModal({ demand, history, canEdit, editMode, currentUser, saving, error, onEdit, onCancelEdit, onClose, onSubmit, onReload }: { demand: Demand; history: DemandHistory[]; canEdit: boolean; editMode: boolean; currentUser: User; saving: boolean; error: string; onEdit:()=>void; onCancelEdit:()=>void; onClose:()=>void; onSubmit:(e:FormEvent<HTMLFormElement>)=>void; onReload:()=>void }) {
  const [tab, setTab] = useState<"details"|"history">("details"); const admin = currentUser.role === "admin";
  return <div className="modal-backdrop"><section className="modal detail-modal" role="dialog" aria-modal="true" aria-labelledby="demand-detail-title"><header><div><span className="panel-kicker">Demanda #{demand.id} · versão {demand.version}</span><h2 id="demand-detail-title">{demand.title}</h2><p>{demand.company}</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close"/></button></header><div className="modal-tabs"><button className={tab === "details" ? "active" : ""} onClick={()=>setTab("details")}>Detalhes</button><button className={tab === "history" ? "active" : ""} onClick={()=>setTab("history")}>Histórico <span>{history.length}</span></button></div>{tab === "details" ? <form onSubmit={onSubmit} className="detail-form"><div className="form-grid"><label><span>Tipo</span><select name="category" defaultValue={demand.category} disabled={!editMode || !admin}>{Object.keys(CATEGORY_COLORS).map((c)=><option key={c}>{c}</option>)}</select></label><label><span>Canal de origem</span><select name="source" defaultValue={demand.source} disabled={!editMode || !admin}><option>E-mail</option><option>WhatsApp</option><option>Verbal</option></select></label><label className="full"><span>Empresa</span><input name="company" defaultValue={demand.company} disabled={!editMode || !admin}/></label><label><span>Funcionário</span><input name="employee" defaultValue={demand.employee ?? ""} disabled={!editMode || !admin}/></label><label><span>Solicitante</span><input name="requester" defaultValue={demand.requester} disabled={!editMode || !admin}/></label><label><span>Prioridade</span><select name="priority" defaultValue={demand.priority} disabled={!editMode}><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label><label><span>Prazo</span><input name="dueDate" type="date" defaultValue={demand.dueDate} disabled={!editMode}/></label><label className="full"><span>Descrição</span><textarea name="description" rows={4} defaultValue={demand.description} disabled={!editMode}/></label>{editMode && demand.status === "done" && admin && <label className="full justification"><span>Motivo da edição *</span><textarea name="justification" rows={3} required placeholder="Explique por que uma demanda concluída precisa ser alterada..."/></label>}</div>{error && <div className="form-error"><span>{error}</span>{error.includes("alterada por outro usuário") && <button type="button" onClick={onReload}>Recarregar dados</button>}</div>}<footer>{editMode ? <><button type="button" className="secondary" onClick={onCancelEdit}>Cancelar edição</button><button className="primary" disabled={saving}>Salvar alterações</button></> : <>{!canEdit && <span className="readonly-note">Visualização somente leitura</span>}{canEdit && <button type="button" className="primary" onClick={onEdit}>Editar demanda</button>}</>}</footer></form> : <HistoryTimeline history={history}/>}</section></div>;
}

function HistoryTimeline({ history }: { history: DemandHistory[] }) {
  const actionLabel: Record<string,string> = { created:"Demanda criada", claimed:"Demanda assumida", status_changed:"Status alterado", edited:"Campo editado", returned:"Devolvida para a fila", reopened:"Demanda reaberta" };
  return <div className="history-list">{history.length ? history.map((item)=><article key={item.id}><span className={`history-dot ${item.action}`}></span><div><strong>{item.fieldChanged ? `${item.fieldChanged}: ${item.oldValue || "—"} → ${item.newValue || "—"}` : actionLabel[item.action] ?? item.details}</strong><p>por {item.userName} em {formatDateTime(item.createdAt)}</p>{item.justification && <blockquote>Motivo: {item.justification}</blockquote>}</div></article>) : <div className="empty-users"><strong>Nenhum registro ainda</strong><p>As movimentações aparecerão aqui.</p></div>}</div>;
}

function UserModal({ user, history, saving, onClose, onSubmit }: { user: ManagedUser|"new"; history:UserHistory[]; saving:boolean; onClose:()=>void; onSubmit:(e:FormEvent<HTMLFormElement>)=>void }) {
  const isNew = user === "new"; const data = isNew ? null : user; const [tab,setTab]=useState<"details"|"history">("details");
  return <div className="modal-backdrop"><section className="modal user-modal" role="dialog" aria-modal="true" aria-labelledby="user-modal-title"><header><div><span className="panel-kicker">Administração de acesso</span><h2 id="user-modal-title">{isNew ? "Novo usuário" : "Editar usuário"}</h2><p>{isNew ? "O acesso será feito pela conta ChatGPT do e-mail informado." : data?.email}</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close"/></button></header>{!isNew && <div className="modal-tabs"><button className={tab==="details"?"active":""} onClick={()=>setTab("details")}>Dados</button><button className={tab==="history"?"active":""} onClick={()=>setTab("history")}>Histórico <span>{history.length}</span></button></div>}{tab === "details" ? <form onSubmit={onSubmit}><div className="form-grid"><label className="full"><span>Nome completo *</span><input name="name" minLength={3} required defaultValue={data?.displayName ?? ""} placeholder="Ex.: Maria Silva"/></label><label className="full"><span>E-mail *</span><input name="email" type="email" required defaultValue={data?.email ?? ""} placeholder="maria@empresa.com"/></label><label><span>Perfil *</span><select name="role" defaultValue={data?.role ?? "analyst"}><option value="analyst">Analista</option><option value="admin">Administrador</option></select></label>{!isNew && <label><span>Status</span><select name="status" defaultValue={data?.status ?? "active"}><option value="active">Ativo</option><option value="inactive">Inativo</option></select></label>}</div><div className="access-note"><strong>Acesso seguro</strong><p>Nenhuma senha será criada neste sistema. O usuário entrará com a conta ChatGPT vinculada ao e-mail cadastrado.</p></div><footer><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={saving}>{isNew ? "Cadastrar usuário" : "Salvar alterações"}</button></footer></form> : <div className="history-list">{history.length ? history.map((item)=><article key={item.id}><span className="history-dot edited"></span><div><strong>{item.fieldChanged ? `${item.fieldChanged}: ${item.oldValue || "—"} → ${item.newValue || "—"}` : "Usuário criado"}</strong><p>por {item.actorName} em {formatDateTime(item.createdAt)}</p></div></article>) : <div className="empty-users"><strong>Nenhuma alteração registrada</strong></div>}</div>}</section></div>;
}

function ConfirmInactive({ count, onCancel, onConfirm }: { count:number; onCancel:()=>void; onConfirm:()=>void }) {
  return <div className="modal-backdrop confirm-layer"><section className="confirm-modal"><span className="confirm-icon">!</span><h2>Inativar usuário com demandas ativas</h2><p>Este usuário possui <strong>{count} demanda(s)</strong> em andamento. Elas continuarão atribuídas até serem reatribuídas manualmente.</p><footer><button className="secondary" onClick={onCancel}>Cancelar</button><button className="danger-button" onClick={onConfirm}>Confirmar inativação</button></footer></section></div>;
}

function NewDemandModal({ onClose, onSubmit }: { onClose:()=>void; onSubmit:(e:FormEvent<HTMLFormElement>)=>void }) {
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-demand-title"><header><div><span className="panel-kicker">Cadastro interno</span><h2 id="new-demand-title">Nova demanda</h2><p>Registre a solicitação recebida pela equipe de DP.</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close"/></button></header><form onSubmit={onSubmit}><div className="form-grid"><label><span>Tipo de demanda</span><select name="category" required defaultValue=""><option value="" disabled>Selecione</option>{Object.keys(CATEGORY_COLORS).map((category)=><option key={category}>{category}</option>)}</select></label><label><span>Canal de origem</span><select name="source" required><option>E-mail</option><option>WhatsApp</option><option>Verbal</option></select></label><label className="full"><span>Empresa</span><input name="company" required placeholder="Ex.: Empresa Alfa Ltda."/></label><label><span>Funcionário relacionado</span><input name="employee" placeholder="Opcional para demandas gerais"/></label><label><span>Solicitante</span><input name="requester" required placeholder="Nome ou setor"/></label><label><span>Prioridade</span><select name="priority" defaultValue="medium"><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label><label><span>Prazo</span><input name="dueDate" type="date" required/></label><label className="full"><span>Descrição</span><textarea name="description" rows={3}/></label></div><footer><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary">Adicionar à fila</button></footer></form></section></div>;
}
