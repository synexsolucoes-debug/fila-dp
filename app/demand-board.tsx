"use client";

import { FormEvent, useMemo, useState } from "react";

type Status = "available" | "in_progress" | "waiting" | "done";
type Priority = "low" | "medium" | "high" | "urgent";
type View = "overview" | "demands" | "mine" | "reports" | "settings";

type User = {
  name: string;
  email: string;
  role: "admin" | "analyst";
};

type Demand = {
  id: number;
  title: string;
  category: string;
  company: string;
  employee?: string;
  requester: string;
  source: string;
  priority: Priority;
  dueDate: string;
  status: Status;
  assignee?: string;
  assigneeEmail?: string;
};

const STATUS: Array<{ id: Status; label: string }> = [
  { id: "available", label: "Disponíveis" },
  { id: "in_progress", label: "Em andamento" },
  { id: "waiting", label: "Aguardando informações" },
  { id: "done", label: "Concluídas" },
];

const CATEGORY_COLORS: Record<string, string> = {
  Admissão: "green",
  Férias: "blue",
  Rescisão: "red",
  Ponto: "amber",
  Folha: "violet",
  Benefícios: "orange",
  Afastamento: "slate",
  eSocial: "indigo",
  Atendimento: "teal",
  Outros: "gray",
};

const initialDemands: Demand[] = [
  { id: 1, title: "Admissão – Mariana Costa", category: "Admissão", company: "Empresa Alfa Ltda.", employee: "Mariana Costa", requester: "Juliana Martins", source: "E-mail", priority: "high", dueDate: "2026-07-17", status: "available" },
  { id: 2, title: "Férias – João Silva", category: "Férias", company: "Empresa Beta S.A.", employee: "João Silva", requester: "Paulo Lima", source: "WhatsApp", priority: "medium", dueDate: "2026-07-18", status: "available" },
  { id: 3, title: "Benefício – Ana Lima", category: "Benefícios", company: "Empresa Gama Ltda.", employee: "Ana Lima", requester: "Luciana Melo", source: "Verbal", priority: "low", dueDate: "2026-07-19", status: "available" },
  { id: 4, title: "eSocial – Empresa 20", category: "eSocial", company: "Empresa Delta Ltda.", requester: "Financeiro", source: "E-mail", priority: "high", dueDate: "2026-07-19", status: "available" },
  { id: 5, title: "Ajuste de ponto – Carlos Souza", category: "Ponto", company: "Empresa Alfa Ltda.", employee: "Carlos Souza", requester: "Gestor imediato", source: "WhatsApp", priority: "urgent", dueDate: "2026-07-17", status: "in_progress", assignee: "Rian Oliveira", assigneeEmail: "rian@filadp.local" },
  { id: 6, title: "Rescisão – Pedro Almeida", category: "Rescisão", company: "Empresa Beta S.A.", employee: "Pedro Almeida", requester: "Diretoria", source: "E-mail", priority: "urgent", dueDate: "2026-07-16", status: "in_progress", assignee: "Mariana Carvalho", assigneeEmail: "mariana@filadp.local" },
  { id: 7, title: "Férias – Beatriz Mendes", category: "Férias", company: "Empresa Gama Ltda.", employee: "Beatriz Mendes", requester: "Gestor imediato", source: "Verbal", priority: "medium", dueDate: "2026-07-18", status: "in_progress", assignee: "Juliana Pinto", assigneeEmail: "juliana@filadp.local" },
  { id: 8, title: "Admissão – Lucas Ferreira", category: "Admissão", company: "Empresa Delta Ltda.", employee: "Lucas Ferreira", requester: "Recrutamento", source: "E-mail", priority: "high", dueDate: "2026-07-19", status: "in_progress", assignee: "Rian Oliveira", assigneeEmail: "rian@filadp.local" },
  { id: 9, title: "eSocial – Empresa 20", category: "eSocial", company: "Empresa Zeta Ltda.", requester: "Contabilidade", source: "E-mail", priority: "high", dueDate: "2026-07-18", status: "waiting", assignee: "Mariana Carvalho", assigneeEmail: "mariana@filadp.local" },
  { id: 10, title: "Benefício – Ana Paula", category: "Benefícios", company: "Empresa Eta Ltda.", employee: "Ana Paula", requester: "Gestor imediato", source: "WhatsApp", priority: "medium", dueDate: "2026-07-20", status: "waiting", assignee: "Rian Oliveira", assigneeEmail: "rian@filadp.local" },
  { id: 11, title: "Ajuste de ponto – Fernando Reis", category: "Ponto", company: "Empresa Alfa Ltda.", employee: "Fernando Reis", requester: "Funcionário", source: "Verbal", priority: "medium", dueDate: "2026-07-20", status: "waiting", assignee: "Juliana Pinto", assigneeEmail: "juliana@filadp.local" },
  { id: 12, title: "Férias – Gabriel Martins", category: "Férias", company: "Empresa Alfa Ltda.", employee: "Gabriel Martins", requester: "Gestor imediato", source: "E-mail", priority: "low", dueDate: "2026-07-15", status: "done", assignee: "Rian Oliveira", assigneeEmail: "rian@filadp.local" },
  { id: 13, title: "Admissão – Juliana Alves", category: "Admissão", company: "Empresa Beta S.A.", employee: "Juliana Alves", requester: "Recrutamento", source: "E-mail", priority: "medium", dueDate: "2026-07-16", status: "done", assignee: "Mariana Carvalho", assigneeEmail: "mariana@filadp.local" },
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
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function initials(name: string) {
  return name.split(" ").slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function dueLabel(dueDate: string, status: Status) {
  if (status === "done") return { text: "Concluída", className: "ok" };
  if (status === "waiting") return { text: "Aguardando", className: "warn" };
  const today = new Date("2026-07-17T12:00:00");
  const due = new Date(`${dueDate}T12:00:00`);
  const diff = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { text: `Atrasada ${Math.abs(diff)}d`, className: "late" };
  if (diff === 0) return { text: "SLA hoje", className: "ok" };
  return { text: `Até ${due.getDate()} jul`, className: "neutral" };
}

export default function DemandBoard({ currentUser }: { currentUser: User }) {
  const [demands, setDemands] = useState(initialDemands);
  const [view, setView] = useState<View>("demands");
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [priority, setPriority] = useState<Priority | "all">("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [notice, setNotice] = useState("");

  const filtered = useMemo(() => {
    return demands.filter((demand) => {
      const haystack = `${demand.title} ${demand.company} ${demand.category} ${demand.assignee ?? ""}`.toLowerCase();
      const matchesSearch = haystack.includes(query.toLowerCase());
      const matchesPriority = priority === "all" || demand.priority === priority;
      const matchesMine = view !== "mine" || demand.assigneeEmail === currentUser.email;
      return matchesSearch && matchesPriority && matchesMine;
    });
  }, [demands, priority, query, view, currentUser.email]);

  const counts = useMemo(() => ({
    available: demands.filter((d) => d.status === "available").length,
    active: demands.filter((d) => d.status === "in_progress").length,
    overdue: demands.filter((d) => d.status !== "done" && d.dueDate < "2026-07-17").length,
  }), [demands]);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2400);
  }

  function claimDemand(id: number) {
    setDemands((current) => current.map((demand) => demand.id === id && !demand.assignee
      ? { ...demand, status: "in_progress", assignee: currentUser.name, assigneeEmail: currentUser.email }
      : demand));
    flash("Demanda assumida com sucesso.");
  }

  function moveDemand(id: number, status: Status) {
    setDemands((current) => current.map((demand) => {
      if (demand.id !== id) return demand;
      if (status === "available") return { ...demand, status, assignee: undefined, assigneeEmail: undefined };
      return {
        ...demand,
        status,
        assignee: demand.assignee ?? currentUser.name,
        assigneeEmail: demand.assigneeEmail ?? currentUser.email,
      };
    }));
    flash("Status da demanda atualizado.");
  }

  function createDemand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const category = String(data.get("category"));
    const employee = String(data.get("employee") ?? "").trim();
    const title = `${category} – ${employee || String(data.get("company"))}`;
    setDemands((current) => [{
      id: Math.max(...current.map((d) => d.id)) + 1,
      title,
      category,
      company: String(data.get("company")),
      employee: employee || undefined,
      requester: String(data.get("requester")),
      source: String(data.get("source")),
      priority: String(data.get("priority")) as Priority,
      dueDate: String(data.get("dueDate")),
      status: "available",
    }, ...current]);
    setModalOpen(false);
    setView("demands");
    flash("Nova demanda adicionada à fila.");
  }

  const navItems: Array<{ id: View; label: string; icon: string }> = [
    { id: "overview", label: "Visão geral", icon: "home" },
    { id: "demands", label: "Demandas", icon: "inbox" },
    { id: "mine", label: "Minha fila", icon: "user" },
    { id: "reports", label: "Relatórios", icon: "chart" },
    { id: "settings", label: "Configurações", icon: "gear" },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>F</span><strong>Fila DP</strong></div>
        <nav aria-label="Navegação principal">
          {navItems.map((item) => (
            <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
              <Icon name={item.icon} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="profile">
          <span className="avatar large">{initials(currentUser.name)}</span>
          <div><strong>{currentUser.name}</strong><small>{currentUser.role === "admin" ? "Administrador" : "Analista de DP"}</small></div>
          <span className="chevron">⌄</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Gestão de demandas</p><h1>{view === "mine" ? "Minha fila" : view === "overview" ? "Visão geral" : view === "reports" ? "Relatórios" : view === "settings" ? "Configurações" : "Fila DP"}</h1></div>
          <div className="kpis" aria-label="Indicadores da fila">
            <div className="kpi green"><span className="kpi-icon"><Icon name="user" /></span><div><small>Disponíveis</small><strong>{counts.available}</strong></div></div>
            <div className="kpi blue"><span className="kpi-icon"><Icon name="clock" /></span><div><small>Em andamento</small><strong>{counts.active}</strong></div></div>
            <div className="kpi coral"><span className="kpi-icon"><Icon name="alert" /></span><div><small>Atrasadas</small><strong>{counts.overdue}</strong></div></div>
          </div>
          <button className="primary" onClick={() => setModalOpen(true)}><Icon name="plus" />Nova demanda</button>
        </header>

        {(view === "demands" || view === "mine") && (
          <>
            <div className="toolbar">
              <label className="search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar demandas..." /></label>
              <div className="filter-wrap">
                <button className="secondary" onClick={() => setFilterOpen((open) => !open)}><Icon name="filter" />Filtros <span>⌄</span></button>
                {filterOpen && <div className="filter-menu"><strong>Prioridade</strong>{["all", "urgent", "high", "medium", "low"].map((item) => <button key={item} onClick={() => { setPriority(item as Priority | "all"); setFilterOpen(false); }} className={priority === item ? "selected" : ""}>{({ all: "Todas", urgent: "Urgente", high: "Alta", medium: "Média", low: "Baixa" } as Record<string,string>)[item]}</button>)}</div>}
              </div>
              {priority !== "all" && <button className="filter-chip" onClick={() => setPriority("all")}>Prioridade: {priority} ×</button>}
              <span className="result-count">{filtered.length} demandas</span>
            </div>

            <div className="board">
              {STATUS.map((column) => {
                const items = filtered.filter((demand) => demand.status === column.id);
                return (
                  <section className="column" key={column.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedId) moveDemand(draggedId, column.id); setDraggedId(null); }}>
                    <header><div><span className="grip">⠿</span><strong>{column.label}</strong></div><span className={`count ${column.id}`}>{items.length}</span></header>
                    <div className="card-list">
                      {items.map((demand) => <DemandCard key={demand.id} demand={demand} currentUser={currentUser} onClaim={claimDemand} onDragStart={setDraggedId} />)}
                      {items.length === 0 && <div className="empty-column">Nenhuma demanda nesta etapa</div>}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        )}

        {view === "overview" && <Overview demands={demands} currentUser={currentUser} onOpenBoard={() => setView("demands")} />}
        {view === "reports" && <Reports demands={demands} />}
        {view === "settings" && <Settings currentUser={currentUser} />}
      </section>

      {modalOpen && <NewDemandModal onClose={() => setModalOpen(false)} onSubmit={createDemand} />}
      {notice && <div className="toast" role="status">✓ {notice}</div>}
    </main>
  );
}

function DemandCard({ demand, currentUser, onClaim, onDragStart }: { demand: Demand; currentUser: User; onClaim: (id: number) => void; onDragStart: (id: number) => void }) {
  const due = dueLabel(demand.dueDate, demand.status);
  return (
    <article className="demand-card" draggable onDragStart={() => onDragStart(demand.id)}>
      <div className="card-title"><span className="drag-handle">⠿</span><strong>{demand.title}</strong><button aria-label="Mais ações">⋮</button></div>
      <div className="card-tags"><span className={`tag ${CATEGORY_COLORS[demand.category] ?? "gray"}`}>{demand.category}</span><span className={`priority ${demand.priority}`}>{({ low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" } as Record<Priority,string>)[demand.priority]}</span></div>
      <p className="company"><Icon name="building" />{demand.company}</p>
      <div className="card-footer">
        {demand.assignee ? <div className="assignee"><span className="avatar">{initials(demand.assignee)}</span><span>{demand.assignee}</span></div> : <button className="claim" onClick={() => onClaim(demand.id)}>Assumir demanda</button>}
        <span className={`due ${due.className}`}>{due.text}</span>
      </div>
      {demand.assigneeEmail === currentUser.email && demand.status !== "done" && <span className="mine-marker">Sua demanda</span>}
    </article>
  );
}

function Overview({ demands, currentUser, onOpenBoard }: { demands: Demand[]; currentUser: User; onOpenBoard: () => void }) {
  const mine = demands.filter((d) => d.assigneeEmail === currentUser.email && d.status !== "done");
  const categories = Object.entries(demands.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.category]: (acc[d.category] ?? 0) + 1 }), {})).sort((a,b) => b[1]-a[1]).slice(0,5);
  const max = Math.max(...categories.map(([, value]) => value));
  return <div className="dashboard-grid">
    <section className="panel welcome"><div><span className="panel-kicker">Bom trabalho, {currentUser.name.split(" ")[0]}</span><h2>Você tem {mine.length} demandas em andamento</h2><p>Priorize os itens com prazo mais próximo e mantenha a fila atualizada.</p><button className="primary small" onClick={onOpenBoard}>Abrir quadro</button></div><div className="welcome-mark">DP</div></section>
    <section className="panel"><div className="panel-header"><div><span className="panel-kicker">Distribuição</span><h2>Demandas por categoria</h2></div><span className="muted">Total {demands.length}</span></div><div className="bars">{categories.map(([name,value]) => <div className="bar-row" key={name}><span>{name}</span><div><i style={{width:`${(value/max)*100}%`}} /></div><strong>{value}</strong></div>)}</div></section>
    <section className="panel"><div className="panel-header"><div><span className="panel-kicker">Próximos prazos</span><h2>Atenção hoje</h2></div></div><div className="deadline-list">{demands.filter((d) => d.status !== "done").slice(0,4).map((d) => <div key={d.id}><span className={`tag ${CATEGORY_COLORS[d.category]}`}>{d.category}</span><div><strong>{d.title}</strong><small>{d.company}</small></div><span className={`due ${dueLabel(d.dueDate,d.status).className}`}>{dueLabel(d.dueDate,d.status).text}</span></div>)}</div></section>
  </div>;
}

function Reports({ demands }: { demands: Demand[] }) {
  const done = demands.filter((d) => d.status === "done").length;
  const total = demands.length;
  const sources = ["E-mail", "WhatsApp", "Verbal"].map((source) => ({ source, value: demands.filter((d) => d.source === source).length }));
  return <div className="reports-grid">
    <section className="panel report-hero"><span className="panel-kicker">Resumo operacional</span><h2>{Math.round(done / total * 100)}% das demandas concluídas</h2><div className="progress"><i style={{width:`${done / total * 100}%`}} /></div><p>{done} concluídas de {total} cadastradas no período.</p></section>
    <section className="panel"><div className="panel-header"><div><span className="panel-kicker">Origem</span><h2>Canais de entrada</h2></div></div><div className="source-list">{sources.map((item) => <div key={item.source}><span>{item.source}</span><strong>{item.value}</strong></div>)}</div></section>
    <section className="panel wide"><div className="panel-header"><div><span className="panel-kicker">Equipe</span><h2>Carga por analista</h2></div></div><div className="analyst-table">{Array.from(new Set(demands.map((d) => d.assignee).filter(Boolean))).map((name) => <div key={name}><span className="avatar">{initials(name!)}</span><strong>{name}</strong><span>{demands.filter((d) => d.assignee === name && d.status !== "done").length} ativas</span><span>{demands.filter((d) => d.assignee === name && d.status === "done").length} concluídas</span></div>)}</div></section>
  </div>;
}

function Settings({ currentUser }: { currentUser: User }) {
  return <div className="settings-grid">
    <section className="panel"><span className="panel-kicker">Conta</span><h2>Seu perfil</h2><div className="profile-card"><span className="avatar xlarge">{initials(currentUser.name)}</span><div><strong>{currentUser.name}</strong><span>{currentUser.email}</span><small>{currentUser.role === "admin" ? "Administrador" : "Analista de DP"}</small></div></div></section>
    <section className="panel"><span className="panel-kicker">Tipos de demanda</span><h2>Categorias ativas</h2><div className="category-cloud">{Object.keys(CATEGORY_COLORS).map((category) => <span className={`tag ${CATEGORY_COLORS[category]}`} key={category}>{category}</span>)}</div><button className="secondary disabled" disabled>Gerenciar categorias</button></section>
    <section className="panel wide"><span className="panel-kicker">Regras da fila</span><h2>Distribuição e segurança</h2><div className="rule-list"><div><span>✓</span><div><strong>Primeiro analista a assumir</strong><small>A demanda fica bloqueada para os demais analistas.</small></div></div><div><span>✓</span><div><strong>Histórico de movimentações</strong><small>Todas as alterações são vinculadas ao usuário.</small></div></div><div><span>✓</span><div><strong>Redistribuição administrativa</strong><small>Administradores podem devolver demandas para a fila.</small></div></div></div></section>
  </div>;
}

function NewDemandModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header><div><span className="panel-kicker">Cadastro interno</span><h2 id="modal-title">Nova demanda</h2><p>Registre a solicitação recebida pela equipe de DP.</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></header>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <label><span>Tipo de demanda</span><select name="category" required defaultValue=""><option value="" disabled>Selecione</option>{Object.keys(CATEGORY_COLORS).map((category) => <option key={category}>{category}</option>)}</select></label>
          <label><span>Canal de origem</span><select name="source" required><option>E-mail</option><option>WhatsApp</option><option>Verbal</option></select></label>
          <label className="full"><span>Empresa</span><input name="company" required placeholder="Ex.: Empresa Alfa Ltda." /></label>
          <label><span>Funcionário relacionado</span><input name="employee" placeholder="Opcional para demandas gerais" /></label>
          <label><span>Solicitante</span><input name="requester" required placeholder="Nome ou setor" /></label>
          <label><span>Prioridade</span><select name="priority" required defaultValue="medium"><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
          <label><span>Prazo</span><input name="dueDate" type="date" required defaultValue="2026-07-18" /></label>
          <label className="full"><span>Descrição</span><textarea name="description" rows={3} placeholder="Inclua os detalhes necessários para o atendimento..." /></label>
        </div>
        <footer><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" type="submit">Adicionar à fila</button></footer>
      </form>
    </section>
  </div>;
}
