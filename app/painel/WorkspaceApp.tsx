"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEvent, Card, InboxItem, WorkspaceRole, WorkspaceSnapshot } from "@/lib/fila-dp-types";

type View = "board" | "inbox" | "planner" | "indicators" | "companies";
type BoardMode = "kanban" | "table" | "calendar" | "process";
type Theme = "light" | "dark";
type CardTab = "details" | "checklist" | "attachments" | "activity";
type SettingsSection = "general" | "team" | "fields" | "templates" | "sla" | "integrations" | "automations";
type User = { displayName: string; email: string; fullName: string | null };
type SearchResult = { id: string; title: string; company: string; processType: string; priority: string; slaStatus: string; dueAt: string | null; assigneeName: string; archived: boolean; listId: string };
type CatalogHandler = (payload: Record<string, unknown>, message: string) => Promise<WorkspaceSnapshot | null>;
type CardForm = {
  title: string;
  description: string;
  companyId: string;
  company: string;
  processType: string;
  priority: string;
  assigneeName: string;
  dueAt: string;
  listId: string;
  templateId: string;
  assigneeIds: string[];
  labelIds: string[];
  customValues: Record<string, string>;
};

const emptyCardForm: CardForm = {
  title: "",
  description: "",
  companyId: "",
  company: "",
  processType: "ADMISSÃO",
  priority: "normal",
  assigneeName: "",
  dueAt: "",
  listId: "",
  templateId: "",
  assigneeIds: [],
  labelIds: [],
  customValues: {},
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
  companies: { eyebrow: "CADASTRO OPERACIONAL", title: "Empresas e folha", description: "Mantenha empresas, competências, headcount e custo de folha organizados." },
};

const roleLabels: Record<WorkspaceRole, string> = {
  admin: "Administrador",
  member: "Membro",
  observer: "Observador",
  guest: "Convidado",
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

function compactSlaLabel(status: string, dueAt: string | null) {
  if (status === "overdue") return "Atrasada";
  if (status === "warning") return "Vence hoje";
  if (status === "paused") return "Pausada";
  if (status === "completed") return "Concluída";
  return dueAt ? formatDate(dueAt) : "Sem prazo";
}

function formatMoment(value: string) {
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(normalized));
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function activityLabel(activity: ActivityEvent) {
  const labels: Record<string, string> = {
    "card.created": "criou a demanda",
    "card.updated": "atualizou os dados",
    "card.moved": "moveu a demanda de coluna",
    "card.archived": "arquivou a demanda",
    "card.commented": "adicionou um comentário",
    "checklist.item_added": "adicionou uma etapa ao checklist",
    "checklist.item_toggled": activity.payload.completed ? "concluiu uma etapa" : "reabriu uma etapa",
    "inbox.item_converted": "converteu a solicitação da Inbox",
    "attachment.uploaded": "enviou um anexo",
    "attachment.deleted": "removeu um anexo",
    "card.restored": "restaurou a demanda",
    "automation.executed": "executou uma automação",
  };
  return labels[activity.eventType] ?? "atualizou a demanda";
}

export function WorkspaceApp({ user, signOutPath }: { user: User; signOutPath: string }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<View>("board");
  const [boardMode, setBoardMode] = useState<BoardMode>("kanban");
  const [cardTab, setCardTab] = useState<CardTab>("details");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [cardModalOpen, setCardModalOpen] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [cardForm, setCardForm] = useState<CardForm>(emptyCardForm);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [newComment, setNewComment] = useState("");
  const [inboxModalOpen, setInboxModalOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [slaFilter, setSlaFilter] = useState("all");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberRole, setMemberRole] = useState<WorkspaceRole>("member");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardDescription, setNewBoardDescription] = useState("");
  const [theme, setTheme] = useState<Theme>("light");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarPreferenceLoaded = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const storedTheme = window.localStorage.getItem("fila-dp-theme");
      if (storedTheme === "dark" || storedTheme === "light") {
        setTheme(storedTheme);
        return;
      }
      if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) setTheme("dark");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("fila-dp-theme", theme);
  }, [theme]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = window.localStorage.getItem("fila-dp-sidebar-collapsed");
      if (stored === "true" || stored === "false") setSidebarCollapsed(stored === "true");
      else if (window.matchMedia?.("(max-width: 760px)").matches) setSidebarCollapsed(true);
      sidebarPreferenceLoaded.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!sidebarPreferenceLoaded.current) return;
    window.localStorage.setItem("fila-dp-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    void requestSnapshot("/api/workspace")
      .then(setSnapshot)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Erro ao carregar o workspace."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const seconds = snapshot?.settings.realtimeSeconds ?? 30;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible" || busy) return;
      void requestSnapshot("/api/workspace").then(setSnapshot).catch(() => undefined);
    }, Math.max(5, seconds) * 1000);
    return () => window.clearInterval(interval);
  }, [snapshot?.settings.realtimeSeconds, busy]);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      void fetch(`/api/search?${params}`).then((response) => response.json()).then((payload: { results?: SearchResult[] }) => setSearchResults(payload.results ?? [])).catch(() => setSearchResults([]));
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!cardModalOpen && !inboxModalOpen && !workspaceModalOpen && !searchOpen && !notificationsOpen && !archiveOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCardModalOpen(false);
        setInboxModalOpen(false);
        setWorkspaceModalOpen(false);
        setSearchOpen(false);
        setNotificationsOpen(false);
        setArchiveOpen(false);
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [cardModalOpen, inboxModalOpen, workspaceModalOpen, searchOpen, notificationsOpen, archiveOpen]);

  const activeCards = useMemo(() => snapshot?.lists.flatMap((list) => list.cards) ?? [], [snapshot]);
  const allCards = useMemo(() => [...activeCards, ...(snapshot?.archivedCards ?? [])], [activeCards, snapshot?.archivedCards]);
  const filteredActiveCards = useMemo(() => activeCards.filter((card) =>
    (assigneeFilter === "all" || card.assigneeName === assigneeFilter || card.assignees.some((assignee) => assignee.name === assigneeFilter)) &&
    (slaFilter === "all" || card.slaStatus === slaFilter)
  ), [activeCards, assigneeFilter, slaFilter]);
  const selectedCard = useMemo(() => allCards.find((card) => card.id === selectedCardId) ?? null, [allCards, selectedCardId]);
  const assignees = useMemo(() => Array.from(new Set(activeCards.flatMap((card) => card.assignees.length ? card.assignees.map((assignee) => assignee.name) : [card.assigneeName]).filter(Boolean))).sort(), [activeCards]);
  const workspaceInitials = initials(snapshot?.workspace.name ?? "Synex DP");
  const userInitials = initials(user.displayName);
  const canEdit = snapshot ? ["admin", "member"].includes(snapshot.workspace.role) : false;
  const canComment = snapshot ? ["admin", "member", "guest"].includes(snapshot.workspace.role) : false;
  const isAdmin = snapshot?.workspace.role === "admin";

  const stats = useMemo(() => {
    const active = activeCards.filter((card) => card.slaStatus !== "completed");
    const waitingListIds = new Set(snapshot?.lists.filter((list) => list.slaBehavior === "paused").map((list) => list.id) ?? []);
    const completed = activeCards.filter((card) => card.slaStatus === "completed").length;
    return {
      active: active.length,
      attention: active.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length,
      waiting: active.filter((card) => waitingListIds.has(card.listId)).length,
      onTime: activeCards.length ? Math.round(((activeCards.length - activeCards.filter((card) => card.slaStatus === "overdue").length) / activeCards.length) * 100) : 100,
      completed,
    };
  }, [activeCards, snapshot]);

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
    if (!canEdit) return;
    setSelectedCardId(null);
    setCardForm(emptyCardForm);
    setNewChecklistItem("");
    setCardTab("details");
    setCardModalOpen(true);
  }

  function openFromTemplate(templateId: string) {
    const template = snapshot?.templates.find((item) => item.id === templateId);
    if (!template) return openNewCard();
    setSelectedCardId(null);
    setCardForm({ ...emptyCardForm, templateId, processType: template.processType, description: template.description });
    setCardTab("details");
    setCardModalOpen(true);
  }

  function openCard(card: Card) {
    setSelectedCardId(card.id);
    setCardForm({
      title: card.title,
      description: card.description,
      companyId: card.companyId ?? "",
      company: card.company,
      processType: card.processType,
      priority: card.priority,
      assigneeName: card.assigneeName,
      dueAt: card.dueAt ?? "",
      listId: card.listId,
      templateId: "",
      assigneeIds: card.assignees.map((assignee) => assignee.userId),
      labelIds: card.labels.map((label) => label.id),
      customValues: card.customValues,
    });
    setNewChecklistItem("");
    setNewComment("");
    setCardTab("details");
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

  async function addComment(event: FormEvent) {
    event.preventDefault();
    if (!selectedCardId || !newComment.trim()) return;
    const next = await mutate(`/api/cards/${selectedCardId}/comments`, { method: "POST", body: JSON.stringify({ body: newComment }) }, "Comentário publicado.");
    if (next) setNewComment("");
  }

  async function editComment(commentId: string, currentBody: string) {
    const nextBody = window.prompt("Edite o comentário:", currentBody)?.trim();
    if (!selectedCardId || !nextBody || nextBody === currentBody) return;
    await mutate(`/api/cards/${selectedCardId}/comments`, { method: "PATCH", body: JSON.stringify({ id: commentId, body: nextBody }) }, "Comentário atualizado.");
  }

  async function deleteComment(commentId: string) {
    if (!selectedCardId || !window.confirm("Excluir este comentário?")) return;
    await mutate(`/api/cards/${selectedCardId}/comments?commentId=${encodeURIComponent(commentId)}`, { method: "DELETE" }, "Comentário excluído.");
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

  function openWorkspaceSettings() {
    setWorkspaceName(snapshot?.workspace.name ?? "");
    setWorkspaceModalOpen(true);
  }

  async function saveWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!workspaceName.trim()) return;
    const next = await mutate("/api/workspace", { method: "PATCH", body: JSON.stringify({ name: workspaceName }) }, "Workspace atualizado.");
    if (next) setWorkspaceModalOpen(false);
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    if (!memberEmail.trim()) return;
    const next = await mutate("/api/members", { method: "POST", body: JSON.stringify({ email: memberEmail, name: memberName, role: memberRole }) }, "Acesso da equipe atualizado.");
    if (next) {
      setMemberEmail("");
      setMemberName("");
      setMemberRole("member");
    }
  }

  async function updateMemberRole(userId: string, role: WorkspaceRole) {
    await mutate(`/api/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }, "Papel de acesso atualizado.");
  }

  async function removeMember(userId: string, name: string) {
    if (!window.confirm(`Remover o acesso de ${name}?`)) return;
    await mutate(`/api/members/${userId}`, { method: "DELETE" }, "Membro removido do workspace.");
  }

  async function switchWorkspace(workspaceId: string) {
    if (workspaceId === snapshot?.workspace.id) return;
    const next = await mutate("/api/workspaces/select", { method: "POST", body: JSON.stringify({ workspaceId }) }, "Workspace alterado.");
    if (next) {
      setWorkspaceName(next.workspace.name);
      setWorkspaceModalOpen(false);
      setView("board");
    }
  }

  async function switchBoard(boardId: string) {
    if (boardId === snapshot?.board.id) return;
    await mutate("/api/boards/select", { method: "POST", body: JSON.stringify({ boardId }) }, "Quadro alterado.");
  }

  async function createBoard(event: FormEvent) {
    event.preventDefault();
    if (!newBoardName.trim()) return;
    const next = await mutate("/api/boards", { method: "POST", body: JSON.stringify({ name: newBoardName, description: newBoardDescription }) }, "Quadro criado.");
    if (next) { setNewBoardName(""); setNewBoardDescription(""); }
  }

  async function uploadAttachment(file: File) {
    if (!selectedCardId) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch(`/api/cards/${selectedCardId}/attachments`, { method: "POST", body: form });
      const payload = await response.json() as WorkspaceSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível enviar o arquivo.");
      applySnapshot(payload, "Anexo enviado com segurança.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível enviar o arquivo.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAttachment(id: string) {
    if (!window.confirm("Excluir este anexo?")) return;
    await mutate(`/api/attachments/${id}`, { method: "DELETE" }, "Anexo removido.");
  }

  async function restoreCard(id: string) {
    await mutate(`/api/cards/${id}/restore`, { method: "POST" }, "Demanda restaurada para o quadro.");
  }

  async function deleteCardPermanently(id: string, title: string) {
    if (!window.confirm(`Excluir permanentemente “${title}”? Esta ação não pode ser desfeita.`)) return;
    await mutate(`/api/cards/${id}/permanent`, { method: "DELETE" }, "Demanda excluída permanentemente.");
  }

  async function toggleSlaPause() {
    if (!selectedCardId) return;
    if (selectedCard?.slaStatus === "paused") await mutate(`/api/cards/${selectedCardId}/sla/pause`, { method: "DELETE" }, "SLA retomado.");
    else {
      const reason = window.prompt("Motivo da pausa justificada:", "Aguardando documentos do solicitante")?.trim();
      if (reason) await mutate(`/api/cards/${selectedCardId}/sla/pause`, { method: "POST", body: JSON.stringify({ reason }) }, "SLA pausado com justificativa.");
    }
  }

  async function markNotification(id: string) {
    await mutate(`/api/notifications/${id}/read`, { method: "POST" });
  }

  async function markAllNotifications() {
    await mutate("/api/notifications/read-all", { method: "POST" }, "Notificações marcadas como lidas.");
  }

  async function updateCatalog(payload: Record<string, unknown>, message: string) {
    return mutate("/api/catalog", { method: "POST", body: JSON.stringify(payload) }, message);
  }

  async function createCompany(payload: Record<string, unknown>) {
    return mutate("/api/companies", { method: "POST", body: JSON.stringify(payload) }, "Empresa cadastrada.");
  }

  async function deleteCompany(id: string, name: string) {
    if (!window.confirm(`Excluir o cadastro de ${name}?`)) return null;
    return mutate(`/api/companies/${id}`, { method: "DELETE" }, "Empresa excluída.");
  }

  async function saveHrMetric(payload: Record<string, unknown>) {
    return mutate("/api/hr-metrics", { method: "POST", body: JSON.stringify(payload) }, "Indicadores da folha atualizados.");
  }

  async function syncIntegration(channel: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/integrations/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }) });
      const payload = await response.json() as { synced?: number; metricsSynced?: number; snapshot?: WorkspaceSnapshot; error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível sincronizar.");
      if (payload.snapshot) applySnapshot(payload.snapshot, `${payload.synced ?? 0} item(ns) e ${payload.metricsSynced ?? 0} métrica(s) sincronizado(s).`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível sincronizar."); }
    finally { void requestSnapshot("/api/workspace").then(setSnapshot).catch(() => undefined); setBusy(false); }
  }

  function openSearchResult(result: SearchResult) {
    const card = allCards.find((item) => item.id === result.id);
    if (card) {
      setSearchOpen(false);
      if (card.archived) setArchiveOpen(true);
      else openCard(card);
    }
  }

  function exportCsv() {
    const rows = [["Demanda", "Processo", "Empresa", "Responsáveis", "Prazo", "SLA", "Status"], ...activeCards.map((card) => [card.title, card.processType, card.company, card.assignees.map((item) => item.name).join("; ") || card.assigneeName, card.dueAt ?? "", card.slaStatus, snapshot?.lists.find((list) => list.id === card.listId)?.name ?? ""])];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    link.download = `fila-dp-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
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
    <main className={`dashboard-shell theme-${theme}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="dashboard-sidebar">
        <button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((current) => !current)} aria-label={sidebarCollapsed ? "Abrir menu lateral" : "Recolher menu lateral"} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? "Abrir menu" : "Recolher menu"}>
          <span aria-hidden="true">{sidebarCollapsed ? "→" : "←"}</span>
        </button>
        <button className="brand dashboard-brand" onClick={() => setView("board")} aria-label="Fila DP — quadro">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Fila <strong>DP</strong></span>
        </button>
        <nav aria-label="Navegação do painel">
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}><span aria-hidden="true">▦</span> Quadro</button>
          <button className={view === "inbox" ? "active" : ""} onClick={() => setView("inbox")}><span aria-hidden="true">▣</span> Caixa de entrada <b>{snapshot.inbox.filter((item) => item.status === "new").length}</b></button>
          <button className={view === "planner" ? "active" : ""} onClick={() => setView("planner")}><span aria-hidden="true">□</span> Meu planner</button>
          <button className={view === "indicators" ? "active" : ""} onClick={() => setView("indicators")}><span aria-hidden="true">⌁</span> Indicadores</button>
          <button className={view === "companies" ? "active" : ""} onClick={() => setView("companies")}><span aria-hidden="true">▤</span> Empresas</button>
        </nav>
        <div className="sidebar-workspace">
          <span>WORKSPACE</span>
          <button type="button" onClick={openWorkspaceSettings}><i>{workspaceInitials}</i><strong>{snapshot.workspace.name}</strong><span>⌄</span></button>
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
            <button className="workspace-settings-button" aria-label="Configurar workspace" onClick={openWorkspaceSettings}>⚙</button>
            <button aria-label="Pesquisar" onClick={() => setSearchOpen(true)}>⌕</button>
            <button aria-label="Notificações" onClick={() => setNotificationsOpen(true)}>♢{snapshot.notifications.some((item) => !item.readAt) && <i />}</button>
            <button className="theme-toggle" aria-label={theme === "dark" ? "Ativar modo claro" : "Ativar modo noturno"} aria-pressed={theme === "dark"} title={theme === "dark" ? "Modo claro" : "Modo noturno"} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</button>
            {canEdit && <button className="new-demand" onClick={view === "inbox" ? () => setInboxModalOpen(true) : openNewCard}>{view === "inbox" ? "＋ Nova solicitação" : "＋ Nova demanda"}</button>}
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
                <div className="dashboard-tabs board-mode-tabs"><label className="board-selector"><span>Quadro</span><select value={snapshot.board.id} onChange={(event) => void switchBoard(event.target.value)} aria-label="Selecionar quadro">{snapshot.boards.map((board) => <option value={board.id} key={board.id}>{board.name}</option>)}</select></label><button className={boardMode === "kanban" ? "active" : ""} onClick={() => setBoardMode("kanban")}>Kanban</button><button className={boardMode === "table" ? "active" : ""} onClick={() => setBoardMode("table")}>Tabela</button><button className={boardMode === "calendar" ? "active" : ""} onClick={() => setBoardMode("calendar")}>Calendário</button><button className="archive-trigger" onClick={() => setArchiveOpen(true)}>Arquivados <b>{snapshot.archivedCards.length}</b></button></div>
                <div className="dashboard-filters">
                  <label><span>Responsável</span><select aria-label="Filtrar por responsável" value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}><option value="all">Todos</option>{assignees.map((assignee) => <option key={assignee}>{assignee}</option>)}</select></label>
                  <label><span>SLA</span><select aria-label="Filtrar por SLA" value={slaFilter} onChange={(event) => setSlaFilter(event.target.value)}><option value="all">Todos</option><option value="safe">No prazo</option><option value="warning">Vence hoje</option><option value="overdue">Atrasado</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label>
                </div>
              </div>

              <div className="process-view-trigger"><button className={boardMode === "process" ? "active" : ""} onClick={() => setBoardMode("process")}>Tabelas por processo</button></div>
              {boardMode === "kanban" && <div className="dashboard-kanban">
                {snapshot.lists.map((list) => {
                  const visibleCards = list.cards.filter((card) => (assigneeFilter === "all" || card.assigneeName === assigneeFilter || card.assignees.some((assignee) => assignee.name === assigneeFilter)) && (slaFilter === "all" || card.slaStatus === slaFilter));
                  return (
                  <section
                    className={`dashboard-column ${draggedCardId ? "drop-ready" : ""}`}
                    key={list.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (canEdit && draggedCardId) void moveCard(draggedCardId, list.id);
                      setDraggedCardId(null);
                    }}
                  >
                    <header><span><i className={list.kind} />{list.name}</span><b>{visibleCards.length}</b><button aria-label={`Opções de ${list.name}`} onClick={() => setToast(`${list.name}: ${visibleCards.length} demanda(s) visível(is).`)}>•••</button></header>
                    <div className="dashboard-card-list">
                      {visibleCards.map((card) => {
                        const completed = card.checklist.filter((item) => item.completed).length;
                        return (
                          <article
                            className={`dashboard-task priority-${card.priority}`}
                            key={card.id}
                            draggable={canEdit}
                            tabIndex={0}
                            onDragStart={() => setDraggedCardId(card.id)}
                            onDragEnd={() => setDraggedCardId(null)}
                            onClick={() => openCard(card)}
                            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openCard(card); }}
                          >
                            <div className="dashboard-task-labels"><span className={processColors[card.processType] ?? "gray"}>{card.processType}</span>{card.priority === "urgent" && <span className="urgent">URGENTE</span>}{card.labels.slice(0, 1).map((label) => <span className="custom-label" style={{ color: label.color, backgroundColor: `${label.color}18` }} key={label.id}>{label.name}</span>)}</div>
                            <h2>{card.title}</h2>
                            <p>{card.company || "Sem empresa informada"}</p>
                            <div className="dashboard-task-bottom"><span className={`dashboard-sla ${card.slaStatus}`}>◷ {slaLabel(card)}</span><span className="dashboard-check">✓ {completed}/{card.checklist.length}</span>{card.attachments.length > 0 && <span className="dashboard-comments">↥ {card.attachments.length}</span>}{card.comments.length > 0 && <span className="dashboard-comments">● {card.comments.length}</span>}<span className="dashboard-mini-avatar">{initials(card.assignees[0]?.name || card.assigneeName || "DP")}</span>{card.assignees.length > 1 && <small className="avatar-more">+{card.assignees.length - 1}</small>}</div>
                          </article>
                        );
                      })}
                      {canEdit && <button className="dashboard-add-card" onClick={() => { setCardForm({ ...emptyCardForm, listId: list.id }); setSelectedCardId(null); setCardTab("details"); setCardModalOpen(true); }}>＋ Adicionar demanda</button>}
                    </div>
                  </section>
                  );
                })}
              </div>}
              {boardMode === "table" && <DemandTableView cards={filteredActiveCards} lists={snapshot.lists} onOpen={openCard} />}
              {boardMode === "calendar" && <DemandCalendarView cards={filteredActiveCards} onOpen={openCard} />}
              {boardMode === "process" && <ProcessTablesView cards={filteredActiveCards} lists={snapshot.lists} onOpen={openCard} />}
            </>
          )}

          {view === "inbox" && <InboxView items={snapshot.inbox} busy={busy} canEdit={canEdit} onConvert={convertInbox} onNew={() => setInboxModalOpen(true)} />}
          {view === "planner" && <PlannerView cards={activeCards} blocks={snapshot.plannerBlocks} onOpen={openCard} onCreateBlock={(payload) => mutate("/api/planner/blocks", { method: "POST", body: JSON.stringify(payload) }, "Bloco adicionado ao planner.")} onDeleteBlock={(id) => mutate(`/api/planner/blocks/${id}`, { method: "DELETE" }, "Bloco removido do planner.")} />}
          {view === "indicators" && <IndicatorsView cards={activeCards} rules={snapshot.rules} busy={busy} canManageRules={isAdmin} onToggleRule={toggleRule} onExport={exportCsv} hrMetrics={snapshot.hrMetrics} companies={snapshot.companies} />}
          {view === "companies" && <CompaniesView companies={snapshot.companies} metrics={snapshot.hrMetrics} busy={busy} canEdit={canEdit} onCreateCompany={createCompany} onDeleteCompany={deleteCompany} onSaveMetric={saveHrMetric} />}
        </div>
      </section>

      {error && <div className="workspace-toast error" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
      {toast && <div className="workspace-toast" role="status"><span>✓</span>{toast}</div>}
      {busy && <div className="workspace-busy" aria-label="Salvando"><i /></div>}

      {searchOpen && (
        <div className="workspace-modal-backdrop search-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
          <section className="search-palette" role="dialog" aria-modal="true" aria-labelledby="search-title">
            <header><span aria-hidden="true">⌕</span><input id="search-title" autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Buscar demanda, empresa, responsável, etiqueta…" /><kbd>ESC</kbd></header>
            <div className="search-results">
              {searchResults.length === 0 && <div className="empty-view"><span>⌕</span><strong>{searchQuery ? "Nenhum resultado" : "Busca operacional"}</strong><p>{searchQuery ? "Tente outro termo ou verifique os filtros do quadro." : "Digite para localizar demandas ativas ou arquivadas."}</p></div>}
              {searchResults.map((result) => <button key={result.id} onClick={() => openSearchResult(result)}><i className={processColors[result.processType] ?? "gray"} /><span><strong>{result.title}</strong><small>{result.company || result.processType} • {result.assigneeName || "Sem responsável"}</small></span><em className={result.slaStatus}>{result.archived ? "Arquivada" : compactSlaLabel(result.slaStatus, result.dueAt)}</em></button>)}
            </div>
            <footer><span>Atalho global</span><kbd>Ctrl</kbd><b>+</b><kbd>K</kbd></footer>
          </section>
        </div>
      )}

      {notificationsOpen && (
        <div className="workspace-modal-backdrop drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNotificationsOpen(false); }}>
          <aside className="notification-drawer" role="dialog" aria-modal="true" aria-labelledby="notifications-title">
            <header><div><span>CENTRAL DE ALERTAS</span><h2 id="notifications-title">Notificações</h2></div><button onClick={() => setNotificationsOpen(false)} aria-label="Fechar">×</button></header>
            <div className="notification-actions"><span>{snapshot.notifications.filter((item) => !item.readAt).length} não lida(s)</span><button disabled={busy || !snapshot.notifications.some((item) => !item.readAt)} onClick={() => void markAllNotifications()}>Marcar todas como lidas</button></div>
            <div className="notification-list">
              {/* eslint-disable-next-line @typescript-eslint/no-unused-expressions */}
              {snapshot.notifications.length === 0 && <div className="empty-view"><span>✓</span><strong>Tudo em dia</strong><p>Alertas de SLA, comentários e movimentações aparecerão aqui.</p></div>}
              {snapshot.notifications.map((notification) => <button className={notification.readAt ? "read" : "unread"} key={notification.id} onClick={() => { if (!notification.readAt) void markNotification(notification.id); const card = notification.cardId ? allCards.find((item) => item.id === notification.cardId) : null; if (card) { setNotificationsOpen(false); card.archived ? setArchiveOpen(true) : openCard(card); } }}><i>{notification.type.includes("sla") ? "!" : "●"}</i><span><strong>{notification.title}</strong><p>{notification.body}</p><time>{formatMoment(notification.createdAt)}</time></span></button>)}
            </div>
          </aside>
        </div>
      )}

      {archiveOpen && (
        <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setArchiveOpen(false); }}>
          <section className="workspace-modal archive-modal" role="dialog" aria-modal="true" aria-labelledby="archive-title">
            <header><div><span>HISTÓRICO RECUPERÁVEL</span><h2 id="archive-title">Demandas arquivadas</h2></div><button onClick={() => setArchiveOpen(false)} aria-label="Fechar">×</button></header>
            <div className="archive-list">
              {snapshot.archivedCards.length === 0 && <div className="empty-view"><span>□</span><strong>Arquivo vazio</strong><p>Demandas arquivadas poderão ser restauradas por aqui.</p></div>}
              {snapshot.archivedCards.map((card) => <article key={card.id}><i className={processColors[card.processType] ?? "gray"} /><div><span>{card.processType}</span><strong>{card.title}</strong><small>{card.company || "Sem empresa"} • arquivada em {formatDate(card.updatedAt)}</small></div><button disabled={busy || !canEdit} onClick={() => void restoreCard(card.id)}>Restaurar</button>{isAdmin && <button className="danger" disabled={busy} onClick={() => void deleteCardPermanently(card.id, card.title)}>Excluir</button>}</article>)}
            </div>
          </section>
        </div>
      )}

      {cardModalOpen && (
        <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCardModalOpen(false); }}>
          <section className="workspace-modal card-modal" role="dialog" aria-modal="true" aria-labelledby="card-modal-title">
            <header><div><span>{selectedCard ? `Demanda • ${selectedCard.processType}` : "Nova demanda"}</span><h2 id="card-modal-title">{selectedCard ? selectedCard.title : "Adicionar à fila"}</h2></div><button onClick={() => setCardModalOpen(false)} aria-label="Fechar">×</button></header>
            {selectedCard && <nav className="card-dialog-tabs" aria-label="Seções da demanda"><button className={cardTab === "details" ? "active" : ""} onClick={() => setCardTab("details")}>Detalhes</button><button className={cardTab === "checklist" ? "active" : ""} onClick={() => setCardTab("checklist")}>Checklist <b>{selectedCard.checklist.filter((item) => item.completed).length}/{selectedCard.checklist.length}</b></button><button className={cardTab === "attachments" ? "active" : ""} onClick={() => setCardTab("attachments")}>Anexos <b>{selectedCard.attachments.length}</b></button><button className={cardTab === "activity" ? "active" : ""} onClick={() => setCardTab("activity")}>Atividade <b>{selectedCard.comments.length}</b></button></nav>}
            <div className="card-modal-body single">
              {(!selectedCard || cardTab === "details") &&
              <form className={`card-form ${!canEdit ? "read-only" : ""}`} onSubmit={saveCard}>
                {!selectedCard && <label className="full">Começar com um template<select value={cardForm.templateId} onChange={(event) => { const template = snapshot.templates.find((item) => item.id === event.target.value); setCardForm({ ...cardForm, templateId: event.target.value, processType: template?.processType ?? cardForm.processType, description: template?.description ?? cardForm.description }); }}><option value="">Demanda em branco</option>{snapshot.templates.filter((item) => item.active).map((template) => <option value={template.id} key={template.id}>{template.name} • SLA {template.defaultSlaDays} dia(s) útil(eis)</option>)}</select></label>}
                <label className="full">Título da demanda<input autoFocus value={cardForm.title} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, title: event.target.value })} placeholder="Ex.: Admissão — Maria Oliveira" required /></label>
                <label className="full">Descrição<textarea value={cardForm.description} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, description: event.target.value })} placeholder="Contexto e orientações para execução" rows={4} /></label>
                <label>Tipo de processo<select value={cardForm.processType} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, processType: event.target.value })}><option>ADMISSÃO</option><option>RESCISÃO</option><option>FÉRIAS</option><option>BENEFÍCIOS</option><option>FOLHA</option><option>CADASTRO</option><option>OUTROS</option></select></label>
                <label>Empresa<select value={cardForm.companyId} disabled={!canEdit} onChange={(event) => { const company = snapshot.companies.find((item) => item.id === event.target.value); setCardForm({ ...cardForm, companyId: event.target.value, company: company ? (company.tradeName || company.legalName) : cardForm.company }); }}><option value="">Sem empresa vinculada</option>{snapshot.companies.filter((company) => company.status === "active" || company.id === cardForm.companyId).map((company) => <option value={company.id} key={company.id}>{company.tradeName || company.legalName}{company.taxId ? ` • ${company.taxId}` : ""}{company.status !== "active" ? " (inativa)" : ""}</option>)}</select></label>
                <label>Prazo<input type="date" value={cardForm.dueAt} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, dueAt: event.target.value })} /></label>
                <label>Prioridade<select value={cardForm.priority} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, priority: event.target.value })}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
                <label>Coluna<select value={cardForm.listId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, listId: event.target.value })}><option value="">Automática pelas regras</option>{snapshot.lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label>
                <section className="card-choice-section full"><header><strong>Responsáveis</strong><span>Selecione uma ou mais pessoas</span></header><div className="choice-chips">{snapshot.members.filter((member) => member.role === "admin" || member.role === "member").map((member) => <label className={cardForm.assigneeIds.includes(member.userId) ? "selected" : ""} key={member.userId}><input type="checkbox" checked={cardForm.assigneeIds.includes(member.userId)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, assigneeIds: event.target.checked ? [...cardForm.assigneeIds, member.userId] : cardForm.assigneeIds.filter((id) => id !== member.userId) })} /><i>{initials(member.name)}</i>{member.name}</label>)}</div></section>
                <section className="card-choice-section full"><header><strong>Etiquetas</strong><span>Classifique sem alterar o processo</span></header><div className="choice-chips label-choices">{snapshot.labels.map((label) => <label className={cardForm.labelIds.includes(label.id) ? "selected" : ""} style={{ borderColor: cardForm.labelIds.includes(label.id) ? label.color : undefined }} key={label.id}><input type="checkbox" checked={cardForm.labelIds.includes(label.id)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, labelIds: event.target.checked ? [...cardForm.labelIds, label.id] : cardForm.labelIds.filter((id) => id !== label.id) })} /><i style={{ backgroundColor: label.color }} />{label.name}</label>)}</div></section>
                {snapshot.customFields.map((field) => <label key={field.id}>{field.name}{field.fieldType === "select" ? <select value={cardForm.customValues[field.fieldKey] ?? ""} disabled={!canEdit} required={field.required} onChange={(event) => setCardForm({ ...cardForm, customValues: { ...cardForm.customValues, [field.fieldKey]: event.target.value } })}><option value="">Selecione</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select> : <input type={field.fieldType === "date" ? "date" : field.fieldType === "number" ? "number" : "text"} value={cardForm.customValues[field.fieldKey] ?? ""} disabled={!canEdit} required={field.required} onChange={(event) => setCardForm({ ...cardForm, customValues: { ...cardForm.customValues, [field.fieldKey]: event.target.value } })} />}</label>)}
                <div className="card-form-actions full">{selectedCard && canEdit && !selectedCard.archived && <button type="button" className="danger-link" onClick={archiveCard}>Arquivar demanda</button>}{selectedCard && canEdit && !selectedCard.archived && <button type="button" className="secondary-button" onClick={() => void toggleSlaPause()}>{selectedCard.slaStatus === "paused" ? "Retomar SLA" : "Pausar SLA"}</button>}<span /><button type="button" className="secondary-button" onClick={() => setCardModalOpen(false)}>Fechar</button>{canEdit && !selectedCard?.archived && <button className="primary-button" disabled={busy}>{selectedCard ? "Salvar alterações" : "Criar demanda"}</button>}</div>
              </form>}

              {selectedCard && cardTab === "checklist" && (
                <section className="card-tab-panel checklist-panel">
                  <div><span>CHECKLIST</span><strong>{selectedCard.checklist.filter((item) => item.completed).length}/{selectedCard.checklist.length}</strong></div>
                  <div className="checklist-progress"><i style={{ width: `${selectedCard.checklist.length ? (selectedCard.checklist.filter((item) => item.completed).length / selectedCard.checklist.length) * 100 : 0}%` }} /></div>
                  <ul>{selectedCard.checklist.map((item) => <li key={item.id}><label><input type="checkbox" checked={item.completed} disabled={!canEdit} onChange={(event) => void toggleChecklist(item.id, event.target.checked)} /><span>{item.title}</span></label></li>)}</ul>
                  {canEdit && <form onSubmit={addChecklistItem}><input value={newChecklistItem} onChange={(event) => setNewChecklistItem(event.target.value)} placeholder="Nova etapa obrigatória" /><button disabled={!newChecklistItem.trim()}>＋</button></form>}
                  <p>Ao concluir todas as etapas, a demanda será movida automaticamente para Concluído.</p>
                </section>
              )}

              {selectedCard && cardTab === "attachments" && <section className="card-tab-panel attachments-panel"><header><div><span>DOCUMENTOS</span><h3>Anexos da demanda</h3><p>PDF, imagem, TXT, CSV, DOCX ou XLSX, com até 20 MB.</p></div>{canEdit && !selectedCard.archived && <label className="upload-button">＋ Enviar arquivo<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.docx,.xlsx" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAttachment(file); event.target.value = ""; }} /></label>}</header><div className="attachment-list">{selectedCard.attachments.length === 0 && <div className="empty-view"><span>↥</span><strong>Nenhum anexo</strong><p>Envie documentos para manter todo o processo no mesmo lugar.</p></div>}{selectedCard.attachments.map((attachment) => <article key={attachment.id}><i>{attachment.filename.split(".").pop()?.toUpperCase()}</i><div><strong>{attachment.filename}</strong><span>{formatFileSize(attachment.sizeBytes)} • {attachment.uploadedBy} • {formatMoment(attachment.createdAt)}</span></div><a href={attachment.downloadUrl}>Baixar</a>{canEdit && !selectedCard.archived && <button onClick={() => void removeAttachment(attachment.id)} aria-label={`Excluir ${attachment.filename}`}>×</button>}</article>)}</div></section>}

              {selectedCard && cardTab === "activity" && <section className="card-tab-panel activity-panel"><div className="card-collaboration"><header><span>COMENTÁRIOS</span><strong>{selectedCard.comments.length}</strong></header><div className="card-comments">{selectedCard.comments.length === 0 && <p className="card-empty-note">Nenhum comentário ainda.</p>}{selectedCard.comments.map((comment) => <article key={comment.id}><i>{initials(comment.authorName)}</i><div><strong>{comment.authorName}<time>{formatMoment(comment.createdAt)}</time></strong><p>{comment.body}</p>{(comment.authorEmail === user.email || isAdmin) && !selectedCard.archived && <div className="comment-actions"><button onClick={() => void editComment(comment.id, comment.body)}>Editar</button><button onClick={() => void deleteComment(comment.id)}>Excluir</button></div>}</div></article>)}</div>{canComment && !selectedCard.archived && <form className="comment-form" onSubmit={addComment}><textarea value={newComment} onChange={(event) => setNewComment(event.target.value)} placeholder="Escreva uma atualização para a equipe. Use @nome para mencionar alguém." rows={3} maxLength={2000} /><button disabled={!newComment.trim() || busy}>Publicar comentário</button></form>}<header className="activity-heading"><span>HISTÓRICO</span><strong>{selectedCard.activities.length}</strong></header><ol className="activity-list">{selectedCard.activities.slice(0, 20).map((activity) => <li key={activity.id}><i /><div><strong>{activity.actorName}</strong> {activityLabel(activity)}<time>{formatMoment(activity.createdAt)}</time></div></li>)}</ol></div></section>}
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

      {workspaceModalOpen && (
        <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setWorkspaceModalOpen(false); }}>
          <section className="workspace-modal workspace-settings-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title">
            <header><div><span>EQUIPE E ACESSO</span><h2 id="workspace-modal-title">Configurações do workspace</h2></div><button onClick={() => setWorkspaceModalOpen(false)} aria-label="Fechar">×</button></header>
            <div className="workspace-settings-layout">
              <nav className="settings-nav" aria-label="Seções das configurações"><button className={settingsSection === "general" ? "active" : ""} onClick={() => setSettingsSection("general")}>Geral</button><button className={settingsSection === "team" ? "active" : ""} onClick={() => setSettingsSection("team")}>Equipe</button><button className={settingsSection === "fields" ? "active" : ""} onClick={() => setSettingsSection("fields")}>Campos e etiquetas</button><button className={settingsSection === "templates" ? "active" : ""} onClick={() => setSettingsSection("templates")}>Templates</button><button className={settingsSection === "sla" ? "active" : ""} onClick={() => setSettingsSection("sla")}>SLA e calendário</button><button className={settingsSection === "automations" ? "active" : ""} onClick={() => setSettingsSection("automations")}>Automações</button><button className={settingsSection === "integrations" ? "active" : ""} onClick={() => setSettingsSection("integrations")}>Integrações</button></nav>
              <div className="workspace-settings-content">
                {settingsSection === "general" && <><form className="workspace-name-form" onSubmit={saveWorkspace}><label>Nome do workspace<input autoFocus value={workspaceName} disabled={!isAdmin} onChange={(event) => setWorkspaceName(event.target.value)} maxLength={60} required /></label>{isAdmin && <button className="primary-button" disabled={busy}>Salvar nome</button>}</form><div className="workspace-account-summary"><span className="user-avatar">{userInitials}</span><div><strong>{user.displayName}</strong><small>{user.email}</small><em>{roleLabels[snapshot.workspace.role]}</em></div></div>{snapshot.availableWorkspaces.length > 1 && <section className="workspace-switcher"><header><div><strong>Seus workspaces</strong><span>Alterne entre as operações às quais você tem acesso.</span></div></header><div>{snapshot.availableWorkspaces.map((item) => <button className={item.id === snapshot.workspace.id ? "active" : ""} disabled={busy || item.id === snapshot.workspace.id} onClick={() => void switchWorkspace(item.id)} key={item.id}><i>{initials(item.name)}</i><span><strong>{item.name}</strong><small>{roleLabels[item.role]}</small></span><b>{item.id === snapshot.workspace.id ? "Atual" : "Abrir"}</b></button>)}</div></section>}{<section className="board-manager"><header><div><strong>Quadros da operação</strong><span>{snapshot.boards.length} quadro(s) disponíveis</span></div></header><div>{snapshot.boards.map((board) => <button className={board.id === snapshot.board.id ? "active" : ""} key={board.id} onClick={() => void switchBoard(board.id)}><i>{initials(board.name)}</i><span><strong>{board.name}</strong><small>{board.description || "Sem descrição"}</small></span><b>{board.id === snapshot.board.id ? "Atual" : "Abrir"}</b></button>)}</div>{isAdmin && <form className="board-create-form" onSubmit={createBoard}><input value={newBoardName} onChange={(event) => setNewBoardName(event.target.value)} placeholder="Nome do novo quadro" required /><input value={newBoardDescription} onChange={(event) => setNewBoardDescription(event.target.value)} placeholder="Descrição opcional" /><button className="primary-button" disabled={busy}>Criar quadro</button></form>}</section>}</>}
                {settingsSection === "team" && <><section className="workspace-team"><header><div><strong>Equipe</strong><span>{snapshot.members.length} pessoa(s) com acesso</span></div><p>Administrador gerencia tudo; membro executa; observador somente consulta; convidado pode comentar.</p></header><div className="workspace-member-list">{snapshot.members.map((member) => <article key={member.userId}><i>{initials(member.name)}</i><div><strong>{member.name}{member.isOwner && <em>Proprietário</em>}</strong><small>{member.email}</small></div>{isAdmin && !member.isOwner ? <select aria-label={`Papel de ${member.name}`} value={member.role} disabled={busy} onChange={(event) => void updateMemberRole(member.userId, event.target.value as WorkspaceRole)}><option value="admin">Administrador</option><option value="member">Membro</option><option value="observer">Observador</option><option value="guest">Convidado</option></select> : <b>{roleLabels[member.role]}</b>}{isAdmin && !member.isOwner && <button aria-label={`Remover ${member.name}`} disabled={busy} onClick={() => void removeMember(member.userId, member.name)}>×</button>}</article>)}</div></section>{isAdmin && <form className="workspace-invite-form" onSubmit={addMember}><header><strong>Adicionar pessoa</strong><span>O acesso passa a valer quando ela entrar com este e-mail.</span></header><div><label>Nome<input value={memberName} onChange={(event) => setMemberName(event.target.value)} placeholder="Nome da pessoa" maxLength={120} /></label><label>E-mail<input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="nome@empresa.com" required /></label><label>Papel<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as WorkspaceRole)}><option value="member">Membro</option><option value="observer">Observador</option><option value="guest">Convidado</option><option value="admin">Administrador</option></select></label><button className="primary-button" disabled={busy || !memberEmail.trim()}>Adicionar acesso</button></div></form>}</>}
                {settingsSection === "fields" && <FieldsSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} />}
                {settingsSection === "templates" && <TemplatesSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} onUseTemplate={(id) => { setWorkspaceModalOpen(false); openFromTemplate(id); }} />}
                {settingsSection === "sla" && <SlaSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} />}
                {settingsSection === "automations" && <RulesSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} />}
                {settingsSection === "integrations" && <IntegrationsSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} onSync={syncIntegration} />}
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function ProcessTablesView({ cards, lists, onOpen }: { cards: Card[]; lists: WorkspaceSnapshot["lists"]; onOpen: (card: Card) => void }) {
  const grouped = cards.reduce<Record<string, Card[]>>((accumulator, card) => {
    (accumulator[card.processType] ??= []).push(card);
    return accumulator;
  }, {});
  const processNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
  return <div className="process-tables-view">{processNames.length === 0 && <div className="empty-view"><span>▤</span><strong>Nenhuma demanda encontrada</strong><p>Crie uma demanda para iniciar uma tabela de processo.</p></div>}{processNames.map((process) => <section key={process}><header><div><span>FLUXO ESPECÍFICO</span><strong>{process}</strong></div><b>{grouped[process].length} demanda(s)</b></header><DemandTableView cards={grouped[process]} lists={lists} onOpen={onOpen} /></section>)}</div>;
}

function CompaniesView({ companies, metrics, busy, canEdit, onCreateCompany, onDeleteCompany, onSaveMetric }: { companies: WorkspaceSnapshot["companies"]; metrics: WorkspaceSnapshot["hrMetrics"]; busy: boolean; canEdit: boolean; onCreateCompany: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onDeleteCompany: (id: string, name: string) => Promise<WorkspaceSnapshot | null>; onSaveMetric: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null> }) {
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [showMetricForm, setShowMetricForm] = useState(false);
  async function submitCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await onCreateCompany({ legalName: data.get("legalName"), tradeName: data.get("tradeName"), taxId: data.get("taxId"), externalCode: data.get("externalCode"), email: data.get("email"), phone: data.get("phone") });
    if (result) { event.currentTarget.reset(); setShowCompanyForm(false); }
  }
  async function submitMetric(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await onSaveMetric({ companyId: data.get("companyId"), period: data.get("period"), headcount: data.get("headcount"), admissions: data.get("admissions"), terminations: data.get("terminations"), payrollCost: data.get("payrollCost"), source: "manual" });
    if (result) { event.currentTarget.reset(); setShowMetricForm(false); }
  }
  const companyName = new Map(companies.map((company) => [company.id, company.tradeName || company.legalName]));
  const latest = metrics.slice(0, 12);
  return <div className="companies-view"><div className="companies-actions">{canEdit && <><button className="primary-button" onClick={() => setShowCompanyForm((value) => !value)}>＋ Cadastrar empresa</button><button className="secondary-button" onClick={() => setShowMetricForm((value) => !value)}>＋ Registrar folha</button></>}</div>{showCompanyForm && <form className="company-form catalog-card" onSubmit={submitCompany}><header><div><strong>Cadastro de empresa</strong><span>Use o código externo para vincular ao Sankhya.</span></div></header><div className="catalog-form"><label>Razão social<input name="legalName" required placeholder="Empresa Exemplo Ltda." /></label><label>Nome fantasia<input name="tradeName" placeholder="Empresa Exemplo" /></label><label>CNPJ<input name="taxId" placeholder="00.000.000/0001-00" /></label><label>Código Sankhya<input name="externalCode" placeholder="COD_EMPRESA" /></label><label>E-mail<input type="email" name="email" /></label><label>Telefone<input name="phone" /></label><button className="primary-button" disabled={busy}>Salvar empresa</button></div></form>}{showMetricForm && <form className="metric-form catalog-card" onSubmit={submitMetric}><header><div><strong>Registrar custo e movimentação da folha</strong><span>Turnover = (admissões + desligamentos) ÷ 2 ÷ headcount médio.</span></div></header><div className="catalog-form"><label>Empresa<select name="companyId" required defaultValue=""><option value="" disabled>Selecione</option>{companies.filter((company) => company.status === "active").map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label><label>Competência<input type="month" name="period" required defaultValue={new Date().toISOString().slice(0, 7)} /></label><label>Headcount<input type="number" name="headcount" min="0" defaultValue="0" /></label><label>Admissões<input type="number" name="admissions" min="0" defaultValue="0" /></label><label>Desligamentos<input type="number" name="terminations" min="0" defaultValue="0" /></label><label>Custo da folha<input type="number" name="payrollCost" min="0" step="0.01" defaultValue="0" /></label><button className="primary-button" disabled={busy || companies.length === 0}>Salvar competência</button></div></form>}<section className="companies-list catalog-card"><header><div><strong>Empresas cadastradas</strong><span>{companies.length} empresa(s) • vínculo para demandas e indicadores</span></div></header>{companies.length === 0 && <div className="empty-view"><span>▤</span><strong>Nenhuma empresa cadastrada</strong><p>Cadastre a primeira empresa para registrar a folha.</p></div>}{companies.map((company) => <article key={company.id}><div><strong>{company.tradeName || company.legalName}</strong><small>{company.taxId || "CNPJ não informado"} • {company.externalCode || "Sem código Sankhya"}</small></div><span>{company.email || company.phone || "Sem contato"}</span>{canEdit && <button disabled={busy} onClick={() => void onDeleteCompany(company.id, company.legalName)}>Excluir</button>}</article>)}</section><section className="metrics-list catalog-card"><header><div><strong>Histórico de folha</strong><span>{metrics.length} competência(s) registrada(s)</span></div></header>{latest.length === 0 && <div className="empty-view"><span>◷</span><strong>Nenhum indicador de folha</strong><p>Registre uma competência ou conecte o Sankhya.</p></div>}{latest.map((metric) => <article key={metric.id}><div><strong>{companyName.get(metric.companyId) ?? "Empresa removida"}</strong><small>{metric.period} • origem {metric.source}</small></div><span>{metric.headcount} colaboradores</span><span>{metric.admissions} admissões / {metric.terminations} desligamentos</span><b>{metric.payrollCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</b></article>)}</section></div>;
}

function DemandTableView({ cards, lists, onOpen }: { cards: Card[]; lists: WorkspaceSnapshot["lists"]; onOpen: (card: Card) => void }) {
  const listNames = new Map(lists.map((list) => [list.id, list.name]));
  return (
    <section className="demand-table-view">
      <header><div><strong>Visão gerencial</strong><span>{cards.length} demanda(s) nos filtros atuais</span></div><span>Selecione uma linha para abrir os detalhes.</span></header>
      <div className="demand-table-scroll">
        <table>
          <thead><tr><th>Demanda</th><th>Processo</th><th>Status</th><th>Responsáveis</th><th>Prazo / SLA</th><th>Checklist</th></tr></thead>
          <tbody>{cards.map((card) => {
            const complete = card.checklist.filter((item) => item.completed).length;
            return <tr key={card.id} tabIndex={0} onClick={() => onOpen(card)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpen(card); }}><td><strong>{card.title}</strong><small>{card.company || "Sem empresa"}</small></td><td><span className={`table-process ${processColors[card.processType] ?? "gray"}`}>{card.processType}</span></td><td>{listNames.get(card.listId) ?? "—"}</td><td>{card.assignees.map((item) => item.name).join(", ") || card.assigneeName || "Não atribuído"}</td><td><em className={card.slaStatus}>{slaLabel(card)}</em></td><td>{complete}/{card.checklist.length}</td></tr>;
          })}</tbody>
        </table>
        {cards.length === 0 && <div className="empty-view"><span>▤</span><strong>Nenhuma demanda encontrada</strong><p>Ajuste os filtros para ampliar a visão.</p></div>}
      </div>
    </section>
  );
}

function DemandCalendarView({ cards, onOpen }: { cards: Card[]; onOpen: (card: Card) => void }) {
  const [cursor, setCursor] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const leading = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: leading + daysInMonth }, (_, index) => index < leading ? null : index - leading + 1);
  const cardsByDay = cards.reduce<Record<number, Card[]>>((accumulator, card) => {
    if (!card.dueAt) return accumulator;
    const [cardYear, cardMonth, cardDay] = card.dueAt.slice(0, 10).split("-").map(Number);
    if (cardYear === year && cardMonth === month + 1) (accumulator[cardDay] ??= []).push(card);
    return accumulator;
  }, {});
  return (
    <section className="demand-calendar-view">
      <header><button aria-label="Mês anterior" onClick={() => setCursor(new Date(year, month - 1, 1))}>←</button><div><strong>{new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(cursor)}</strong><span>{Object.values(cardsByDay).flat().length} prazo(s) neste mês</span></div><button aria-label="Próximo mês" onClick={() => setCursor(new Date(year, month + 1, 1))}>→</button></header>
      <div className="calendar-grid"><div className="calendar-weekdays">{["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-days">{cells.map((day, index) => <article className={!day ? "empty" : ""} key={`${day ?? "empty"}-${index}`}>{day && <><b>{day}</b><div>{(cardsByDay[day] ?? []).slice(0, 3).map((card) => <button className={card.slaStatus} key={card.id} onClick={() => onOpen(card)} title={card.title}><i className={processColors[card.processType] ?? "gray"} />{card.title}</button>)}{(cardsByDay[day]?.length ?? 0) > 3 && <small>+{cardsByDay[day].length - 3} demanda(s)</small>}</div></>}</article>)}</div></div>
      {cards.every((card) => !card.dueAt) && <div className="calendar-empty-note">Defina prazos nas demandas para visualizá-las no calendário.</div>}
    </section>
  );
}

function FieldsSettings({ snapshot, busy, isAdmin, onCatalog }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler }) {
  async function createLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = await onCatalog({ resource: "label", name: data.get("name"), color: data.get("color") }, "Etiqueta criada.");
    if (next) form.reset();
  }
  async function createField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = await onCatalog({ resource: "field", name: data.get("name"), fieldKey: data.get("fieldKey"), fieldType: data.get("fieldType"), required: data.get("required") === "on", options: String(data.get("options") ?? "").split(",").map((item) => item.trim()).filter(Boolean) }, "Campo personalizado criado.");
    if (next) form.reset();
  }
  return <div className="settings-stack"><section className="catalog-section"><header><div><strong>Etiquetas operacionais</strong><span>Cores para urgência, área ou classificação complementar.</span></div><b>{snapshot.labels.length}</b></header><div className="label-catalog">{snapshot.labels.map((label) => <article key={label.id}><i style={{ backgroundColor: label.color }} /><strong>{label.name}</strong>{isAdmin && <button disabled={busy} onClick={() => { if (window.confirm(`Excluir a etiqueta “${label.name}”?`)) void onCatalog({ resource: "label", operation: "delete", id: label.id }, "Etiqueta excluída."); }} aria-label={`Excluir ${label.name}`}>×</button>}</article>)}</div>{isAdmin && <form className="catalog-form compact" onSubmit={createLabel}><label>Nome<input name="name" maxLength={40} placeholder="Ex.: Urgente" required /></label><label>Cor<select name="color" defaultValue="#dc2626"><option value="#dc2626">Vermelho</option><option value="#ea580c">Laranja</option><option value="#d97706">Amarelo</option><option value="#16a34a">Verde</option><option value="#0891b2">Ciano</option><option value="#2563eb">Azul</option><option value="#7c3aed">Roxo</option><option value="#64748b">Cinza</option></select></label><button className="primary-button" disabled={busy}>Adicionar</button></form>}</section>
    <section className="catalog-section"><header><div><strong>Campos personalizados</strong><span>Dados estruturados visíveis nos cartões de DP.</span></div><b>{snapshot.customFields.length}</b></header><div className="field-catalog">{snapshot.customFields.map((field) => <article key={field.id}><div><strong>{field.name}{field.required && <em>Obrigatório</em>}</strong><small>{field.fieldKey} • {field.fieldType}{field.options.length ? ` • ${field.options.join(", ")}` : ""}</small></div>{isAdmin && <button disabled={busy} onClick={() => { if (window.confirm(`Excluir o campo “${field.name}”?`)) void onCatalog({ resource: "field", operation: "delete", id: field.id }, "Campo excluído."); }} aria-label={`Excluir ${field.name}`}>×</button>}</article>)}</div>{isAdmin && <form className="catalog-form fields-form" onSubmit={createField}><label>Nome<input name="name" placeholder="Ex.: Matrícula" maxLength={60} required /></label><label>Identificador<input name="fieldKey" placeholder="matricula" pattern="[A-Za-z0-9_]+" required /></label><label>Tipo<select name="fieldType" defaultValue="text"><option value="text">Texto</option><option value="number">Número</option><option value="date">Data</option><option value="select">Lista</option></select></label><label className="wide">Opções da lista<input name="options" placeholder="Opção 1, Opção 2" /></label><label className="catalog-check"><input type="checkbox" name="required" /> Obrigatório</label><button className="primary-button" disabled={busy}>Criar campo</button></form>}</section></div>;
}

function TemplatesSettings({ snapshot, busy, isAdmin, onCatalog, onUseTemplate }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler; onUseTemplate: (id: string) => void }) {
  async function createTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const checklist = String(data.get("checklist") ?? "").split("\n").map((item) => item.trim()).filter(Boolean);
    const next = await onCatalog({ resource: "template", name: data.get("name"), processType: data.get("processType"), description: data.get("description"), checklist, defaultSlaDays: Number(data.get("defaultSlaDays")) }, "Template criado.");
    if (next) form.reset();
  }
  return <div className="settings-stack"><section className="catalog-section"><header><div><strong>Templates de processos</strong><span>Checklists e SLA prontos para iniciar uma demanda sem esquecer etapas.</span></div><b>{snapshot.templates.length}</b></header><div className="template-catalog">{snapshot.templates.map((template) => <article key={template.id}><div><span>{template.processType}</span><strong>{template.name}</strong><small>{template.checklist.length} etapa(s) • SLA de {template.defaultSlaDays} dia(s) útil(eis)</small></div><button onClick={() => onUseTemplate(template.id)}>Usar</button>{isAdmin && <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Excluir o template “${template.name}”?`)) void onCatalog({ resource: "template", operation: "delete", id: template.id }, "Template excluído."); }}>Excluir</button>}</article>)}</div></section>{isAdmin && <section className="catalog-section"><header><div><strong>Novo template</strong><span>Uma etapa por linha no checklist.</span></div></header><form className="catalog-form template-form" onSubmit={createTemplate}><label>Nome<input name="name" placeholder="Ex.: Admissão completa" required /></label><label>Processo<select name="processType" defaultValue="ADMISSÃO"><option>ADMISSÃO</option><option>FÉRIAS</option><option>RESCISÃO</option><option>BENEFÍCIOS</option><option>FOLHA</option><option>CADASTRO</option><option>OUTROS</option></select></label><label>SLA (dias úteis)<input type="number" min="1" max="60" name="defaultSlaDays" defaultValue="3" required /></label><label className="wide">Descrição<textarea name="description" rows={2} placeholder="Orientações para o processo" /></label><label className="wide">Etapas<textarea name="checklist" rows={7} placeholder={'Receber documentos\nValidar cadastro\nConferir informações'} required /></label><button className="primary-button" disabled={busy}>Salvar template</button></form></section>}</div>;
}

function SlaSettings({ snapshot, busy, isAdmin, onCatalog }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler }) {
  const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  async function saveCalendar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onCatalog({ resource: "settings", businessDays: data.getAll("businessDays").map(Number), dayStart: data.get("dayStart"), dayEnd: data.get("dayEnd"), realtimeSeconds: Number(data.get("realtimeSeconds")) }, "Calendário de SLA atualizado.");
  }
  async function addHoliday(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = await onCatalog({ resource: "holiday", date: data.get("date"), name: data.get("name") }, "Feriado adicionado ao calendário.");
    if (next) form.reset();
  }
  return <div className="settings-stack"><section className="catalog-section"><header><div><strong>Calendário operacional</strong><span>O prazo ignora dias não úteis e feriados cadastrados.</span></div></header><form className="calendar-settings-form" onSubmit={saveCalendar}><fieldset disabled={!isAdmin || busy}><legend>Dias úteis</legend><div>{weekdays.map((day, index) => <label key={day}><input type="checkbox" name="businessDays" value={index} defaultChecked={snapshot.settings.businessDays.includes(index)} />{day}</label>)}</div></fieldset><label>Início do expediente<input type="time" name="dayStart" defaultValue={snapshot.settings.dayStart} disabled={!isAdmin || busy} /></label><label>Fim do expediente<input type="time" name="dayEnd" defaultValue={snapshot.settings.dayEnd} disabled={!isAdmin || busy} /></label><label>Atualização da tela<select name="realtimeSeconds" defaultValue={snapshot.settings.realtimeSeconds} disabled={!isAdmin || busy}><option value="5">5 segundos</option><option value="15">15 segundos</option><option value="30">30 segundos</option><option value="60">1 minuto</option><option value="120">2 minutos</option></select></label>{isAdmin && <button className="primary-button" disabled={busy}>Salvar calendário</button>}</form></section>
    <section className="catalog-section"><header><div><strong>Políticas por processo</strong><span>Meta e janela de atenção em dias úteis.</span></div></header><div className="sla-policy-list">{snapshot.slaPolicies.map((policy) => <form key={policy.id} onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void onCatalog({ resource: "sla", processType: policy.processType, targetBusinessDays: Number(data.get("target")), warningBusinessDays: Number(data.get("warning")), active: data.get("active") === "on" }, `SLA de ${policy.processType} atualizado.`); }}><strong>{policy.processType}</strong><label>Meta<input type="number" name="target" min="1" max="60" defaultValue={policy.targetBusinessDays} disabled={!isAdmin || busy} /></label><label>Alertar antes<input type="number" name="warning" min="0" max="60" defaultValue={policy.warningBusinessDays} disabled={!isAdmin || busy} /></label><label className="catalog-check"><input type="checkbox" name="active" defaultChecked={policy.active} disabled={!isAdmin || busy} /> Ativa</label>{isAdmin && <button disabled={busy}>Salvar</button>}</form>)}</div></section>
    <section className="catalog-section"><header><div><strong>Feriados e exceções</strong><span>{snapshot.holidays.length} data(s) fora do expediente.</span></div></header><div className="holiday-list">{snapshot.holidays.map((holiday) => <article key={holiday.date}><time>{formatDate(holiday.date, true)}</time><strong>{holiday.name}</strong>{isAdmin && <button onClick={() => void onCatalog({ resource: "holiday", operation: "delete", date: holiday.date }, "Feriado removido.")} disabled={busy}>×</button>}</article>)}</div>{isAdmin && <form className="catalog-form compact" onSubmit={addHoliday}><label>Data<input type="date" name="date" required /></label><label>Nome<input name="name" placeholder="Ex.: Feriado municipal" required /></label><button className="primary-button" disabled={busy}>Adicionar</button></form>}</section></div>;
}

function IntegrationsSettings({ snapshot, busy, isAdmin, onCatalog, onSync }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler; onSync: (channel: string) => Promise<void> }) {
  const channelCopy: Record<string, { icon: string; description: string; placeholder: string }> = {
    email: { icon: "@", description: "Capture e-mails recebidos e transforme-os em itens da Inbox.", placeholder: "dp@empresa.com" },
    whatsapp: { icon: "W", description: "Receba solicitações via provedor oficial ou intermediador homologado.", placeholder: "Identificador do número/provedor" },
    teams: { icon: "T", description: "Direcione mensagens de canais do Teams para triagem.", placeholder: "URL ou identificador do canal" },
    drive: { icon: "D", description: "Referencie documentos do Google Drive nos processos.", placeholder: "Pasta padrão ou URL" },
    onedrive: { icon: "O", description: "Referencie documentos do OneDrive nos processos.", placeholder: "Pasta padrão ou URL" },
    erp: { icon: "E", description: "Sincronize eventos do ERP, custo da folha e indicadores com a Inbox.", placeholder: "Endpoint do Sankhya Gateway" },
  };
  return <div className="settings-stack"><div className="integration-security-note"><i>!</i><div><strong>Conexão segura por credenciais do ambiente</strong><p>Esta tela salva somente endereços e preferências. Tokens, senhas e chaves devem ser adicionados ao cofre seguro da implantação antes de ativar a sincronização real.</p></div></div><div className="integration-grid">{snapshot.integrations.map((integration) => { const copy = channelCopy[integration.channel] ?? { icon: "↗", description: "Integração externa configurável.", placeholder: "Endpoint ou referência" }; return <form key={integration.id} onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void onCatalog({ resource: "integration", id: integration.id, status: data.get("status"), config: { endpoint: data.get("endpoint"), account: data.get("account") } }, `${integration.displayName} atualizado.`); }}><header><i>{copy.icon}</i><div><strong>{integration.displayName}</strong><span className={integration.status}>{integration.status === "connected" ? "Conectada" : integration.status === "paused" ? "Pausada" : integration.status === "error" ? "Com erro" : "Aguardando credenciais"}</span></div></header><p>{copy.description}</p><label>Conta / origem<input name="account" defaultValue={String(integration.config.account ?? "")} placeholder={copy.placeholder} disabled={!isAdmin || busy} /></label><label>Endpoint ou referência<input name="endpoint" defaultValue={String(integration.config.endpoint ?? "")} placeholder="https://…" disabled={!isAdmin || busy} /></label><label>Operação<select name="status" defaultValue={integration.status === "paused" ? "paused" : "needs_credentials"} disabled={!isAdmin || busy}><option value="needs_credentials">Aguardando credenciais</option><option value="paused">Pausada</option></select></label>{integration.lastError && <small className="integration-error">{integration.lastError}</small>}{isAdmin && <div className="integration-actions"><button className="primary-button" disabled={busy}>Salvar configuração</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void onSync(integration.channel)}>Sincronizar agora</button></div>}</form>; })}</div></div>;
}

type CatalogHandlerV2 = (payload: Record<string, unknown>, message: string) => Promise<WorkspaceSnapshot | null>;

function FieldsSettingsV2({ snapshot, busy, isAdmin, onCatalog }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandlerV2 }) {
  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState("#2563eb");
  const [fieldName, setFieldName] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const [fieldOptions, setFieldOptions] = useState("");
  const [fieldRequired, setFieldRequired] = useState(false);
  async function createLabel(event: FormEvent) { event.preventDefault(); if (!labelName.trim()) return; const result = await onCatalog({ resource: "label", name: labelName, color: labelColor }, "Etiqueta criada."); if (result) setLabelName(""); }
  async function createField(event: FormEvent) { event.preventDefault(); if (!fieldName.trim() || !fieldKey.trim()) return; const result = await onCatalog({ resource: "field", name: fieldName, fieldKey, fieldType, options: fieldOptions.split(",").map((item) => item.trim()).filter(Boolean), required: fieldRequired }, "Campo personalizado criado."); if (result) { setFieldName(""); setFieldKey(""); setFieldOptions(""); setFieldRequired(false); } }
  return <div className="catalog-settings"><div className="settings-intro"><span>PADRONIZAÇÃO</span><h3>Campos e etiquetas</h3><p>Deixe os cartões com a linguagem e os dados que a sua operação realmente usa.</p></div>
    <section className="catalog-card"><header><div><strong>Etiquetas</strong><span>{snapshot.labels.length} disponíveis</span></div></header><div className="catalog-items">{snapshot.labels.map((label) => <article key={label.id}><i style={{ backgroundColor: label.color }} /><strong>{label.name}</strong>{isAdmin && <button disabled={busy} onClick={() => void onCatalog({ resource: "label", operation: "delete", id: label.id }, "Etiqueta removida.")}>×</button>}</article>)}</div>{isAdmin && <form className="catalog-form compact" onSubmit={createLabel}><input value={labelName} onChange={(event) => setLabelName(event.target.value)} placeholder="Nova etiqueta" /><input type="color" value={labelColor} onChange={(event) => setLabelColor(event.target.value)} aria-label="Cor da etiqueta" /><button className="primary-button" disabled={busy || !labelName.trim()}>Adicionar</button></form>}</section>
    <section className="catalog-card"><header><div><strong>Campos personalizados</strong><span>{snapshot.customFields.length} configurado(s)</span></div></header><div className="catalog-items">{snapshot.customFields.map((field) => <article className="field-item" key={field.id}><div><strong>{field.name}</strong><small>{field.fieldKey} • {field.fieldType}{field.required ? " • obrigatório" : ""}</small></div>{isAdmin && <button disabled={busy} onClick={() => void onCatalog({ resource: "field", operation: "delete", id: field.id }, "Campo removido.")}>×</button>}</article>)}</div>{isAdmin && <form className="catalog-form" onSubmit={createField}><div><label>Nome<input value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="Ex.: Matrícula" /></label><label>Identificador<input value={fieldKey} onChange={(event) => setFieldKey(event.target.value)} placeholder="matricula" /></label><label>Tipo<select value={fieldType} onChange={(event) => setFieldType(event.target.value)}><option value="text">Texto</option><option value="number">Número</option><option value="date">Data</option><option value="select">Lista</option></select></label></div><label>Opções da lista<input value={fieldOptions} onChange={(event) => setFieldOptions(event.target.value)} placeholder="Separadas por vírgula (quando aplicável)" /></label><label className="inline-check"><input type="checkbox" checked={fieldRequired} onChange={(event) => setFieldRequired(event.target.checked)} /> Campo obrigatório</label><button className="primary-button" disabled={busy || !fieldName.trim() || !fieldKey.trim()}>Criar campo</button></form>}</section>
  </div>;
}

function TemplatesSettingsV2({ snapshot, busy, isAdmin, onCatalog, onUseTemplate }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandlerV2; onUseTemplate: (id: string) => void }) {
  const [name, setName] = useState(""); const [processType, setProcessType] = useState("ADMISSÃO"); const [description, setDescription] = useState(""); const [checklist, setChecklist] = useState(""); const [days, setDays] = useState("3");
  async function create(event: FormEvent) { event.preventDefault(); const result = await onCatalog({ resource: "template", name, processType, description, checklist: checklist.split("\n").map((item) => item.trim()).filter(Boolean), defaultSlaDays: Number(days) }, "Template criado."); if (result) { setName(""); setDescription(""); setChecklist(""); } }
  return <div className="catalog-settings"><div className="settings-intro"><span>PROCESSOS REPETÍVEIS</span><h3>Templates de processo</h3><p>Comece admissões, férias e rescisões com checklist e SLA já preparados.</p></div><section className="template-grid">{snapshot.templates.map((template) => <article className={!template.active ? "inactive" : ""} key={template.id}><header><span>{template.processType}</span><b>{template.defaultSlaDays} dias úteis</b></header><h4>{template.name}</h4><p>{template.description}</p><ol>{template.checklist.slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ol><footer><button className="secondary-button" onClick={() => onUseTemplate(template.id)}>Usar template</button>{isAdmin && !template.id.startsWith("native-") && <button className="danger-link" disabled={busy} onClick={() => void onCatalog({ resource: "template", operation: "delete", id: template.id }, "Template removido.")}>Excluir</button>}</footer></article>)}</section>{isAdmin && <form className="catalog-card template-form" onSubmit={create}><header><div><strong>Novo template</strong><span>Checklist: uma etapa por linha</span></div></header><div className="catalog-form"><div><label>Nome<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Admissão CLT" required /></label><label>Processo<select value={processType} onChange={(event) => setProcessType(event.target.value)}><option>ADMISSÃO</option><option>FÉRIAS</option><option>RESCISÃO</option><option>FOLHA</option><option>OUTROS</option></select></label><label>SLA (dias úteis)<input type="number" min="1" max="60" value={days} onChange={(event) => setDays(event.target.value)} /></label></div><label>Descrição<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} /></label><label>Etapas<textarea value={checklist} onChange={(event) => setChecklist(event.target.value)} rows={5} placeholder="Conferir documentos\nCadastrar no sistema\nEnviar confirmação" required /></label><button className="primary-button" disabled={busy || !name.trim()}>Criar template</button></div></form>}</div>;
}

function SlaSettingsV2({ snapshot, busy, isAdmin, onCatalog }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandlerV2 }) {
  const [days, setDays] = useState(snapshot.settings.businessDays); const [start, setStart] = useState(snapshot.settings.dayStart); const [end, setEnd] = useState(snapshot.settings.dayEnd); const [realtime, setRealtime] = useState(String(snapshot.settings.realtimeSeconds)); const [holidayDate, setHolidayDate] = useState(""); const [holidayName, setHolidayName] = useState("");
  async function saveSettings(event: FormEvent) { event.preventDefault(); const result = await onCatalog({ resource: "settings", businessDays: days, dayStart: start, dayEnd: end, realtimeSeconds: Number(realtime) }, "Política de calendário atualizada."); if (result) setDays(result.settings.businessDays); }
  async function addHoliday(event: FormEvent) { event.preventDefault(); const result = await onCatalog({ resource: "holiday", date: holidayDate, name: holidayName }, "Feriado adicionado."); if (result) { setHolidayDate(""); setHolidayName(""); } }
  return <div className="catalog-settings"><div className="settings-intro"><span>POLÍTICA OPERACIONAL</span><h3>SLA e calendário</h3><p>Os prazos contam dias úteis e respeitam os feriados cadastrados para a operação.</p></div><form className="catalog-card sla-settings-form" onSubmit={saveSettings}><header><div><strong>Jornada de atendimento</strong><span>O relógio do SLA considera estes dias e horários.</span></div></header><div className="weekday-picker">{["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((label, index) => <label className={days.includes(index) ? "selected" : ""} key={label}><input type="checkbox" checked={days.includes(index)} disabled={!isAdmin} onChange={(event) => setDays(event.target.checked ? [...days, index].sort() : days.filter((day) => day !== index))} />{label}</label>)}</div><div className="catalog-form"><label>Início<input type="time" value={start} disabled={!isAdmin} onChange={(event) => setStart(event.target.value)} /></label><label>Fim<input type="time" value={end} disabled={!isAdmin} onChange={(event) => setEnd(event.target.value)} /></label><label>Atualização em tempo real (s)<input type="number" min="15" max="120" value={realtime} disabled={!isAdmin} onChange={(event) => setRealtime(event.target.value)} /></label>{isAdmin && <button className="primary-button" disabled={busy || days.length === 0}>Salvar política</button>}</div></form><section className="catalog-card"><header><div><strong>Políticas por processo</strong><span>Alerta antes do vencimento</span></div></header><div className="sla-policy-list">{snapshot.slaPolicies.map((policy) => <SlaPolicyRowV2 key={policy.id} policy={policy} busy={busy} isAdmin={isAdmin} onCatalog={onCatalog} />)}</div></section><section className="catalog-card"><header><div><strong>Feriados e exceções</strong><span>{snapshot.holidays.length} data(s) sem contagem de SLA</span></div></header><div className="catalog-items">{snapshot.holidays.map((holiday) => <article key={holiday.date}><strong>{formatDate(holiday.date, true)}</strong><span>{holiday.name}</span>{isAdmin && <button disabled={busy} onClick={() => void onCatalog({ resource: "holiday", operation: "delete", date: holiday.date }, "Feriado removido.")}>×</button>}</article>)}</div>{isAdmin && <form className="catalog-form compact" onSubmit={addHoliday}><input type="date" value={holidayDate} onChange={(event) => setHolidayDate(event.target.value)} required /><input value={holidayName} onChange={(event) => setHolidayName(event.target.value)} placeholder="Nome do feriado" required /><button className="primary-button" disabled={busy}>Adicionar feriado</button></form>}</section></div>;
}

function SlaPolicyRowV2({ policy, busy, isAdmin, onCatalog }: { policy: WorkspaceSnapshot["slaPolicies"][number]; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandlerV2 }) {
  const [target, setTarget] = useState(String(policy.targetBusinessDays)); const [warning, setWarning] = useState(String(policy.warningBusinessDays));
  return <form className="sla-policy-row" onSubmit={(event) => { event.preventDefault(); void onCatalog({ resource: "sla", processType: policy.processType, targetBusinessDays: Number(target), warningBusinessDays: Number(warning), active: policy.active }, `SLA de ${policy.processType} atualizado.`); }}><strong>{policy.processType}</strong><label>Meta<input type="number" min="1" max="60" value={target} disabled={!isAdmin} onChange={(event) => setTarget(event.target.value)} /></label><label>Alerta<input type="number" min="0" max="60" value={warning} disabled={!isAdmin} onChange={(event) => setWarning(event.target.value)} /></label>{isAdmin && <button className="secondary-button" disabled={busy}>Salvar</button>}</form>;
}

function IntegrationsSettingsV2({ snapshot, busy, isAdmin, onCatalog }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandlerV2 }) {
  const [values, setValues] = useState<Record<string, string>>({});
  return <div className="catalog-settings"><div className="settings-intro"><span>CANAIS CONECTADOS</span><h3>Integrações</h3><p>Prepare e monitore os canais que alimentam a Inbox. Credenciais ficam fora do banco e devem ser adicionadas no ambiente seguro.</p></div><div className="integration-grid">{snapshot.integrations.map((integration) => { const endpoint = values[`${integration.id}:endpoint`] ?? String(integration.config.endpoint ?? ""); const account = values[`${integration.id}:account`] ?? String(integration.config.account ?? ""); return <article className={`integration-card ${integration.status}`} key={integration.id}><header><i>{integration.channel.slice(0, 1).toUpperCase()}</i><div><strong>{integration.displayName}</strong><span>{integration.status === "connected" ? "Conectada" : integration.status === "paused" ? "Pausada" : "Precisa de credenciais"}</span></div><b>{integration.status === "connected" ? "●" : "○"}</b></header><label>Endpoint / webhook<input value={endpoint} disabled={!isAdmin} onChange={(event) => setValues({ ...values, [`${integration.id}:endpoint`]: event.target.value })} placeholder="https://…" /></label><label>Conta / caixa de entrada<input value={account} disabled={!isAdmin} onChange={(event) => setValues({ ...values, [`${integration.id}:account`]: event.target.value })} placeholder="e-mail, time ou número" /></label><p>Token e segredos são configurados no ambiente de produção.</p>{isAdmin && <div><button className="secondary-button" disabled={busy} onClick={() => void onCatalog({ resource: "integration", id: integration.id, status: "needs_credentials", config: { endpoint, account } }, "Configuração salva; credenciais ainda necessárias.")}>Salvar configuração</button><button className="danger-link" disabled={busy} onClick={() => void onCatalog({ resource: "integration", id: integration.id, status: "paused", config: { endpoint, account } }, "Integração pausada.")}>Pausar</button></div>}</article>; })}</div></div>;
}

function RulesSettings({ snapshot, busy, isAdmin, onCatalog }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler }) {
  const [editorOpen, setEditorOpen] = useState(false); const [editingId, setEditingId] = useState<string | null>(null); const [name, setName] = useState(""); const [trigger, setTrigger] = useState("card.created"); const [conditionJson, setConditionJson] = useState("{}"); const [actionJson, setActionJson] = useState("{}");
  function edit(rule?: WorkspaceSnapshot["rules"][number]) { setEditorOpen(true); setEditingId(rule?.id ?? null); setName(rule?.name ?? ""); setTrigger(rule?.trigger ?? "card.created"); setConditionJson(JSON.stringify(rule?.condition ?? {}, null, 2)); setActionJson(JSON.stringify(rule?.action ?? {}, null, 2)); }
  async function save(event: FormEvent) { event.preventDefault(); if (!name.trim()) return; try { const condition = JSON.parse(conditionJson) as Record<string, unknown>; const action = JSON.parse(actionJson) as Record<string, unknown>; const result = await onCatalog({ resource: "rule", operation: editingId ? "update" : "create", id: editingId ?? "", name, trigger, condition, action, enabled: true }, editingId ? "Automação atualizada." : "Automação criada."); if (result) setEditorOpen(false); } catch { window.alert("Condição e ação precisam ser JSON válido."); } }
  return <div className="settings-stack"><section className="catalog-section rules-editor"><header><div><strong>Editor No-Code</strong><span>Monte gatilho, condição e ação para o fluxo do DP.</span></div>{isAdmin && <button className="secondary-button" onClick={() => edit()}>＋ Nova regra</button>}</header><div className="rule-catalog">{snapshot.rules.map((rule) => <article key={rule.id}><div><strong>{rule.name}</strong><small>{rule.trigger} • {JSON.stringify(rule.condition)} → {JSON.stringify(rule.action)}</small></div>{isAdmin && <><button onClick={() => edit(rule)}>Editar</button><button className="danger" disabled={busy} onClick={() => void onCatalog({ resource: "rule", operation: "delete", id: rule.id }, "Automação excluída.")}>Excluir</button></>}</article>)}</div></section>{isAdmin && editorOpen && <form className="catalog-section rule-editor-form" onSubmit={save}><header><div><strong>{editingId ? "Editar automação" : "Nova automação"}</strong><span>Use JSON simples nos dois campos para manter regras auditáveis.</span></div><button type="button" className="danger-link" onClick={() => setEditorOpen(false)}>Cancelar</button></header><div className="catalog-form"><label>Nome<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Gatilho<select value={trigger} onChange={(event) => setTrigger(event.target.value)}><option>card.created</option><option>card.moved</option><option>assignee.added</option><option>checklist.completed</option><option>sla.tick</option></select></label><label className="wide">Condição<textarea rows={4} value={conditionJson} onChange={(event) => setConditionJson(event.target.value)} /></label><label className="wide">Ação<textarea rows={4} value={actionJson} onChange={(event) => setActionJson(event.target.value)} /></label><button className="primary-button" disabled={busy}>Salvar automação</button></div></form>}</div>;
}

function InboxView({ items, busy, canEdit, onConvert, onNew }: { items: InboxItem[]; busy: boolean; canEdit: boolean; onConvert: (item: InboxItem) => Promise<void>; onNew: () => void }) {
  const pending = items.filter((item) => item.status === "new");
  const converted = items.filter((item) => item.status === "converted");
  return (
    <div className="inbox-layout">
      <section className="inbox-list-panel">
        <header><div><strong>Aguardando triagem</strong><span>{pending.length} nova(s)</span></div>{canEdit && <button onClick={onNew}>＋ Registrar solicitação</button>}</header>
        <div className="inbox-items">
          {pending.length === 0 && <div className="empty-view"><span>✓</span><strong>Inbox organizada</strong><p>Não há solicitações aguardando triagem.</p></div>}
          {pending.map((item) => <article className="inbox-item" key={item.id}><span className={`channel-icon ${item.channel}`}>{item.channel === "whatsapp" ? "W" : item.channel === "email" ? "@" : item.channel === "teams" ? "T" : "+"}</span><div><div><strong>{item.subject}</strong><time>{formatReceived(item.receivedAt)}</time></div><span>{item.senderName} • {item.channel}</span><p>{item.body}</p>{canEdit && <button disabled={busy} onClick={() => void onConvert(item)}>Transformar em demanda →</button>}</div></article>)}
        </div>
      </section>
      <aside className="inbox-summary">
        <span>FLUXO DA INBOX</span><h2>Da mensagem à fila certa.</h2><ol><li><b>1</b><div><strong>Capture</strong><p>Registre solicitações de qualquer canal.</p></div></li><li><b>2</b><div><strong>Faça a triagem</strong><p>Revise contexto e prioridade.</p></div></li><li><b>3</b><div><strong>Converta</strong><p>Crie o cartão com histórico de origem.</p></div></li></ol><div className="inbox-converted"><strong>{converted.length}</strong><span>convertida(s) nesta fila</span></div>
      </aside>
    </div>
  );
}

function PlannerView({ cards, blocks, onOpen, onCreateBlock, onDeleteBlock }: { cards: Card[]; blocks: WorkspaceSnapshot["plannerBlocks"]; onOpen: (card: Card) => void; onCreateBlock: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onDeleteBlock: (id: string) => Promise<WorkspaceSnapshot | null> }) {
  const scheduled = cards.filter((card) => card.dueAt && card.slaStatus !== "completed").sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const grouped = scheduled.reduce<Record<string, Card[]>>((accumulator, card) => { const key = card.dueAt!; (accumulator[key] ??= []).push(card); return accumulator; }, {});
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [blockTitle, setBlockTitle] = useState("");
  const [blockStart, setBlockStart] = useState("");
  const [blockEnd, setBlockEnd] = useState("");
  const [blockCardId, setBlockCardId] = useState("");
  async function createBlock(event: FormEvent) { event.preventDefault(); const next = await onCreateBlock({ title: blockTitle, startAt: new Date(blockStart).toISOString(), endAt: new Date(blockEnd).toISOString(), cardId: blockCardId || null, blockType: "focus" }); if (next) { setBlockTitle(""); setBlockStart(""); setBlockEnd(""); setBlockCardId(""); setShowBlockForm(false); } }
  return (
    <div className="planner-layout">
      <section className="planner-calendar"><header><div><strong>Agenda por prazo</strong><span>{scheduled.length} atividade(s) programada(s) • {blocks.length} bloco(s) de foco</span></div><button className="secondary-button" onClick={() => setShowBlockForm((value) => !value)}>＋ Bloco de tempo</button></header>{showBlockForm && <form className="planner-block-form" onSubmit={createBlock}><label>Título<input value={blockTitle} onChange={(event) => setBlockTitle(event.target.value)} placeholder="Ex.: Conferir admissões" required /></label><label>Início<input type="datetime-local" value={blockStart} onChange={(event) => setBlockStart(event.target.value)} required /></label><label>Fim<input type="datetime-local" value={blockEnd} onChange={(event) => setBlockEnd(event.target.value)} required /></label><label>Demanda<select value={blockCardId} onChange={(event) => setBlockCardId(event.target.value)}><option value="">Bloco geral</option>{cards.map((card) => <option key={card.id} value={card.id}>{card.title}</option>)}</select></label><button className="primary-button">Salvar bloco</button></form>}{blocks.length > 0 && <div className="planner-block-list">{blocks.map((block) => <article key={block.id}><i /><div><strong>{block.title}</strong><small>{new Date(block.startAt).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} – {new Date(block.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small></div><button onClick={() => void onDeleteBlock(block.id)} aria-label={`Excluir ${block.title}`}>×</button></article>)}</div>}{Object.keys(grouped).length === 0 && <div className="empty-view"><span>□</span><strong>Nenhum prazo agendado</strong><p>Defina uma data nas demandas para montar o planner.</p></div>}{Object.entries(grouped).map(([date, dateCards]) => <div className="planner-day" key={date}><div><strong>{formatDate(date, true)}</strong><span>{dateCards.length} demanda(s)</span></div><div>{dateCards.map((card) => <button key={card.id} onClick={() => onOpen(card)}><i className={processColors[card.processType] ?? "gray"} /><span><strong>{card.title}</strong><small>{card.assigneeName || "Sem responsável"} • {card.company || card.processType}</small></span><em className={card.slaStatus}>{slaLabel(card)}</em></button>)}</div></div>)}</section>
      <aside className="planner-focus"><span>FOCO DO DIA</span><h2>{scheduled.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length}</h2><p>demanda(s) precisam de atenção imediata.</p><div><i /><span><strong>Priorize atrasos</strong><small>Comece pelos SLAs vencidos antes de assumir novas atividades.</small></span></div></aside>
    </div>
  );
}

function IndicatorsView({ cards, rules, busy, canManageRules, onToggleRule, onExport, hrMetrics, companies }: { cards: Card[]; rules: WorkspaceSnapshot["rules"]; busy: boolean; canManageRules: boolean; onToggleRule: (id: string, enabled: boolean) => Promise<void>; onExport: () => void; hrMetrics: WorkspaceSnapshot["hrMetrics"]; companies: WorkspaceSnapshot["companies"] }) {
  const [report, setReport] = useState<{ from: string; to: string; total: number; completed: number; completionRate: number; averageCompletionHours: number; activityCount: number; byProcess: Record<string, number>; hrMetrics?: { admissions: number; terminations: number; averageHeadcount: number; payrollCostTotal: number; turnoverRate: number; payrollByCompany: Record<string, number> } } | null>(null);
  const [reportDays, setReportDays] = useState("30");
  useEffect(() => { const to = new Date(); const from = new Date(Date.now() - (Number(reportDays) - 1) * 86400000); void fetch(`/api/reports?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`).then((response) => response.json()).then((payload) => setReport(payload)).catch(() => setReport(null)); }, [reportDays]);
  const processes = Object.entries(cards.reduce<Record<string, number>>((accumulator, card) => { accumulator[card.processType] = (accumulator[card.processType] ?? 0) + 1; return accumulator; }, {})).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...processes.map(([, count]) => count));
  const statusCounts = { safe: 0, warning: 0, overdue: 0, paused: 0, completed: 0 };
  cards.forEach((card) => { statusCounts[card.slaStatus] += 1; });
  return (
    <div className="indicators-layout">
      <section className="hr-indicators-panel"><header><div><strong>Indicadores do Departamento Pessoal</strong><span>Turnover e custo da folha por competência.</span></div><b>{(report?.hrMetrics?.turnoverRate ?? 0).toFixed(2)}%</b></header><div className="hr-indicator-grid"><article><strong>{report?.hrMetrics?.turnoverRate?.toFixed(2) ?? "0,00"}%</strong><span>Turnover</span></article><article><strong>{report?.hrMetrics?.averageHeadcount ?? 0}</strong><span>Headcount médio</span></article><article><strong>{report?.hrMetrics?.admissions ?? 0}</strong><span>Admissões</span></article><article><strong>{report?.hrMetrics?.terminations ?? 0}</strong><span>Desligamentos</span></article><article><strong>{(report?.hrMetrics?.payrollCostTotal ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong><span>Custo da folha</span></article></div><div className="hr-indicator-note">{hrMetrics.length ? `${hrMetrics.length} competência(s) cadastrada(s) em ${companies.length} empresa(s).` : "Cadastre empresas e competências para calcular os indicadores."}</div></section>
      <section className="metrics-panel"><header><div><strong>Volume por processo</strong><span>{cards.length} demanda(s)</span></div><button className="export-button" onClick={onExport}>Exportar CSV</button></header><div className="process-bars">{processes.map(([process, count]) => <div key={process}><span>{process}</span><i><b style={{ width: `${(count / max) * 100}%` }} /></i><strong>{count}</strong></div>)}</div></section>
      <section className="sla-panel"><header><strong>Saúde dos SLAs</strong><span>Visão atual</span></header><div className="sla-donut" style={{ background: `conic-gradient(#23d8a1 0 ${(statusCounts.safe / Math.max(1, cards.length)) * 100}%, #f2a13e 0 ${((statusCounts.safe + statusCounts.warning) / Math.max(1, cards.length)) * 100}%, #ef5b5b 0 ${((statusCounts.safe + statusCounts.warning + statusCounts.overdue) / Math.max(1, cards.length)) * 100}%, #8b98a7 0 100%)` }}><span><strong>{cards.length - statusCounts.overdue}</strong><small>sob controle</small></span></div><ul><li><i className="safe" />No prazo <b>{statusCounts.safe}</b></li><li><i className="warning" />Atenção <b>{statusCounts.warning}</b></li><li><i className="overdue" />Atrasadas <b>{statusCounts.overdue}</b></li><li><i className="paused" />Pausadas/concluídas <b>{statusCounts.paused + statusCounts.completed}</b></li></ul></section>
      <section className="report-panel"><header><div><strong>Histórico e produtividade</strong><span>Indicadores calculados a partir da auditoria do workspace.</span></div><select value={reportDays} onChange={(event) => setReportDays(event.target.value)}><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option></select></header>{report && <div className="report-metrics"><article><strong>{report.total}</strong><span>Demandas no período</span></article><article><strong>{report.completionRate}%</strong><span>Taxa de conclusão</span></article><article><strong>{report.averageCompletionHours}h</strong><span>Tempo médio</span></article><article><strong>{report.activityCount}</strong><span>Eventos auditados</span></article></div>}<div className="report-process-list">{report && Object.entries(report.byProcess).sort((a, b) => b[1] - a[1]).map(([process, count]) => <span key={process}><b>{process}</b><i style={{ width: `${Math.max(8, (count / Math.max(1, report.total)) * 100)}%` }} /><em>{count}</em></span>)}</div></section>
      <section className="rules-panel"><header><div><strong>Automações nativas</strong><span>Gatilho → condição → ação</span></div><b>{rules.filter((rule) => rule.enabled).length} ativas</b></header><div>{rules.map((rule, index) => <article key={rule.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{rule.name}</strong><small>{rule.trigger.replaceAll(".", " ")}</small></div><label className="rule-switch"><input type="checkbox" checked={rule.enabled} disabled={busy || !canManageRules} onChange={(event) => void onToggleRule(rule.id, event.target.checked)} /><i /></label></article>)}</div></section>
    </div>
  );
}
