"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Card, InboxItem, WorkspaceSnapshot } from "@/lib/fila-dp-types";

type View = "board" | "inbox" | "planner" | "indicators";
type User = { displayName: string; email: string; fullName: string | null };
type CardForm = {
  title: string;
  description: string;
  company: string;
  processType: string;
  priority: string;
  assigneeName: string;
  dueAt: string;
  listId: string;
};

const emptyCardForm: CardForm = {
  title: "",
  description: "",
  company: "",
  processType: "ADMISSÃO",
  priority: "normal",
  assigneeName: "",
  dueAt: "",
  listId: "",
};

const processColors: Record<string, string> = {
  "ADMISSÃO": "blue",
  "FÉRIAS": "purple",
  "BENEFÍCIOS": "green",
  "RESCISÃO": "orange",
  "CADASTRO": "gray",
  "FOLHA": "red",
  "OUTROS": "gray",
};

const viewContent: Record<View, { eyebrow: string; title: string; description: string }> = {
  board: { eyebrow: "VISÃO OPERACIONAL", title: "Fila geral", description: "Acompanhe prioridades, responsáveis e próximos passos." },
  inbox: { eyebrow: "TRIAGEM MULTICANAL", title: "Caixa de entrada", description: "Transforme solicitações recebidas em demandas rastreáveis." },
  planner: { eyebrow: "AGENDA DO ANALISTA", title: "Meu planner", description: "Organize sua execução a partir dos prazos da operação." },
  indicators: { eyebrow: "GESTÃO DA OPERAÇÃO", title: "Indicadores e automações", description: "Monitore SLAs, volume e regras ativas do workspace." },
};

async function requestSnapshot(url: string, options?: RequestInit): Promise<WorkspaceSnapshot> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const payload = await response.json() as WorkspaceSnapshot & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Não foi possível concluir a operação.");
  return payload;
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "DP";
}

function formatDate(value: string | null, long = false) {
  if (!value) return "Sem prazo";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return new Intl.DateTimeFormat("pt-BR", long ? { day: "2-digit", month: "long", year: "numeric" } : { day: "2-digit", month: "short" }).format(date);
}

function formatReceived(value: string) {
  const date = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
  const diffMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 60) return `há ${diffMinutes || 1} min`;
  if (diffMinutes < 1440) return `há ${Math.floor(diffMinutes / 60)} h`;
  return `há ${Math.floor(diffMinutes / 1440)} d`;
}

function slaLabel(card: Card) {
  if (card.slaStatus === "overdue") return `Atrasada • ${formatDate(card.dueAt)}`;
  if (card.slaStatus === "warning") return "Vence hoje";
  if (card.slaStatus === "paused") return "SLA pausado";
  if (card.slaStatus === "completed") return "Concluída";
  return card.dueAt ? formatDate(card.dueAt) : "Sem prazo";
}

export function WorkspaceApp({ user, signOutPath }: { user: User; signOutPath: string }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<View>("board");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [cardModalOpen, setCardModalOpen] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [cardForm, setCardForm] = useState<CardForm>(emptyCardForm);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [inboxModalOpen, setInboxModalOpen] = useState(false);

  useEffect(() => {
    void requestSnapshot("/api/workspace")
      .then(setSnapshot)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Erro ao carregar o workspace."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!cardModalOpen && !inboxModalOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCardModalOpen(false);
        setInboxModalOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cardModalOpen, inboxModalOpen]);

  const allCards = useMemo(() => snapshot?.lists.flatMap((list) => list.cards) ?? [], [snapshot]);
  const selectedCard = useMemo(() => allCards.find((card) => card.id === selectedCardId) ?? null, [allCards, selectedCardId]);
  const workspaceInitials = initials(snapshot?.workspace.name ?? "Synex DP");
  const userInitials = initials(user.displayName);

  const stats = useMemo(() => {
    const active = allCards.filter((card) => card.slaStatus !== "completed");
    const waitingListIds = new Set(snapshot?.lists.filter((list) => list.slaBehavior === "paused").map((list) => list.id) ?? []);
    const completed = allCards.filter((card) => card.slaStatus === "completed").length;
    return {
      active: active.length,
      attention: active.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length,
      waiting: active.filter((card) => waitingListIds.has(card.listId)).length,
      onTime: allCards.length ? Math.round(((allCards.length - allCards.filter((card) => card.slaStatus === "overdue").length) / allCards.length) * 100) : 100,
      completed,
    };
  }, [allCards, snapshot]);

  function applySnapshot(next: WorkspaceSnapshot, message?: string) {
    setSnapshot(next);
    setError("");
    if (message) setToast(message);
  }

  async function mutate(url: string, options: RequestInit, message?: string) {
    setBusy(true);
    setError("");
    try {
      const next = await requestSnapshot(url, options);
      applySnapshot(next, message);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function openNewCard() {
    setSelectedCardId(null);
    setCardForm(emptyCardForm);
    setNewChecklistItem("");
    setCardModalOpen(true);
  }

  function openCard(card: Card) {
    setSelectedCardId(card.id);
    setCardForm({
      title: card.title,
      description: card.description,
      company: card.company,
      processType: card.processType,
      priority: card.priority,
      assigneeName: card.assigneeName,
      dueAt: card.dueAt ?? "",
      listId: card.listId,
    });
    setNewChecklistItem("");
    setCardModalOpen(true);
  }

  async function saveCard(event: FormEvent) {
    event.preventDefault();
    if (!cardForm.title.trim()) return;
    if (!selectedCardId) {
      const next = await mutate("/api/cards", { method: "POST", body: JSON.stringify(cardForm) }, "Demanda criada com checklist padrão.");
      if (next) setCardModalOpen(false);
      return;
    }

    const oldListId = selectedCard?.listId;
    const next = await mutate(`/api/cards/${selectedCardId}`, { method: "PATCH", body: JSON.stringify(cardForm) });
    if (!next) return;
    if (cardForm.listId && oldListId && cardForm.listId !== oldListId) {
      const moved = await mutate(`/api/cards/${selectedCardId}/move`, { method: "POST", body: JSON.stringify({ toListId: cardForm.listId }) }, "Demanda salva e movida.");
      if (moved) setCardModalOpen(false);
    } else {
      setToast("Demanda atualizada.");
      setCardModalOpen(false);
    }
  }

  async function moveCard(cardId: string, toListId: string) {
    const card = allCards.find((item) => item.id === cardId);
    if (!card || card.listId === toListId) return;
    await mutate(`/api/cards/${cardId}/move`, { method: "POST", body: JSON.stringify({ toListId }) }, "Demanda movida. Regras de SLA recalculadas.");
  }

  async function archiveCard() {
    if (!selectedCardId || !window.confirm("Arquivar esta demanda? Ela deixará de aparecer no quadro.")) return;
    const next = await mutate(`/api/cards/${selectedCardId}`, { method: "DELETE" }, "Demanda arquivada.");
    if (next) setCardModalOpen(false);
  }

  async function toggleChecklist(itemId: string, completed: boolean) {
    await mutate(`/api/checklist/${itemId}`, { method: "PATCH", body: JSON.stringify({ completed }) }, completed ? "Etapa concluída." : "Etapa reaberta.");
  }

  async function addChecklistItem(event: FormEvent) {
    event.preventDefault();
    if (!selectedCardId || !newChecklistItem.trim()) return;
    const next = await mutate(`/api/cards/${selectedCardId}/checklist`, { method: "POST", body: JSON.stringify({ title: newChecklistItem }) }, "Nova etapa adicionada.");
    if (next) setNewChecklistItem("");
  }

  async function addInboxItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = await mutate("/api/inbox", {
      method: "POST",
      body: JSON.stringify({
        senderName: data.get("senderName"),
        subject: data.get("subject"),
        channel: data.get("channel"),
        body: data.get("body"),
      }),
    }, "Solicitação adicionada à Inbox.");
    if (next) setInboxModalOpen(false);
  }

  async function convertInbox(item: InboxItem) {
    await mutate(`/api/inbox/${item.id}/convert`, { method: "POST" }, "Solicitação convertida em demanda.");
  }

  async function toggleRule(id: string, enabled: boolean) {
    await mutate(`/api/rules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }, enabled ? "Automação ativada." : "Automação pausada.");
  }

  if (loading) {
    return <main className="workspace-loading"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><p>Preparando sua fila…</p></main>;
  }

  if (!snapshot) {
    return <main className="workspace-loading error-state"><strong>Não foi possível abrir o Fila DP.</strong><p>{error}</p><button onClick={() => window.location.reload()}>Tentar novamente</button></main>;
  }

  const header = viewContent[view];
  const today = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "short", year: "numeric" }).format(new Date());

  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <button className="brand dashboard-brand" onClick={() => setView("board")} aria-label="Fila DP — quadro">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Fila <strong>DP</strong></span>
        </button>
        <nav aria-label="Navegação do painel">
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}><span aria-hidden="true">▦</span> Quadro</button>
          <button className={view === "inbox" ? "active" : ""} onClick={() => setView("inbox")}><span aria-hidden="true">▣</span> Caixa de entrada <b>{snapshot.inbox.filter((item) => item.status === "new").length}</b></button>
          <button className={view === "planner" ? "active" : ""} onClick={() => setView("planner")}><span aria-hidden="true">□</span> Meu planner</button>
          <button className={view === "indicators" ? "active" : ""} onClick={() => setView("indicators")}><span aria-hidden="true">⌁</span> Indicadores</button>
        </nav>
        <div className="sidebar-workspace">
          <span>WORKSPACE</span>
          <button type="button"><i>{workspaceInitials}</i><strong>{snapshot.workspace.name}</strong><span>⌄</span></button>
        </div>
        <div className="sidebar-account">
          <span className="user-avatar">{userInitials}</span>
          <span><strong>{user.displayName}</strong><small>{user.email}</small></span>
          <a href={signOutPath} aria-label="Sair do Fila DP">↗</a>
        </div>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div><span>{snapshot.workspace.name} /</span><strong> {header.title}</strong></div>
          <div className="dashboard-header-actions">
            <button aria-label="Pesquisar" onClick={() => setToast("A busca avançada será aberta pelos filtros do quadro.")}>⌕</button>
            <button aria-label="Notificações" onClick={() => setToast(`${stats.attention} demanda(s) exigem atenção.`)}>♢{stats.attention > 0 && <i />}</button>
            <button className="new-demand" onClick={view === "inbox" ? () => setInboxModalOpen(true) : openNewCard}>{view === "inbox" ? "＋ Nova solicitação" : "＋ Nova demanda"}</button>
          </div>
        </header>

        <div className="dashboard-content">
          <div className="dashboard-heading">
            <div><span className="dashboard-eyebrow">{header.eyebrow}</span><h1>{header.title}</h1><p>{header.description}</p></div>
            <div className="dashboard-date"><span>HOJE</span><strong>{today}</strong></div>
          </div>

          {view === "board" && (
            <>
              <div className="dashboard-stats">
                <article><span>Demandas ativas</span><strong>{stats.active}</strong><small>{stats.completed} concluída(s)</small></article>
                <article><span>Exigem atenção</span><strong>{stats.attention}</strong><small className="warning-text">SLA hoje ou atrasado</small></article>
                <article><span>Aguardando terceiros</span><strong>{stats.waiting}</strong><small>SLA pausado</small></article>
                <article><span>Dentro do prazo</span><strong>{stats.onTime}%</strong><small className="safe-text">Visão atual</small></article>
              </div>

              <div className="dashboard-board-head">
                <div className="dashboard-tabs"><button className="active">Quadro</button><button onClick={() => setView("planner")}>Planner</button><button onClick={() => setView("indicators")}>Indicadores</button></div>
                <div className="dashboard-filters"><button>Responsável: Todos ⌄</button><button>SLA: Todos ⌄</button><button>☷ Filtros</button></div>
              </div>

              <div className="dashboard-kanban">
                {snapshot.lists.map((list) => (
                  <section
                    className={`dashboard-column ${draggedCardId ? "drop-ready" : ""}`}
                    key={list.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedCardId) void moveCard(draggedCardId, list.id);
                      setDraggedCardId(null);
                    }}
                  >
                    <header><span><i className={list.kind} />{list.name}</span><b>{list.cards.length}</b><button aria-label={`Opções de ${list.name}`}>•••</button></header>
                    <div className="dashboard-card-list">
                      {list.cards.map((card) => {
                        const completed = card.checklist.filter((item) => item.completed).length;
                        return (
                          <article
                            className={`dashboard-task priority-${card.priority}`}
                            key={card.id}
                            draggable
                            tabIndex={0}
                            onDragStart={() => setDraggedCardId(card.id)}
                            onDragEnd={() => setDraggedCardId(null)}
                            onClick={() => openCard(card)}
                            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openCard(card); }}
                          >
                            <div className="dashboard-task-labels"><span className={processColors[card.processType] ?? "gray"}>{card.processType}</span>{card.priority === "urgent" && <span className="urgent">URGENTE</span>}</div>
                            <h2>{card.title}</h2>
                            <p>{card.company || "Sem empresa informada"}</p>
                            <div className="dashboard-task-bottom"><span className={`dashboard-sla ${card.slaStatus}`}>◷ {slaLabel(card)}</span><span className="dashboard-check">✓ {completed}/{card.checklist.length}</span><span className="dashboard-mini-avatar">{initials(card.assigneeName || "DP")}</span></div>
                          </article>
                        );
                      })}
                      <button className="dashboard-add-card" onClick={() => { setCardForm({ ...emptyCardForm, listId: list.id }); setSelectedCardId(null); setCardModalOpen(true); }}>＋ Adicionar demanda</button>
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}

          {view === "inbox" && <InboxView items={snapshot.inbox} busy={busy} onConvert={convertInbox} onNew={() => setInboxModalOpen(true)} />}
          {view === "planner" && <PlannerView cards={allCards} onOpen={openCard} />}
          {view === "indicators" && <IndicatorsView cards={allCards} rules={snapshot.rules} busy={busy} onToggleRule={toggleRule} />}
        </div>
      </section>

      {error && <div className="workspace-toast error" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
      {toast && <div className="workspace-toast" role="status"><span>✓</span>{toast}</div>}
      {busy && <div className="workspace-busy" aria-label="Salvando"><i /></div>}

      {cardModalOpen && (
        <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCardModalOpen(false); }}>
          <section className="workspace-modal card-modal" role="dialog" aria-modal="true" aria-labelledby="card-modal-title">
            <header><div><span>{selectedCard ? `Demanda • ${selectedCard.processType}` : "Nova demanda"}</span><h2 id="card-modal-title">{selectedCard ? selectedCard.title : "Adicionar à fila"}</h2></div><button onClick={() => setCardModalOpen(false)} aria-label="Fechar">×</button></header>
            <div className="card-modal-body">
              <form className="card-form" onSubmit={saveCard}>
                <label className="full">Título da demanda<input autoFocus value={cardForm.title} onChange={(event) => setCardForm({ ...cardForm, title: event.target.value })} placeholder="Ex.: Admissão — Maria Oliveira" required /></label>
                <label className="full">Descrição<textarea value={cardForm.description} onChange={(event) => setCardForm({ ...cardForm, description: event.target.value })} placeholder="Contexto e orientações para execução" rows={4} /></label>
                <label>Tipo de processo<select value={cardForm.processType} onChange={(event) => setCardForm({ ...cardForm, processType: event.target.value })}><option>ADMISSÃO</option><option>RESCISÃO</option><option>FÉRIAS</option><option>BENEFÍCIOS</option><option>FOLHA</option><option>CADASTRO</option><option>OUTROS</option></select></label>
                <label>Empresa / referência<input value={cardForm.company} onChange={(event) => setCardForm({ ...cardForm, company: event.target.value })} placeholder="Empresa, matrícula ou unidade" /></label>
                <label>Responsável<input value={cardForm.assigneeName} onChange={(event) => setCardForm({ ...cardForm, assigneeName: event.target.value })} placeholder="Nome do analista" /></label>
                <label>Prazo<input type="date" value={cardForm.dueAt} onChange={(event) => setCardForm({ ...cardForm, dueAt: event.target.value })} /></label>
                <label>Prioridade<select value={cardForm.priority} onChange={(event) => setCardForm({ ...cardForm, priority: event.target.value })}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
                <label>Coluna<select value={cardForm.listId} onChange={(event) => setCardForm({ ...cardForm, listId: event.target.value })}><option value="">Automática pelas regras</option>{snapshot.lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label>
                <div className="card-form-actions full">{selectedCard && <button type="button" className="danger-link" onClick={archiveCard}>Arquivar demanda</button>}<span /><button type="button" className="secondary-button" onClick={() => setCardModalOpen(false)}>Cancelar</button><button className="primary-button" disabled={busy}>{selectedCard ? "Salvar alterações" : "Criar demanda"}</button></div>
              </form>

              {selectedCard && (
                <aside className="checklist-panel">
                  <div><span>CHECKLIST</span><strong>{selectedCard.checklist.filter((item) => item.completed).length}/{selectedCard.checklist.length}</strong></div>
                  <div className="checklist-progress"><i style={{ width: `${selectedCard.checklist.length ? (selectedCard.checklist.filter((item) => item.completed).length / selectedCard.checklist.length) * 100 : 0}%` }} /></div>
                  <ul>{selectedCard.checklist.map((item) => <li key={item.id}><label><input type="checkbox" checked={item.completed} onChange={(event) => void toggleChecklist(item.id, event.target.checked)} /><span>{item.title}</span></label></li>)}</ul>
                  <form onSubmit={addChecklistItem}><input value={newChecklistItem} onChange={(event) => setNewChecklistItem(event.target.value)} placeholder="Nova etapa obrigatória" /><button disabled={!newChecklistItem.trim()}>＋</button></form>
                  <p>Ao concluir todas as etapas, a demanda será movida automaticamente para Concluído.</p>
                </aside>
              )}
            </div>
          </section>
        </div>
      )}

      {inboxModalOpen && (
        <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setInboxModalOpen(false); }}>
          <section className="workspace-modal inbox-modal" role="dialog" aria-modal="true" aria-labelledby="inbox-modal-title">
            <header><div><span>CAPTURA MANUAL</span><h2 id="inbox-modal-title">Nova solicitação</h2></div><button onClick={() => setInboxModalOpen(false)} aria-label="Fechar">×</button></header>
            <form className="card-form" onSubmit={addInboxItem}>
              <label>Solicitante<input name="senderName" placeholder="Nome ou área" required /></label>
              <label>Canal<select name="channel"><option value="manual">Manual</option><option value="email">E-mail</option><option value="whatsapp">WhatsApp</option><option value="teams">Teams</option></select></label>
              <label className="full">Assunto<input name="subject" placeholder="Resumo da solicitação" required /></label>
              <label className="full">Mensagem<textarea name="body" rows={5} placeholder="Contexto recebido do solicitante" /></label>
              <div className="card-form-actions full"><span /><button type="button" className="secondary-button" onClick={() => setInboxModalOpen(false)}>Cancelar</button><button className="primary-button" disabled={busy}>Adicionar à Inbox</button></div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function InboxView({ items, busy, onConvert, onNew }: { items: InboxItem[]; busy: boolean; onConvert: (item: InboxItem) => Promise<void>; onNew: () => void }) {
  const pending = items.filter((item) => item.status === "new");
  const converted = items.filter((item) => item.status === "converted");
  return (
    <div className="inbox-layout">
      <section className="inbox-list-panel">
        <header><div><strong>Aguardando triagem</strong><span>{pending.length} nova(s)</span></div><button onClick={onNew}>＋ Registrar solicitação</button></header>
        <div className="inbox-items">
          {pending.length === 0 && <div className="empty-view"><span>✓</span><strong>Inbox organizada</strong><p>Não há solicitações aguardando triagem.</p></div>}
          {pending.map((item) => <article className="inbox-item" key={item.id}><span className={`channel-icon ${item.channel}`}>{item.channel === "whatsapp" ? "W" : item.channel === "email" ? "@" : item.channel === "teams" ? "T" : "+"}</span><div><div><strong>{item.subject}</strong><time>{formatReceived(item.receivedAt)}</time></div><span>{item.senderName} • {item.channel}</span><p>{item.body}</p><button disabled={busy} onClick={() => void onConvert(item)}>Transformar em demanda →</button></div></article>)}
        </div>
      </section>
      <aside className="inbox-summary">
        <span>FLUXO DA INBOX</span><h2>Da mensagem à fila certa.</h2><ol><li><b>1</b><div><strong>Capture</strong><p>Registre solicitações de qualquer canal.</p></div></li><li><b>2</b><div><strong>Faça a triagem</strong><p>Revise contexto e prioridade.</p></div></li><li><b>3</b><div><strong>Converta</strong><p>Crie o cartão com histórico de origem.</p></div></li></ol><div className="inbox-converted"><strong>{converted.length}</strong><span>convertida(s) nesta fila</span></div>
      </aside>
    </div>
  );
}

function PlannerView({ cards, onOpen }: { cards: Card[]; onOpen: (card: Card) => void }) {
  const scheduled = cards.filter((card) => card.dueAt && card.slaStatus !== "completed").sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const grouped = scheduled.reduce<Record<string, Card[]>>((accumulator, card) => { const key = card.dueAt!; (accumulator[key] ??= []).push(card); return accumulator; }, {});
  return (
    <div className="planner-layout">
      <section className="planner-calendar"><header><strong>Agenda por prazo</strong><span>{scheduled.length} atividade(s) programada(s)</span></header>{Object.keys(grouped).length === 0 && <div className="empty-view"><span>□</span><strong>Nenhum prazo agendado</strong><p>Defina uma data nas demandas para montar o planner.</p></div>}{Object.entries(grouped).map(([date, dateCards]) => <div className="planner-day" key={date}><div><strong>{formatDate(date, true)}</strong><span>{dateCards.length} demanda(s)</span></div><div>{dateCards.map((card) => <button key={card.id} onClick={() => onOpen(card)}><i className={processColors[card.processType] ?? "gray"} /><span><strong>{card.title}</strong><small>{card.assigneeName || "Sem responsável"} • {card.company || card.processType}</small></span><em className={card.slaStatus}>{slaLabel(card)}</em></button>)}</div></div>)}</section>
      <aside className="planner-focus"><span>FOCO DO DIA</span><h2>{scheduled.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length}</h2><p>demanda(s) precisam de atenção imediata.</p><div><i /><span><strong>Priorize atrasos</strong><small>Comece pelos SLAs vencidos antes de assumir novas atividades.</small></span></div></aside>
    </div>
  );
}

function IndicatorsView({ cards, rules, busy, onToggleRule }: { cards: Card[]; rules: WorkspaceSnapshot["rules"]; busy: boolean; onToggleRule: (id: string, enabled: boolean) => Promise<void> }) {
  const processes = Object.entries(cards.reduce<Record<string, number>>((accumulator, card) => { accumulator[card.processType] = (accumulator[card.processType] ?? 0) + 1; return accumulator; }, {})).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...processes.map(([, count]) => count));
  const statusCounts = { safe: 0, warning: 0, overdue: 0, paused: 0, completed: 0 };
  cards.forEach((card) => { statusCounts[card.slaStatus] += 1; });
  return (
    <div className="indicators-layout">
      <section className="metrics-panel"><header><strong>Volume por processo</strong><span>{cards.length} demanda(s)</span></header><div className="process-bars">{processes.map(([process, count]) => <div key={process}><span>{process}</span><i><b style={{ width: `${(count / max) * 100}%` }} /></i><strong>{count}</strong></div>)}</div></section>
      <section className="sla-panel"><header><strong>Saúde dos SLAs</strong><span>Visão atual</span></header><div className="sla-donut" style={{ background: `conic-gradient(#23d8a1 0 ${(statusCounts.safe / Math.max(1, cards.length)) * 100}%, #f2a13e 0 ${((statusCounts.safe + statusCounts.warning) / Math.max(1, cards.length)) * 100}%, #ef5b5b 0 ${((statusCounts.safe + statusCounts.warning + statusCounts.overdue) / Math.max(1, cards.length)) * 100}%, #8b98a7 0 100%)` }}><span><strong>{cards.length - statusCounts.overdue}</strong><small>sob controle</small></span></div><ul><li><i className="safe" />No prazo <b>{statusCounts.safe}</b></li><li><i className="warning" />Atenção <b>{statusCounts.warning}</b></li><li><i className="overdue" />Atrasadas <b>{statusCounts.overdue}</b></li><li><i className="paused" />Pausadas/concluídas <b>{statusCounts.paused + statusCounts.completed}</b></li></ul></section>
      <section className="rules-panel"><header><div><strong>Automações nativas</strong><span>Gatilho → condição → ação</span></div><b>{rules.filter((rule) => rule.enabled).length} ativas</b></header><div>{rules.map((rule, index) => <article key={rule.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{rule.name}</strong><small>{rule.trigger.replaceAll(".", " ")}</small></div><label className="rule-switch"><input type="checkbox" checked={rule.enabled} disabled={busy} onChange={(event) => void onToggleRule(rule.id, event.target.checked)} /><i /></label></article>)}</div></section>
    </div>
  );
}
