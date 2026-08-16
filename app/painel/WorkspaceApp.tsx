"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowRight,
  BarChart3,
  Bell,
  Blocks,
  Building2,
  Cable,
  Check,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  Download,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  MessageCircle,
  MessageSquareMore,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  AlertTriangle,
  UserRoundCog,
  Smartphone,
  Stethoscope,
  Sun,
  Timer,
  Trash2,
  Users,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";
import type { ActivityEvent, Card, CardAttachment, InboxItem, WorkspaceRole, WorkspaceSnapshot } from "@/lib/fila-dp-types";
import type { ActionTarget } from "@/lib/action-center";
import { formatWorkingMinutes } from "@/lib/fila-dp-sla";
import { competenceLabel, connectionStatusLabel, connectionTone, cycleProgress, cycleStages, lastSyncLabel } from "./features/shared";
import { RequestError, requestErrorFrom, supportReference } from "./request-error";
import { AssistantPanel } from "./features/assistant/AssistantPanel";
import { RegistrationsView } from "./features/registrations";
import { OperationsView } from "./features/operations";
import { AuxiliaryModulesView } from "./features/auxiliary";
import { IntegrationsView } from "./features/integrations";
import { PaymentsView } from "./features/payments";
import { TimeTrackingView } from "./features/time";
import { ActionCenter } from "./features/action-center";

type View = "overview" | "board" | "inbox" | "planner" | "processes" | "auxiliary" | "psychologistPayments" | "contractorPayments" | "timeTracking" | "integrations" | "registrations" | "payroll" | "indicators";
type BoardMode = "kanban" | "table" | "calendar" | "process";
type Theme = "light" | "dark";
type CardTab = "details" | "checklist" | "attachments" | "activity";
type SettingsSection = "general" | "companies" | "columns" | "team" | "security" | "fields" | "templates" | "sla" | "automations";
type RealtimeStatus = "syncing" | "current" | "delayed";
type User = { displayName: string; email: string; fullName: string | null };
type SearchResult = { id: string; title: string; company: string; processType: string; priority: string; slaStatus: string; dueAt: string | null; assigneeName: string; archived: boolean; listId: string };
type SearchRecord = { kind: string; id: string; title: string; subtitle: string; badge: string; target: ActionTarget | "registrations" };
type CatalogHandler = (payload: Record<string, unknown>, message: string) => Promise<WorkspaceSnapshot | null>;
type SnapshotMutation = (url: string, options: RequestInit, message?: string) => Promise<WorkspaceSnapshot | null>;
type ConfirmationRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => void | Promise<unknown>;
};
type ConfirmHandler = (request: ConfirmationRequest) => void;
type RecoveryLink = { name: string; url: string; expiresAt: string };
type AuthSession = { id: string; deviceLabel: string; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean };
type CardForm = {
  boardId: string;
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
  boardId: "",
  title: "",
  description: "",
  companyId: "",
  company: "",
  processType: "CONCILIAÇÃO CADASTRAL",
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
  "CONCILIAÇÃO CADASTRAL": "blue",
  "FÉRIAS": "purple",
  "BENEFÍCIOS": "green",
  "RESCISÃO": "orange",
  "CADASTRO": "gray",
  "FOLHA": "red",
  "OUTROS": "gray",
};

/**
 * Catálogo das telas do painel (§17, §18).
 *
 * Era três listas paralelas — cabeçalho, título curto para o assistente e
 * treze botões escritos à mão no menu — que ninguém obrigava a concordar.
 * Acrescentar uma tela significava lembrar de quatro lugares, e o quarto era o
 * pior: o botão de ação primária da barra superior aparecia por *negação*
 * (`view !== "registrations" && view !== "auxiliary" && …`), então uma tela
 * nova nascia com "Nova demanda" no topo até alguém notar.
 *
 * `section` é o que a §17 pede: o menu tinha um rótulo só, "OPERAÇÃO", sobre
 * treze itens — e Cadastros, Relatórios e Estado das integrações não são
 * operação. Rótulo que não descreve o que está embaixo é pior que nenhum.
 */
type NavSection = "operacao" | "pessoas" | "financeiro" | "dados";

const navSections: Array<{ id: NavSection; label: string }> = [
  { id: "operacao", label: "OPERAÇÃO" },
  { id: "pessoas", label: "PESSOAS E CADASTROS" },
  { id: "financeiro", label: "FINANCEIRO" },
  { id: "dados", label: "DADOS E ANÁLISE" },
];

type ViewEntry = {
  /** Título curto: menu lateral e contexto do assistente. */
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  section: NavSection;
  /** Rota do catálogo de módulos. Ausente = sempre disponível. */
  module?: string;
  /** Papéis que não veem a tela. A regra ficava repetida em sete botões. */
  hiddenFor?: WorkspaceRole[];
  /** Ação primária da barra superior. Ausente = a barra não oferece nenhuma:
   *  a tela tem os próprios comandos e um botão genérico ali criaria dois
   *  caminhos para a mesma coisa, ou um caminho para coisa nenhuma. */
  primaryAction?: { label: string; kind: "card" | "inbox" };
};

const viewCatalog: Record<View, ViewEntry> = {
  overview: {
    label: "Visão geral", icon: LayoutDashboard, section: "operacao",
    eyebrow: "VISÃO GERAL", title: "Visão geral",
    description: "Acompanhe o que exige ação e mantenha a operação sob controle.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  board: {
    label: "Demandas", icon: ListChecks, section: "operacao",
    eyebrow: "DEMANDAS", title: "Quadro de demandas",
    description: "Acompanhe prioridades, responsáveis e próximos passos.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  inbox: {
    label: "Inbox", icon: Inbox, section: "operacao", module: "inbox",
    eyebrow: "TRIAGEM MULTICANAL", title: "Caixa de entrada",
    description: "Transforme solicitações recebidas em demandas rastreáveis.",
    primaryAction: { label: "Nova solicitação", kind: "inbox" },
  },
  planner: {
    label: "Planner", icon: CalendarDays, section: "operacao", module: "planner",
    eyebrow: "AGENDA DO ANALISTA", title: "Meu planner",
    description: "Organize sua execução a partir dos prazos da operação.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  processes: {
    label: "Operação DP", icon: ClipboardCheck, section: "operacao", module: "processes",
    eyebrow: "OPERAÇÃO DO DP", title: "Cockpit de fechamento",
    description: "Coordene competências, gates, aprovações e obrigações. A admissão digital permanece integralmente na Sólides.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  auxiliary: {
    label: "Módulos auxiliares", icon: Blocks, section: "operacao", module: "auxiliary", hiddenFor: ["guest"],
    eyebrow: "SERVIÇOS DA COMPETÊNCIA", title: "Módulos auxiliares",
    description: "Controle entradas, aprovações, saídas e fechamento de Benefícios, Psicologia e Prestadores PJ.",
  },
  registrations: {
    label: "Cadastros", icon: Users, section: "pessoas", module: "registrations", hiddenFor: ["guest"],
    eyebrow: "BASE OPERACIONAL", title: "Cadastros",
    description: "Administre empresas, colaboradores e estruturas auxiliares em um só lugar.",
  },
  timeTracking: {
    label: "Ponto", icon: Timer, section: "pessoas", module: "timeTracking", hiddenFor: ["guest"],
    eyebrow: "CONFERÊNCIA OPERACIONAL", title: "Ponto",
    description: "Confira marcações, trate inconsistências e envie os eventos de hora para a folha com a rubrica configurada.",
  },
  payroll: {
    label: "Folha", icon: WalletCards, section: "financeiro", module: "payroll",
    eyebrow: "FOLHA E INDICADORES", title: "Folha de pagamento",
    description: "Registre a competência e acompanhe custos, headcount e turnover automaticamente.",
  },
  psychologistPayments: {
    label: "Pagamento de Psicólogos", icon: Stethoscope, section: "financeiro",
    module: "psychologistPayments", hiddenFor: ["guest", "observer"],
    eyebrow: "CONTROLE FINANCEIRO", title: "Pagamento de Psicólogos",
    description: "Apure as consultas válidas da competência e controle quanto pagar a cada psicólogo. O módulo é exclusivamente administrativo e financeiro.",
  },
  contractorPayments: {
    label: "Pagamentos PJ", icon: Receipt, section: "financeiro", module: "contractorPayments", hiddenFor: ["guest"],
    eyebrow: "CONTROLE DE PAGAMENTO", title: "Pagamentos PJ",
    description: "Apure o líquido devido, o valor esperado da nota fiscal e o complemento destinado ao meio configurado.",
  },
  indicators: {
    label: "Relatórios", icon: BarChart3, section: "dados", module: "indicators",
    eyebrow: "RELATÓRIOS", title: "Relatórios da operação",
    description: "Monitore SLAs, volume, produtividade e regras ativas do workspace.",
  },
  integrations: {
    label: "Estado das integrações", icon: Cable, section: "dados", module: "integrations", hiddenFor: ["guest"],
    eyebrow: "INFRAESTRUTURA OPERACIONAL", title: "Estado das integrações",
    description: "Acompanhe conexões e últimas execuções deste workspace. A administração fica na console global.",
  },
};

/** Ordem do menu. É a ordem de declaração do catálogo — mantê-las separadas
 *  criaria a quinta lista para desalinhar. */
const navOrder = Object.keys(viewCatalog) as View[];

/** Estados do ciclo de vida do workspace, para o seletor dizer por que um grupo
    não pode ser aberto em vez de apenas desabilitar o botão. */
const workspaceStatusLabels: Record<string, string> = {
  active: "Ativo", suspended: "Suspenso", canceled: "Cancelado", archived: "Arquivado",
};

const searchRecordLabels: Record<string, string> = {
  company: "Empresa", employee: "Colaborador", psychologist: "Psicólogo",
  contractor: "Prestador PJ", competence: "Competência", integration: "Integração",
};
const searchRecordColors: Record<string, string> = {
  company: "blue", employee: "green", psychologist: "purple",
  contractor: "orange", competence: "blue", integration: "gray",
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
  const payload = await response.json() as WorkspaceSnapshot & Record<string, unknown>;
  if (!response.ok) throw requestErrorFrom(response, payload);
  return normalizeWorkspaceSnapshot(payload);
}

function normalizeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const normalizeCard = (card: Card): Card => ({
    ...card,
    checklist: Array.isArray(card.checklist) ? card.checklist : [],
    comments: Array.isArray(card.comments) ? card.comments : [],
    activities: Array.isArray(card.activities) ? card.activities : [],
    assignees: Array.isArray(card.assignees) ? card.assignees : [],
    labels: Array.isArray(card.labels) ? card.labels : [],
    attachments: Array.isArray(card.attachments) ? card.attachments : [],
    customValues: card.customValues && typeof card.customValues === "object" && !Array.isArray(card.customValues) ? card.customValues : {},
  });

  return {
    ...snapshot,
    lists: Array.isArray(snapshot.lists) ? snapshot.lists.map((list) => ({ ...list, cards: Array.isArray(list.cards) ? list.cards.map(normalizeCard) : [] })) : [],
    archivedCards: Array.isArray(snapshot.archivedCards) ? snapshot.archivedCards.map(normalizeCard) : [],
    inbox: Array.isArray(snapshot.inbox) ? snapshot.inbox : [],
    rules: Array.isArray(snapshot.rules) ? snapshot.rules : [],
    members: Array.isArray(snapshot.members) ? snapshot.members.map((member) => ({ ...member, isActivated: member.isActivated !== false, companyIds: Array.isArray(member.companyIds) ? member.companyIds : [] })) : [],
    boards: Array.isArray(snapshot.boards) ? snapshot.boards.map((board) => ({ ...board, stages: Array.isArray(board.stages) ? board.stages : [] })) : [],
    availableWorkspaces: Array.isArray(snapshot.availableWorkspaces) ? snapshot.availableWorkspaces : [],
    labels: Array.isArray(snapshot.labels) ? snapshot.labels : [],
    customFields: Array.isArray(snapshot.customFields) ? snapshot.customFields : [],
    templates: Array.isArray(snapshot.templates) ? snapshot.templates : [],
    slaPolicies: Array.isArray(snapshot.slaPolicies) ? snapshot.slaPolicies : [],
    holidays: Array.isArray(snapshot.holidays) ? snapshot.holidays : [],
    notifications: Array.isArray(snapshot.notifications) ? snapshot.notifications : [],
    integrations: Array.isArray(snapshot.integrations) ? snapshot.integrations : [],
    plannerBlocks: Array.isArray(snapshot.plannerBlocks) ? snapshot.plannerBlocks : [],
    calendarConnections: Array.isArray(snapshot.calendarConnections) ? snapshot.calendarConnections : [],
    companies: Array.isArray(snapshot.companies) ? snapshot.companies.map((company) => ({ ...company, parentCompanyId: company.parentCompanyId ?? null, isPrincipal: Boolean(company.isPrincipal) })) : [],
    hrMetrics: Array.isArray(snapshot.hrMetrics) ? snapshot.hrMetrics.map((metric) => ({
      ...metric,
      headcount: Number(metric.headcount ?? 0),
      headcountStart: Number(metric.headcountStart ?? metric.headcount ?? 0),
      headcountEnd: Number(metric.headcountEnd ?? metric.headcount ?? 0),
      leavesCount: Number(metric.leavesCount ?? 0),
      admissions: Number(metric.admissions ?? 0),
      terminations: Number(metric.terminations ?? 0),
      voluntaryTerminations: Number(metric.voluntaryTerminations ?? 0),
      involuntaryTerminations: Number(metric.involuntaryTerminations ?? 0),
      baseSalary: Number(metric.baseSalary ?? 0),
      variablePay: Number(metric.variablePay ?? 0),
      overtimePay: Number(metric.overtimePay ?? 0),
      additionalPay: Number(metric.additionalPay ?? 0),
      vacationPay: Number(metric.vacationPay ?? 0),
      thirteenthPay: Number(metric.thirteenthPay ?? 0),
      terminationPay: Number(metric.terminationPay ?? 0),
      grossPayroll: Number(metric.grossPayroll ?? 0),
      employeeInss: Number(metric.employeeInss ?? 0),
      employeeIrrf: Number(metric.employeeIrrf ?? 0),
      employeeOtherDeductions: Number(metric.employeeOtherDeductions ?? 0),
      netPay: Number(metric.netPay ?? 0),
      employerInss: Number(metric.employerInss ?? 0),
      ratContribution: Number(metric.ratContribution ?? 0),
      thirdPartyContributions: Number(metric.thirdPartyContributions ?? 0),
      fgts: Number(metric.fgts ?? 0),
      fgtsPenalty: Number(metric.fgtsPenalty ?? 0),
      employerCharges: Number(metric.employerCharges ?? 0),
      benefitsCost: Number(metric.benefitsCost ?? 0),
      provisionsCost: Number(metric.provisionsCost ?? 0),
      otherCosts: Number(metric.otherCosts ?? 0),
      payrollCost: Number(metric.payrollCost ?? 0),
    })) : [],
    recentActivity: Array.isArray(snapshot.recentActivity) ? snapshot.recentActivity : [],
  };
}

function initials(value: string) {
  return String(value ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "DP";
}

function formatDate(value: string | null, long = false) {
  if (!value || typeof value !== "string") return "Sem prazo";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Sem prazo";
  return new Intl.DateTimeFormat("pt-BR", long ? { day: "2-digit", month: "long", year: "numeric" } : { day: "2-digit", month: "short" }).format(date);
}

function formatDue(value: string | null) {
  if (!value || typeof value !== "string") return "Sem prazo";
  if (!value.includes("T")) return formatDate(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDate(value);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function dueInputValue(value: string, defaultTime: string) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T${defaultTime}`;
  return value.slice(0, 16);
}

function formatReceived(value: string) {
  // Inbox items can come from SQLite as `YYYY-MM-DD HH:mm:ss`, from an API
  // as an ISO string, or briefly have no timestamp while a webhook is being
  // processed. Never render `NaN` when the value cannot be parsed.
  const raw = String(value ?? "").trim();
  if (!raw) return "agora";
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const date = new Date(normalized + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return "agora";
  const diffMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 60) return `há ${diffMinutes || 1} min`;
  if (diffMinutes < 1440) return `há ${Math.floor(diffMinutes / 60)} h`;
  return `há ${Math.floor(diffMinutes / 1440)} d`;
}

function realtimeCursor(date = new Date()) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function formatSyncStatus(updatedAt: Date | null, status: RealtimeStatus) {
  if (status === "syncing") return "Sincronizando painel";
  if (status === "delayed") return "Atualização temporariamente indisponível";
  if (!updatedAt) return "Atualizado automaticamente";
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt.getTime()) / 60000));
  return minutes < 1 ? "Atualizado agora" : `Atualizado há ${minutes} min`;
}

function slaLabel(card: Card) {
  if (card.slaStatus === "overdue") return `Atrasada • ${formatDue(card.dueAt)}`;
  if (card.slaStatus === "warning") return card.dueAt ? `Atenção • ${formatDue(card.dueAt)}` : "Atenção no SLA";
  if (card.slaStatus === "paused") return "SLA pausado";
  if (card.slaStatus === "completed") return "Concluída";
  return card.dueAt ? formatDue(card.dueAt) : "Sem prazo";
}

function compactSlaLabel(status: string, dueAt: string | null) {
  if (status === "overdue") return "Atrasada";
  if (status === "warning") return "Vence hoje";
  if (status === "paused") return "Pausada";
  if (status === "completed") return "Concluída";
  return dueAt ? formatDate(dueAt) : "Sem prazo";
}

function formatMoment(value: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return "agora";
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "agora";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
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

function activityDetails(activity: ActivityEvent) {
  const payload = activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload) ? activity.payload : {};
  if (activity.eventType === "card.moved") {
    return [`De ${String(payload.fromListName ?? "coluna anterior")} para ${String(payload.toListName ?? "nova coluna")}.`];
  }
  if (activity.eventType === "checklist.item_toggled") {
    const state = payload.completed ? "concluída" : "reaberta";
    return [payload.title ? `Etapa: ${String(payload.title)} (${state}).` : `Etapa ${state}.`];
  }
  if (activity.eventType === "attachment.uploaded" || activity.eventType === "attachment.deleted") {
    return payload.filename ? [`Arquivo: ${String(payload.filename)}.`] : [];
  }
  const changes = payload.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const labels: Record<string, string> = { title: "Título", description: "Descrição", company: "Empresa", processType: "Processo", priority: "Prioridade", assigneeName: "Responsável", dueAt: "Prazo", name: "Nome", slaBehavior: "Comportamento do SLA" };
  return Object.entries(changes).flatMap(([field, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const change = value as { from?: unknown; to?: unknown };
    if (change.from === undefined && change.to === undefined) return [];
    const from = String(change.from ?? "sem valor") || "sem valor";
    const to = String(change.to ?? "sem valor") || "sem valor";
    return [`${labels[field] ?? field}: ${from} → ${to}.`];
  });
}

function canPreviewAttachment(attachment: CardAttachment) {
  return attachment.contentType === "application/pdf" || attachment.contentType.startsWith("image/");
}

export function WorkspaceApp({ user, signOutPath }: { user: User; signOutPath: string }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<View>("overview");
  const [boardMode, setBoardMode] = useState<BoardMode>("kanban");
  const [cardTab, setCardTab] = useState<CardTab>("details");
  /**
   * O modal de configurações é o de segurança, e só (§35).
   *
   * O painel foi restringido ao fluxo operacional em `d2d8d5a`, e o menu de
   * configurações perdeu oito entradas. O estado inicial ficou em "general" —
   * uma seção que nenhum caminho consegue abrir: o único botão que abre o modal
   * chama `openSecuritySettings`, que fixa "security". Um estado inicial que a
   * tela não consegue mostrar é um convite a bug: bastaria alguém abrir o modal
   * por outro caminho para a pessoa ver um painel com um menu que não o aponta.
   */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("security");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [startupFailure, setStartupFailure] = useState<unknown>(null);
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
  const [companyFilter, setCompanyFilter] = useState("all");
  const [processFilter, setProcessFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState("all");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberRole, setMemberRole] = useState<WorkspaceRole>("member");
  const [memberCompanyIds, setMemberCompanyIds] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchRecords, setSearchRecords] = useState<SearchRecord[]>([]);
  const searchPanelRef = useRef<HTMLElement>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<CardAttachment | null>(null);
  const [recoveryLink, setRecoveryLink] = useState<RecoveryLink | null>(null);
  const [authSessions, setAuthSessions] = useState<AuthSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardDescription, setNewBoardDescription] = useState("");
  const [theme, setTheme] = useState<Theme>("light");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [assistantSignal, setAssistantSignal] = useState(0);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("syncing");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const sidebarPreferenceLoaded = useRef(false);
  const realtimeCursorRef = useRef("");
  const touchCardMoveRef = useRef<{ cardId: string; x: number; y: number } | null>(null);
  const suppressCardOpenRef = useRef<string | null>(null);

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
      .then((next) => {
        setSnapshot(next);
        setLastUpdatedAt(new Date());
        setRealtimeStatus("current");
        realtimeCursorRef.current = realtimeCursor();
      })
      .catch((cause: unknown) => {
        // O erro inteiro é guardado: a tela de falha precisa do código e do
        // número de chamado para o usuário conseguir reportar o que aconteceu.
        setStartupFailure(cause);
        setError(cause instanceof Error ? cause.message : "Erro ao carregar o workspace.");
      })
      .finally(() => setLoading(false));
  }, []);

  const activeWorkspaceId = snapshot?.workspace.id;
  const configuredRealtimeSeconds = snapshot?.settings.realtimeSeconds ?? 30;

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const seconds = configuredRealtimeSeconds;
    let checking = false;
    let cancelled = false;
    const checkForUpdates = async () => {
      if (checking || cancelled || document.visibilityState !== "visible" || busy) return;
      checking = true;
      try {
        const cursor = realtimeCursorRef.current || realtimeCursor();
        const response = await fetch(`/api/realtime?since=${encodeURIComponent(cursor)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Não foi possível verificar as atualizações.");
        const payload = await response.json() as { changed?: boolean; latestAt?: string };
        if (payload.changed) {
          const next = await requestSnapshot("/api/workspace");
          if (!cancelled) {
            setSnapshot(next);
            setLastUpdatedAt(new Date());
          }
        }
        if (payload.latestAt) realtimeCursorRef.current = payload.latestAt;
        if (!cancelled) setRealtimeStatus("current");
      } catch {
        if (!cancelled) setRealtimeStatus("delayed");
      } finally {
        checking = false;
      }
    };
    const interval = window.setInterval(() => { void checkForUpdates(); }, Math.max(5, seconds) * 1000);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void checkForUpdates(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeWorkspaceId, configuredRealtimeSeconds, busy]);

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

  // A paleta de busca é um diálogo modal: Esc fecha, Tab fica preso dentro dela
  // e o foco volta para onde estava. O rótulo ESC do cabeçalho precisa funcionar.
  useEffect(() => {
    if (!searchOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = searchPanelRef.current;
    const selector = "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(selector) ?? []).filter((item) => item.getClientRects().length > 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setSearchOpen(false); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel?.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !panel?.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      void fetch(`/api/search?${params}`)
        .then((response) => response.json())
        .then((payload: { results?: SearchResult[]; records?: SearchRecord[] }) => {
          setSearchResults(payload.results ?? []);
          setSearchRecords(payload.records ?? []);
        })
        .catch(() => { setSearchResults([]); setSearchRecords([]); });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!cardModalOpen && !inboxModalOpen && !workspaceModalOpen && !searchOpen && !notificationsOpen && !archiveOpen && !confirmation && !attachmentPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCardModalOpen(false);
        setInboxModalOpen(false);
        setWorkspaceModalOpen(false);
        setSearchOpen(false);
        setNotificationsOpen(false);
        setArchiveOpen(false);
        setConfirmation(null);
        setAttachmentPreview(null);
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [cardModalOpen, inboxModalOpen, workspaceModalOpen, searchOpen, notificationsOpen, archiveOpen, confirmation, attachmentPreview]);

  const activeCards = useMemo(() => snapshot?.lists.flatMap((list) => list.cards) ?? [], [snapshot]);
  /**
   * Recorte da empresa escolhida na barra superior (§18, §19).
   *
   * Só o quadro respeitava o seletor; a visão geral somava o grupo inteiro.
   * Escolher uma empresa não mexia em número nenhum, e quem escolhia não tinha
   * como saber se aquela empresa não tinha nada ou se o filtro era enfeite.
   *
   * Isto é diferente de `filteredActiveCards`, que aplica também responsável,
   * SLA, processo e prazo — filtros do quadro, que não valem para a visão geral.
   */
  const scopedCards = useMemo(
    () => companyFilter === "all" ? activeCards : activeCards.filter((card) => card.companyId === companyFilter),
    [activeCards, companyFilter],
  );
  const scopedLists = useMemo(() => (snapshot?.lists ?? []).map((list) => companyFilter === "all"
    ? list
    : { ...list, cards: list.cards.filter((card) => card.companyId === companyFilter) }), [snapshot?.lists, companyFilter]);
  /* O fluxo da competência respeita o seletor de empresa, como todo o resto da
     Visão geral desde `db5300b`. Com uma empresa escolhida, o ciclo mostrado é
     o dela; sem, é o do grupo, e o avanço é o do ciclo menos adiantado. */
  const scopedCycles = useMemo(() => (snapshot?.payrollCycles ?? [])
    .filter((cycle) => companyFilter === "all" || cycle.companyId === companyFilter),
  [snapshot?.payrollCycles, companyFilter]);
  const allCards = useMemo(() => [...activeCards, ...(snapshot?.archivedCards ?? [])], [activeCards, snapshot?.archivedCards]);
  const filteredActiveCards = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
    const weekEnd = todayStart + 7 * 24 * 60 * 60 * 1000;
    return activeCards.filter((card) => {
      const dueAt = card.dueAt ? new Date(card.dueAt).getTime() : Number.NaN;
      const dueMatches = dueFilter === "all" ||
        (dueFilter === "today" && dueAt >= todayStart && dueAt < tomorrowStart) ||
        (dueFilter === "week" && dueAt >= todayStart && dueAt < weekEnd) ||
        (dueFilter === "overdue" && card.slaStatus === "overdue");
      return (assigneeFilter === "all" || card.assigneeName === assigneeFilter || card.assignees.some((assignee) => assignee.name === assigneeFilter)) &&
        (slaFilter === "all" || card.slaStatus === slaFilter) &&
        (companyFilter === "all" || card.companyId === companyFilter) &&
        (processFilter === "all" || card.processType === processFilter) &&
        dueMatches;
    });
  }, [activeCards, assigneeFilter, companyFilter, dueFilter, processFilter, slaFilter]);
  const selectedCard = useMemo(() => allCards.find((card) => card.id === selectedCardId) ?? null, [allCards, selectedCardId]);
  const assignees = useMemo(() => Array.from(new Set(activeCards.flatMap((card) => card.assignees.length ? card.assignees.map((assignee) => assignee.name) : [card.assigneeName]).filter(Boolean))).sort(), [activeCards]);
  const processTypes = useMemo(() => Array.from(new Set(activeCards.map((card) => card.processType).filter(Boolean))).sort(), [activeCards]);
  const workspaceInitials = initials(snapshot?.workspace.name ?? "Synex DP");
  const userInitials = initials(user.displayName);
  const canEdit = snapshot ? ["admin", "member"].includes(snapshot.workspace.role) : false;
  const canComment = snapshot ? ["admin", "member", "guest"].includes(snapshot.workspace.role) : false;
  const isAdmin = snapshot?.workspace.role === "admin";
  // O menu reflete o plano contratado: um módulo fora do plano não vira botão.
  // A proteção real continua no servidor; isto evita oferecer o que não existe.
  const enabledModules = useMemo(
    () => new Set((snapshot?.modules ?? []).filter((item) => item.allowed).map((item) => item.route)),
    [snapshot?.modules],
  );
  const hasModule = useCallback((route: string) => enabledModules.size === 0 || enabledModules.has(route), [enabledModules]);
  const currentMemberName = snapshot?.members.find((member) => member.email.toLowerCase() === user.email.toLowerCase())?.name ?? user.displayName;

  // Quais telas esta pessoa vê, uma vez só. Antes a mesma pergunta estava
  // escrita em treze botões — `hasModule("x") && role !== "guest" &&` — e as
  // sete cópias da regra de papel eram sete chances de divergirem.
  const role = snapshot?.workspace.role;
  const visibleViews = useMemo(() => navOrder.filter((id) => {
    const entry = viewCatalog[id];
    if (entry.module && !hasModule(entry.module)) return false;
    return !(role && entry.hiddenFor?.includes(role));
  }), [hasModule, role]);

  const navBadges = useMemo<Partial<Record<View, number>>>(() => ({
    inbox: snapshot?.inbox.filter((item) => item.status === "new").length || undefined,
  }), [snapshot]);

  const stats = useMemo(() => {
    const active = scopedCards.filter((card) => card.slaStatus !== "completed");
    const waitingListIds = new Set(snapshot?.lists.filter((list) => list.slaBehavior === "paused").map((list) => list.id) ?? []);
    const completed = scopedCards.filter((card) => card.slaStatus === "completed").length;
    return {
      active: active.length,
      attention: active.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length,
      waiting: active.filter((card) => waitingListIds.has(card.listId)).length,
      onTime: scopedCards.length ? Math.round(((scopedCards.length - scopedCards.filter((card) => card.slaStatus === "overdue").length) / scopedCards.length) * 100) : 100,
      completed,
      documentsPending: active.reduce((total, card) => total + card.checklist.filter((item) => !item.completed).length, 0),
      activeCompanies: snapshot?.companies.filter((company) => company.status === "active").length ?? 0,
    };
  }, [scopedCards, snapshot]);

  function applySnapshot(next: WorkspaceSnapshot, message?: string) {
    setSnapshot(next);
    setLastUpdatedAt(new Date());
    setRealtimeStatus("current");
    realtimeCursorRef.current = realtimeCursor();
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

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(signOutPath, { method: "POST" });
      const payload = await response.json() as { redirectTo?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível encerrar a sessão.");
      window.location.assign(payload.redirectTo || "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível encerrar a sessão.");
      setBusy(false);
    }
  }

  function requestConfirmation(request: ConfirmationRequest) {
    setConfirmation(request);
  }

  async function confirmPendingAction() {
    const action = confirmation?.action;
    setConfirmation(null);
    if (!action) return;
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
    }
  }

  function openNewCard() {
    if (!canEdit) return;
    setSelectedCardId(null);
    setCardForm({ ...emptyCardForm, boardId: snapshot?.board.id ?? "" });
    setNewChecklistItem("");
    setCardTab("details");
    setCardModalOpen(true);
  }

  function openFromTemplate(templateId: string) {
    const template = snapshot?.templates.find((item) => item.id === templateId);
    if (!template) return openNewCard();
    setSelectedCardId(null);
    setCardForm({ ...emptyCardForm, boardId: snapshot?.board.id ?? "", templateId, processType: template.processType, description: template.description });
    setCardTab("details");
    setCardModalOpen(true);
  }

  function openCard(card: Card) {
    setSelectedCardId(card.id);
    setCardForm({
      boardId: card.boardId,
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

  function moveCardByDirection(cardId: string, direction: -1 | 1) {
    const card = allCards.find((item) => item.id === cardId);
    if (!card || !snapshot) return;
    const orderedLists = [...snapshot.lists].sort((a, b) => a.position - b.position);
    const currentIndex = orderedLists.findIndex((list) => list.id === card.listId);
    const nextList = orderedLists[currentIndex + direction];
    if (!nextList) {
      setToast(direction < 0 ? "Esta demanda já está na primeira coluna." : "Esta demanda já está na última coluna.");
      return;
    }
    void moveCard(cardId, nextList.id);
  }

  function completeSelectedCard() {
    if (!selectedCard) return;
    const completedList = snapshot?.lists.find((list) => list.slaBehavior === "completed");
    if (!completedList) {
      setError("Crie ou configure uma coluna com SLA concluído antes de finalizar esta demanda.");
      return;
    }
    requestConfirmation({
      title: "Concluir demanda?",
      description: "A demanda será movida para a coluna concluída e o SLA será encerrado. Essa ação ficará registrada no histórico.",
      confirmLabel: "Concluir demanda",
      action: () => moveCard(selectedCard.id, completedList.id),
    });
  }

  function focusCardField(fieldId: string, tab: CardTab = "details") {
    setCardTab(tab);
    window.setTimeout(() => document.getElementById(fieldId)?.focus(), 0);
  }

  function archiveCard() {
    if (!selectedCardId) return;
    const cardId = selectedCardId;
    requestConfirmation({
      title: "Arquivar demanda?",
      description: "Ela sairá do quadro, mas poderá ser restaurada posteriormente.",
      confirmLabel: "Arquivar demanda",
      action: async () => {
        const next = await mutate(`/api/cards/${cardId}`, { method: "DELETE" }, "Demanda arquivada.");
        if (next) setCardModalOpen(false);
      },
    });
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

  function deleteComment(commentId: string) {
    if (!selectedCardId) return;
    const cardId = selectedCardId;
    requestConfirmation({
      title: "Excluir comentário?",
      description: "Este comentário será removido do histórico da demanda.",
      confirmLabel: "Excluir comentário",
      action: () => mutate(`/api/cards/${cardId}/comments?commentId=${encodeURIComponent(commentId)}`, { method: "DELETE" }, "Comentário excluído."),
    });
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

  async function loadAuthSessions() {
    setSessionsLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/sessions", { cache: "no-store" });
      const payload = await response.json() as { sessions?: AuthSession[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível carregar as sessões.");
      setAuthSessions(payload.sessions ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar as sessões.");
    } finally {
      setSessionsLoading(false);
    }
  }

  function openSecuritySettings() {
    setSettingsSection("security");
    openWorkspaceSettings();
    void loadAuthSessions();
  }

  async function revokeAuthSessions(target: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(target, { method: "DELETE" });
      const payload = await response.json() as { signedOut?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível revogar a sessão.");
      if (payload.signedOut) {
        window.location.assign("/login");
        return;
      }
      await loadAuthSessions();
      setToast("Sessões atualizadas.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível revogar a sessão.");
    } finally {
      setBusy(false);
    }
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
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: memberEmail, name: memberName, role: memberRole, companyIds: memberCompanyIds }) });
      const payload = await response.json() as { error?: string; snapshot?: WorkspaceSnapshot; activation?: { url: string; expiresAt: string; name: string } | null };
      if (!response.ok || !payload.snapshot) throw new Error(payload.error || "Não foi possível criar o usuário.");
      applySnapshot(normalizeWorkspaceSnapshot(payload.snapshot), payload.activation ? "Usuário criado. Compartilhe o link de ativação somente com a pessoa indicada." : "Acesso da equipe atualizado.");
      if (payload.activation) setRecoveryLink(payload.activation);
      setMemberEmail("");
      setMemberName("");
      setMemberRole("member");
      setMemberCompanyIds([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível criar o usuário.");
    } finally { setBusy(false); }
  }

  async function updateMemberRole(userId: string, role: WorkspaceRole) {
    await mutate(`/api/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }, "Papel de acesso atualizado.");
  }

  async function updateMemberCompanies(userId: string, companyIds: string[]) {
    await mutate(`/api/members/${userId}`, { method: "PATCH", body: JSON.stringify({ companyIds }) }, "Empresas liberadas para a pessoa.");
  }

  async function generateRecoveryLink(userId: string, name: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/members/${userId}/recovery`, { method: "POST" });
      const payload = await response.json() as { error?: string; snapshot?: WorkspaceSnapshot; recoveryUrl?: string; expiresAt?: string; memberName?: string };
      if (!response.ok || !payload.snapshot || !payload.recoveryUrl || !payload.expiresAt) throw new Error(payload.error || "Não foi possível gerar o link de recuperação.");
      applySnapshot(payload.snapshot, "Link de recuperação criado. Compartilhe-o somente com a pessoa indicada.");
      setRecoveryLink({ name: payload.memberName || name, url: payload.recoveryUrl, expiresAt: payload.expiresAt });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerar o link de recuperação.");
    } finally { setBusy(false); }
  }

  function removeMember(userId: string, name: string) {
    requestConfirmation({
      title: "Remover acesso?",
      description: `${name} deixará de acessar este workspace.`,
      confirmLabel: "Remover acesso",
      action: () => mutate(`/api/members/${userId}`, { method: "DELETE" }, "Membro removido do workspace."),
    });
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

  function removeAttachment(id: string) {
    requestConfirmation({
      title: "Excluir anexo?",
      description: "O arquivo será removido permanentemente desta demanda.",
      confirmLabel: "Excluir anexo",
      action: () => mutate(`/api/attachments/${id}`, { method: "DELETE" }, "Anexo removido."),
    });
  }

  async function restoreCard(id: string) {
    await mutate(`/api/cards/${id}/restore`, { method: "POST" }, "Demanda restaurada para o quadro.");
  }

  function deleteCardPermanently(id: string, title: string) {
    requestConfirmation({
      title: "Excluir definitivamente?",
      description: `“${title}” será excluída e não poderá ser restaurada.`,
      confirmLabel: "Excluir definitivamente",
      action: () => mutate(`/api/cards/${id}/permanent`, { method: "DELETE" }, "Demanda excluída permanentemente."),
    });
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

  function deleteCompany(id: string, name: string) {
    requestConfirmation({
      title: "Excluir empresa?",
      description: `O cadastro de ${name} será removido da operação. Demandas antigas manterão o histórico já registrado.`,
      confirmLabel: "Excluir empresa",
      action: () => mutate(`/api/companies/${id}`, { method: "DELETE" }, "Empresa excluída."),
    });
  }

  async function saveHrMetric(payload: Record<string, unknown>) {
    return mutate("/api/hr-metrics", { method: "POST", body: JSON.stringify(payload) }, "Indicadores da folha atualizados.");
  }

  function openSearchRecord(record: SearchRecord) {
    setSearchOpen(false);
    setView(record.target as View);
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
    // O arquivo segue o recorte da barra superior (§34).
    //
    // Este era o pior dos dois casos do filtro ignorado: a tela mostrando o
    // grupo inteiro é confuso; um CSV com o grupo inteiro, baixado logo depois
    // de escolher uma empresa, sai daqui parecendo ser daquela empresa e vai
    // para a mão de alguém.
    const rows = [["Demanda", "Processo", "Empresa", "Responsáveis", "Prazo", "SLA", "Status"], ...scopedCards.map((card) => [card.title, card.processType, card.company, card.assignees.map((item) => item.name).join("; ") || card.assigneeName, card.dueAt ?? "", card.slaStatus, snapshot?.lists.find((list) => list.id === card.listId)?.name ?? ""])];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    // O nome do arquivo carrega o recorte: quem tem cinco exportações na pasta
    // de downloads precisa distinguir uma da outra sem abrir.
    const empresa = companyFilter === "all" ? "grupo" : (snapshot?.companies.find((item) => item.id === companyFilter)?.tradeName
      || snapshot?.companies.find((item) => item.id === companyFilter)?.legalName || companyFilter);
    const sufixo = String(empresa).normalize("NFD").replace(/[\u0300-\u036f]/gu, "").replace(/[^a-zA-Z0-9]+/gu, "-").toLowerCase().slice(0, 40);
    link.download = `vinculato-demandas-${sufixo}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  if (loading) {
    return <main className="workspace-loading"><VinculatoLogo size={30} tone="light" /><p>Preparando sua operação…</p></main>;
  }

  if (!snapshot) {
    const infrastructure = startupFailure instanceof RequestError && startupFailure.isInfrastructure;
    const reference = supportReference(startupFailure);
    return (
      <main className="workspace-loading error-state" role="alert">
        <strong>{infrastructure ? "O Vinculato está indisponível no momento." : "Não foi possível abrir o Vinculato."}</strong>
        <p>{error}</p>
        {infrastructure && <p className="error-state-hint">Não é um problema da sua conta nem dos seus dados. O acesso volta assim que a plataforma for regularizada.</p>}
        {reference && <p className="error-state-reference">Informe ao suporte: {reference}</p>}
        <button onClick={() => window.location.reload()}>Tentar novamente</button>
      </main>
    );
  }

  const header = viewCatalog[view];
  const primaryAction = header.primaryAction;
  const today = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "short", year: "numeric" }).format(new Date());
  const principalCompany = snapshot.companies.find((company) => company.isPrincipal) ?? null;
  const companyScopeLabel = snapshot.workspace.companyScope === "restricted" ? "Empresas autorizadas" : "Todas do grupo";

  return (
    <main className={`dashboard-shell theme-${theme}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="dashboard-sidebar">
        <button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((current) => !current)} aria-label={sidebarCollapsed ? "Abrir menu lateral" : "Recolher menu lateral"} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? "Abrir menu" : "Recolher menu"}>
          {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </button>
        <button className="brand dashboard-brand" onClick={() => setView("overview")} aria-label="Vinculato — visão geral">
          {/* A barra lateral virou clara: o logotipo branco sumiria nela. A
              variante segue o tema, em vez de assumir fundo escuro. */}
          <VinculatoLogo size={28} tone={theme === "dark" ? "light" : "color"} />
        </button>
        <div className="sidebar-group-context">
          <span>GRUPO OPERACIONAL</span>
          <strong>{snapshot.workspace.name}</strong>
          <small>{principalCompany ? `Principal: ${principalCompany.tradeName || principalCompany.legalName}` : "Defina a empresa principal"}</small>
        </div>
        <nav aria-label="Navegação do painel">
          {/* Seção sem item visível não é renderizada: um rótulo sozinho diz
              que existe algo ali e não há. */}
          {navSections.map((section) => {
            const items = visibleViews.filter((id) => viewCatalog[id].section === section.id);
            if (!items.length) return null;
            return <div key={section.id} className="sidebar-nav-group">
              <span className="sidebar-nav-section">{section.label}</span>
              {items.map((id) => {
                const entry = viewCatalog[id];
                const Icon = entry.icon;
                const badge = navBadges[id];
                return <button key={id} type="button" title={entry.label} className={view === id ? "active" : ""}
                  onClick={() => setView(id)} aria-current={view === id ? "page" : undefined}>
                  <span aria-hidden="true"><Icon /></span> {entry.label}
                  {badge ? <b>{badge}</b> : null}
                </button>;
              })}
            </div>;
          })}
        </nav>
        {snapshot.availableWorkspaces.length > 1 && (
          <div className="sidebar-workspace sidebar-workspace-switcher">
            <span>GRUPO ATUAL</span>
            {/* `details` nativo: teclado e leitor de tela funcionam sem estado
                extra. Trocar de grupo é troca de contexto, não de identidade —
                por isso fica aqui e não junto de "entrar em outra conta". */}
            <details>
              <summary>
                <i>{workspaceInitials}</i>
                <span><strong>{snapshot.workspace.name}</strong><small>{roleLabels[snapshot.workspace.role]}</small></span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <ul>
                {snapshot.availableWorkspaces.map((item) => (
                  <li key={item.id}>
                    <button type="button" disabled={busy || item.id === snapshot.workspace.id || !item.operational}
                      aria-current={item.id === snapshot.workspace.id ? "true" : undefined}
                      onClick={() => void switchWorkspace(item.id)}>
                      <i>{initials(item.name)}</i>
                      <span>
                        <strong>{item.name}</strong>
                        <small>{roleLabels[item.role]}{item.operational ? "" : ` · ${workspaceStatusLabels[item.status] ?? item.status}`}</small>
                      </span>
                      {item.id === snapshot.workspace.id && <b>Atual</b>}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <div className="sidebar-workspace">
          <span>ESTRUTURA EMPRESARIAL</span>
          <div className="sidebar-structure-summary"><i>{workspaceInitials}</i><span><strong>{principalCompany?.tradeName || principalCompany?.legalName || "Sem principal"}</strong><small>{snapshot.companies.length} empresa(s) no grupo</small></span></div>
        </div>
        <div className="sidebar-account">
          <span className="user-avatar">{userInitials}</span>
          <span><strong>{user.displayName}</strong><small>{user.email}</small></span>
          <div className="sidebar-account-actions">
            {/* Dois comandos distintos: sair encerra e volta ao site; trocar de
                conta encerra e já abre a autenticação de outra identidade. */}
            <form method="post" action="/api/auth/logout">
              <input type="hidden" name="trocar" value="1" />
              <button type="submit" className="switch-account-button"
                aria-label="Entrar em outra conta" title="Entrar em outra conta"><UserRoundCog aria-hidden="true" /></button>
            </form>
            <button type="button" className="sign-out-button" disabled={busy} onClick={() => void signOut()} aria-label="Sair do Vinculato" title="Sair"><LogOut aria-hidden="true" /></button>
          </div>
        </div>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div className="dashboard-location"><span>{snapshot.workspace.name} /</span><strong> {header.title}</strong></div>
          <div className="dashboard-header-actions">
            <label className="header-company-select"><Building2 aria-hidden="true" /><select aria-label="Selecionar empresa" value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)}><option value="all">{companyScopeLabel}</option>{snapshot.companies.filter((company) => company.status === "active").map((company) => <option value={company.id} key={company.id}>{company.isPrincipal ? "★ " : "↳ "}{company.tradeName || company.legalName}</option>)}</select></label>
            <button className="global-search-trigger" aria-label="Busca global" title="Busca global" onClick={() => setSearchOpen(true)}><Search aria-hidden="true" /><span>Buscar demanda, empresa ou CNPJ</span><kbd>⌘ K</kbd></button>
            <button aria-label="Notificações" title="Notificações" onClick={() => setNotificationsOpen(true)}><Bell aria-hidden="true" />{snapshot.notifications.some((item) => !item.readAt) && <i />}</button>
            <button className="help-button" aria-label="Abrir o assistente" title="Ajuda" onClick={() => setAssistantSignal((current) => current + 1)}><CircleHelp aria-hidden="true" /></button>
            <button className="theme-toggle" aria-label={theme === "dark" ? "Ativar modo claro" : "Ativar modo noturno"} aria-pressed={theme === "dark"} title={theme === "dark" ? "Modo claro" : "Modo noturno"} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</button>
            <button className="header-profile" aria-label="Abrir perfil e segurança" title="Perfil e segurança" onClick={openSecuritySettings}><span>{userInitials}</span></button>
            {/* A ação primária vem do catálogo, não de uma lista de exceções.
                A versão anterior aparecia por negação — seis `view !== "…"` —,
                então uma tela nova nascia com "Nova demanda" no topo mesmo sem
                ter demanda nenhuma para criar. */}
            {canEdit && primaryAction && <button className="new-demand"
              onClick={primaryAction.kind === "inbox" ? () => setInboxModalOpen(true) : openNewCard}>
              <Plus aria-hidden="true" /><span>{primaryAction.label}</span>
            </button>}
          </div>
        </header>

        <div className="dashboard-content">
          {/* O contexto pode ter mudado sozinho porque o grupo anterior saiu do
              ar. Trocar em silêncio faria a pessoa achar que perdeu dados. */}
          {snapshot.switchedFrom && (
            <p className="workspace-switched-notice" role="status">
              <AlertTriangle aria-hidden="true" />
              <span>
                <strong>{snapshot.switchedFrom.name}</strong> está {(workspaceStatusLabels[snapshot.switchedFrom.status] ?? snapshot.switchedFrom.status).toLowerCase()} e não pode ser aberto.
                Você está trabalhando em <strong>{snapshot.workspace.name}</strong>.
              </span>
            </p>
          )}
          {/* `key={view}` faz o React remontar este bloco a cada troca de
              módulo, o que reinicia a animação de entrada. Sem a chave, a
              transição só rodaria na primeira vez. */}
          <div className="view-transition" key={view}>
          <div className="dashboard-heading">
            <div><span className="dashboard-eyebrow">{header.eyebrow}</span><h1>{view === "overview" ? `Olá, ${user.displayName.split(" ")[0] || "equipe"}.` : header.title}</h1><p>{view === "overview" ? "Veja as prioridades da operação e avance com segurança." : header.description}</p><div className={`dashboard-sync-status ${realtimeStatus}`} aria-live="polite"><RefreshCw aria-hidden="true" /><span>{formatSyncStatus(lastUpdatedAt, realtimeStatus)}</span></div></div>
            <div className="dashboard-date"><span>HOJE</span><strong>{today}</strong></div>
          </div>

          {view === "overview" && <OverviewView cycles={scopedCycles} integrations={snapshot.integrations} onNavigate={(target) => setView(target)} cards={scopedCards} companies={snapshot.companies} lists={scopedLists} activities={snapshot.recentActivity} stats={stats} onOpen={openCard} onOpenBoard={() => setView("board")} onNew={openNewCard} canEdit={canEdit} companyId={companyFilter === "all" ? "" : companyFilter} scopeLabel={companyFilter === "all" ? companyScopeLabel : (snapshot.companies.find((company) => company.id === companyFilter)?.tradeName || snapshot.companies.find((company) => company.id === companyFilter)?.legalName || "Empresa selecionada")} />}

          {view === "processes" && <OperationsView role={snapshot.workspace.role} />}

          {view === "auxiliary" && <AuxiliaryModulesView role={snapshot.workspace.role} />}

          {view === "psychologistPayments" && <PaymentsView role={snapshot.workspace.role} module="psychology" />}

          {view === "contractorPayments" && <PaymentsView role={snapshot.workspace.role} module="contractors" />}

          {view === "timeTracking" && <TimeTrackingView role={snapshot.workspace.role} />}

          {view === "integrations" && <IntegrationsView role={snapshot.workspace.role} />}

          {view === "registrations" && <RegistrationsView role={snapshot.workspace.role} />}

          {view === "board" && (
            <>
              <div className="dashboard-stats">
                <article><span>Demandas ativas</span><strong>{stats.active}</strong><small>{stats.completed} concluída(s)</small></article>
                <article><span>Exigem atenção</span><strong>{stats.attention}</strong><small className="warning-text">SLA hoje ou atrasado</small></article>
                <article><span>Aguardando terceiros</span><strong>{stats.waiting}</strong><small>SLA pausado</small></article>
                <article><span>Dentro do prazo</span><strong>{stats.onTime}%</strong><small className="safe-text">Visão atual</small></article>
              </div>

              <div className="dashboard-board-head">
                <div className="dashboard-tabs board-mode-tabs"><label className="board-selector"><span>Quadro</span><select value={snapshot.board.id} onChange={(event) => void switchBoard(event.target.value)} aria-label="Selecionar quadro">{snapshot.boards.map((board) => <option value={board.id} key={board.id}>{board.name}</option>)}</select></label><button className={boardMode === "kanban" ? "active" : ""} onClick={() => setBoardMode("kanban")}>Kanban</button><button className={boardMode === "table" ? "active" : ""} onClick={() => setBoardMode("table")}>Tabela</button><button className={boardMode === "calendar" ? "active" : ""} onClick={() => setBoardMode("calendar")}>Calendário</button><button className={boardMode === "process" ? "active" : ""} onClick={() => setBoardMode("process")}>Processos</button><button className="archive-trigger" onClick={() => setArchiveOpen(true)}><Archive aria-hidden="true" /> Arquivados <b>{snapshot.archivedCards.length}</b></button></div>
                <div className="dashboard-filters">
                  <button type="button" className={`filter-chip ${assigneeFilter === currentMemberName ? "active" : ""}`} aria-pressed={assigneeFilter === currentMemberName} onClick={() => setAssigneeFilter((current) => current === currentMemberName ? "all" : currentMemberName)}>Minhas</button>
                  <button type="button" className={`filter-chip ${slaFilter === "overdue" ? "active" : ""}`} aria-pressed={slaFilter === "overdue"} onClick={() => setSlaFilter((current) => current === "overdue" ? "all" : "overdue")}>Atrasadas</button>
                  <button type="button" className={`filter-chip ${slaFilter === "warning" ? "active" : ""}`} aria-pressed={slaFilter === "warning"} onClick={() => setSlaFilter((current) => current === "warning" ? "all" : "warning")}>Hoje</button>
                  <label><span>Responsável</span><select aria-label="Filtrar por responsável" value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}><option value="all">Todos</option>{assignees.map((assignee) => <option key={assignee}>{assignee}</option>)}</select></label>
                  <label><span>Empresa</span><select aria-label="Filtrar por empresa" value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)}><option value="all">Todas</option>{snapshot.companies.map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
                  <label><span>Tipo</span><select aria-label="Filtrar por tipo de demanda" value={processFilter} onChange={(event) => setProcessFilter(event.target.value)}><option value="all">Todos</option>{processTypes.map((process) => <option key={process}>{process}</option>)}</select></label>
                  <label><span>Prazo</span><select aria-label="Filtrar por prazo" value={dueFilter} onChange={(event) => setDueFilter(event.target.value)}><option value="all">Todos</option><option value="today">Vence hoje</option><option value="week">Próximos 7 dias</option><option value="overdue">Já atrasados</option></select></label>
                  <label><span>SLA</span><select aria-label="Filtrar por SLA" value={slaFilter} onChange={(event) => setSlaFilter(event.target.value)}><option value="all">Todos</option><option value="safe">No prazo</option><option value="warning">Vence hoje</option><option value="overdue">Atrasado</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label>
                  {(assigneeFilter !== "all" || slaFilter !== "all" || companyFilter !== "all" || processFilter !== "all" || dueFilter !== "all") && <button type="button" className="filter-clear" onClick={() => { setAssigneeFilter("all"); setSlaFilter("all"); setCompanyFilter("all"); setProcessFilter("all"); setDueFilter("all"); }}>Limpar</button>}
                </div>
              </div>

              {boardMode === "kanban" && <div className="dashboard-kanban">
                {snapshot.lists.map((list) => {
                  const visibleCards = filteredActiveCards.filter((card) => card.listId === list.id);
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
                    <header><span><i className={list.kind} />{list.name}</span><b>{visibleCards.length}</b><button aria-label={`Opções de ${list.name}`} onClick={() => setToast(`${list.name}: ${visibleCards.length} demanda(s) visível(is).`)}><MoreHorizontal aria-hidden="true" /></button></header>
                    <div className="dashboard-card-list">
                      {visibleCards.map((card) => {
                        const completed = card.checklist.filter((item) => item.completed).length;
                        return (
                          <article
                            className={`dashboard-task priority-${card.priority} sla-${card.slaStatus}`}
                            key={card.id}
                            draggable={canEdit}
                            tabIndex={0}
                            role="button"
                            aria-label={`Abrir demanda ${card.title}`}
                            onDragStart={() => setDraggedCardId(card.id)}
                            onDragEnd={() => setDraggedCardId(null)}
                            onTouchStart={(event) => {
                              if (canEdit) touchCardMoveRef.current = { cardId: card.id, x: event.touches[0]?.clientX ?? 0, y: event.touches[0]?.clientY ?? 0 };
                            }}
                            onTouchEnd={(event) => {
                              const start = touchCardMoveRef.current;
                              touchCardMoveRef.current = null;
                              const end = event.changedTouches[0];
                              if (!canEdit || !start || start.cardId !== card.id || !end) return;
                              const deltaX = end.clientX - start.x;
                              const deltaY = end.clientY - start.y;
                              if (Math.abs(deltaX) > 96 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
                                suppressCardOpenRef.current = card.id;
                                moveCardByDirection(card.id, deltaX > 0 ? -1 : 1);
                              }
                            }}
                            onClick={() => {
                              if (suppressCardOpenRef.current === card.id) { suppressCardOpenRef.current = null; return; }
                              openCard(card);
                            }}
                            onKeyDown={(event) => {
                              if (event.altKey && event.key === "ArrowLeft" && canEdit) { event.preventDefault(); moveCardByDirection(card.id, -1); return; }
                              if (event.altKey && event.key === "ArrowRight" && canEdit) { event.preventDefault(); moveCardByDirection(card.id, 1); return; }
                              if (event.key === "Enter" || event.key === " ") openCard(card);
                            }}
                          >
                            <div className="dashboard-task-labels"><span className={processColors[card.processType] ?? "gray"}>{card.processType}</span>{card.priority === "urgent" && <span className="urgent">URGENTE</span>}{card.labels.slice(0, 1).map((label) => <span className="custom-label" style={{ color: label.color, backgroundColor: `${label.color}18` }} key={label.id}>{label.name}</span>)}</div>
                            <h2>{card.title}</h2>
                            <p>{card.company || "Sem empresa informada"}{card.companyId && snapshot.companies.find((company) => company.id === card.companyId)?.taxId ? <small> • {snapshot.companies.find((company) => company.id === card.companyId)?.taxId}</small> : null}</p>
                            {card.customValues.matricula && <small className="dashboard-card-employee">Colaborador: {card.customValues.matricula}</small>}
                            <div className="dashboard-task-bottom"><span className={`dashboard-sla ${card.slaStatus}`}><Clock3 aria-hidden="true" /> {slaLabel(card)}</span><span className="dashboard-check" title="Checklist concluído"><ListChecks aria-hidden="true" /> {completed}/{card.checklist.length}</span>{card.attachments.length > 0 && <span className="dashboard-comments" title="Anexos"><Paperclip aria-hidden="true" /> {card.attachments.length}</span>}{card.comments.length > 0 && <span className="dashboard-comments" title="Comentários"><MessageCircle aria-hidden="true" /> {card.comments.length}</span>}<span className="dashboard-mini-avatar">{initials(card.assignees[0]?.name || card.assigneeName || "DP")}</span>{card.assignees.length > 1 && <small className="avatar-more">+{card.assignees.length - 1}</small>}</div>
                          </article>
                        );
                      })}
                      {canEdit && <button className="dashboard-add-card" onClick={() => { setCardForm({ ...emptyCardForm, boardId: snapshot.board.id, listId: list.id }); setSelectedCardId(null); setCardTab("details"); setCardModalOpen(true); }}><Plus aria-hidden="true" /> Adicionar demanda</button>}
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
          {view === "planner" && <PlannerView cards={activeCards} blocks={snapshot.plannerBlocks} connections={snapshot.calendarConnections} onOpen={openCard} onCreateBlock={(payload) => mutate("/api/planner/blocks", { method: "POST", body: JSON.stringify(payload) }, "Bloco adicionado ao planner.")} onDeleteBlock={(id) => mutate(`/api/planner/blocks/${id}`, { method: "DELETE" }, "Bloco removido do planner.")} onSaveConnection={(payload) => mutate("/api/calendar/connections", { method: "POST", body: JSON.stringify(payload) }, "Calendário externo configurado. A sincronização será ativada após a conexão OAuth.")} />}
          {view === "payroll" && <PayrollView companies={snapshot.companies} metrics={snapshot.hrMetrics} busy={busy} canEdit={canEdit} onSaveMetric={saveHrMetric} />}
          {view === "indicators" && <IndicatorsView canExportWorkspace={isAdmin} cards={scopedCards} companyId={companyFilter === "all" ? "" : companyFilter} scopeLabel={companyFilter === "all" ? companyScopeLabel : (snapshot.companies.find((item) => item.id === companyFilter)?.tradeName || snapshot.companies.find((item) => item.id === companyFilter)?.legalName || "Empresa selecionada")} rules={snapshot.rules} busy={busy} canManageRules={isAdmin} onToggleRule={toggleRule} onExport={exportCsv} hrMetrics={snapshot.hrMetrics} companies={snapshot.companies} />}
          </div>
        </div>
      </section>

      {error && <div className="workspace-toast error" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
      {toast && <div className="workspace-toast" role="status"><span>✓</span>{toast}</div>}
      {busy && <div className="workspace-busy" aria-label="Salvando"><i /></div>}

      {searchOpen && (
        <div className="workspace-modal-backdrop search-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
          <section className="search-palette" ref={searchPanelRef} role="dialog" aria-modal="true" aria-labelledby="search-title">
            <header><span aria-hidden="true">⌕</span><input id="search-title" autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Buscar demanda, empresa, responsável, etiqueta…" /><kbd>ESC</kbd></header>
            <div className="search-results" role="listbox" aria-label="Resultados da busca">
              {searchResults.length === 0 && searchRecords.length === 0 && <div className="empty-view"><span>⌕</span><strong>{searchQuery ? "Nenhum resultado" : "Busca operacional"}</strong><p>{searchQuery ? "Tente outro termo: nome, matrícula, CPF, empresa, competência ou prestador." : "Digite para localizar demandas, empresas, colaboradores, psicólogos, prestadores PJ, competências e integrações."}</p></div>}
              {searchResults.length > 0 && <p className="search-group-label" id="search-group-demands">Demandas</p>}
              {searchResults.map((result) => <button key={result.id} onClick={() => openSearchResult(result)}><i className={processColors[result.processType] ?? "gray"} /><span><strong>{result.title}</strong><small>{result.company || result.processType} • {result.assigneeName || "Sem responsável"}</small></span><em className={result.slaStatus}>{result.archived ? "Arquivada" : compactSlaLabel(result.slaStatus, result.dueAt)}</em></button>)}
              {searchRecords.length > 0 && <p className="search-group-label">Registros da operação</p>}
              {searchRecords.map((record) => <button key={`${record.kind}:${record.id}`} onClick={() => openSearchRecord(record)}><i className={searchRecordColors[record.kind] ?? "gray"} /><span><strong>{record.title}</strong><small>{record.subtitle}</small></span><em>{searchRecordLabels[record.kind] ?? record.kind}</em></button>)}
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
              {snapshot.notifications.length === 0 && <div className="empty-view"><span>✓</span><strong>Tudo em dia</strong><p>Alertas de SLA, comentários e movimentações aparecerão aqui.</p></div>}
              {snapshot.notifications.map((notification) => <button className={notification.readAt ? "read" : "unread"} key={notification.id} onClick={() => { if (!notification.readAt) void markNotification(notification.id); const card = notification.cardId ? allCards.find((item) => item.id === notification.cardId) : null; if (card) { setNotificationsOpen(false); if (card.archived) setArchiveOpen(true); else openCard(card); } }}><i>{notification.type.includes("sla") ? "!" : "●"}</i><span><strong>{notification.title}</strong><p>{notification.body}</p><time>{formatMoment(notification.createdAt)}</time></span></button>)}
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
          <section className="workspace-modal card-modal demand-detail-modal" role="dialog" aria-modal="true" aria-labelledby="card-modal-title">
            <header><div><span>{selectedCard ? `Demanda • ${selectedCard.processType}` : "Nova demanda"}</span><h2 id="card-modal-title">{selectedCard ? selectedCard.title : "Adicionar à fila"}</h2>{selectedCard && <p className="demand-detail-meta">{snapshot.lists.find((list) => list.id === selectedCard.listId)?.name ?? "Sem status"} • {selectedCard.company || "Sem empresa vinculada"} • {selectedCard.assigneeName || "Sem responsável"}</p>}</div><button onClick={() => setCardModalOpen(false)} aria-label="Fechar">×</button></header>
            {selectedCard && <nav className="card-dialog-tabs" aria-label="Seções da demanda"><button className={cardTab === "details" ? "active" : ""} onClick={() => setCardTab("details")}>Detalhes</button><button className={cardTab === "checklist" ? "active" : ""} onClick={() => setCardTab("checklist")}>Checklist <b>{selectedCard.checklist.filter((item) => item.completed).length}/{selectedCard.checklist.length}</b></button><button className={cardTab === "attachments" ? "active" : ""} onClick={() => setCardTab("attachments")}>Anexos <b>{selectedCard.attachments.length}</b></button><button className={cardTab === "activity" ? "active" : ""} onClick={() => setCardTab("activity")}>Atividade <b>{selectedCard.comments.length + selectedCard.activities.length}</b></button></nav>}
            <div className="card-modal-body single">
              {selectedCard && <section className="demand-detail-summary"><div className={`demand-sla-state ${selectedCard.slaStatus}`}><span>SLA</span><strong>{slaLabel(selectedCard)}</strong><small>{selectedCard.slaStatus === "paused" ? selectedCard.slaPausedReason || "Pausa justificada" : selectedCard.dueAt ? `Vencimento: ${formatDue(selectedCard.dueAt)}` : "Defina um prazo para controlar o SLA"}</small></div><div className="demand-document-state"><span>DOCUMENTOS</span><strong>{selectedCard.checklist.filter((item) => item.completed).length} aprovados</strong><small>{selectedCard.checklist.filter((item) => !item.completed).length} pendente(s) • {selectedCard.attachments.length} anexo(s)</small></div><div className="demand-quick-actions">{canEdit && !selectedCard.archived && <><button className="quick-complete" type="button" onClick={completeSelectedCard}><CheckCircle2 aria-hidden="true" /> Concluir</button><button type="button" onClick={() => { setCardTab("activity"); setNewComment("Solicitação de documentos: informe quais documentos ainda precisam ser enviados."); }}>Solicitar documento</button><button type="button" onClick={() => focusCardField("card-assignees")}>Responsável</button><button type="button" onClick={() => focusCardField("card-due-at")}>Prazo</button></>}</div></section>}
              {(!selectedCard || cardTab === "details") &&
              <form className={`card-form ${!canEdit ? "read-only" : ""}`} onSubmit={saveCard}>
                {!selectedCard && <label className="full">Começar com um template<select value={cardForm.templateId} onChange={(event) => { const template = snapshot.templates.find((item) => item.id === event.target.value); setCardForm({ ...cardForm, templateId: event.target.value, processType: template?.processType ?? cardForm.processType, description: template?.description ?? cardForm.description }); }}><option value="">Demanda em branco</option>{snapshot.templates.filter((item) => item.active).map((template) => <option value={template.id} key={template.id}>{template.name} • SLA {template.defaultSlaDays} dia(s) útil(eis)</option>)}</select></label>}
                {!selectedCard && <label className="full">Processo operacional<select value={cardForm.boardId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, boardId: event.target.value, listId: "" })}>{snapshot.boards.map((board) => <option value={board.id} key={board.id}>{board.boardType === "process" ? `Processo: ${board.name}` : `Quadro geral: ${board.name}`}</option>)}</select><small className="card-process-helper">A demanda será criada e movimentada somente nas colunas deste processo.</small></label>}
                <label className="full">Título da demanda<input autoFocus value={cardForm.title} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, title: event.target.value })} placeholder="Ex.: Conciliar colaborador com o ERP" required /></label>
                <label className="full">Descrição<textarea value={cardForm.description} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, description: event.target.value })} placeholder="Contexto e orientações para execução" rows={4} /></label>
                <label>Tipo de processo<select value={cardForm.processType} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, processType: event.target.value })}><option>CONCILIAÇÃO CADASTRAL</option><option>RESCISÃO</option><option>FÉRIAS</option><option>BENEFÍCIOS</option><option>FOLHA</option><option>CADASTRO</option><option>OUTROS</option></select></label>
                <label>Empresa<select value={cardForm.companyId} disabled={!canEdit} onChange={(event) => { const company = snapshot.companies.find((item) => item.id === event.target.value); setCardForm({ ...cardForm, companyId: event.target.value, company: company ? (company.tradeName || company.legalName) : cardForm.company }); }}><option value="">Sem empresa vinculada</option>{snapshot.companies.filter((company) => company.status === "active" || company.id === cardForm.companyId).map((company) => <option value={company.id} key={company.id}>{company.tradeName || company.legalName}{company.taxId ? ` • ${company.taxId}` : ""}{company.status !== "active" ? " (inativa)" : ""}</option>)}</select></label>
                <label>Prazo<input id="card-due-at" type="datetime-local" value={dueInputValue(cardForm.dueAt, snapshot.settings.dayEnd)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, dueAt: event.target.value })} /></label>
                {selectedCard?.slaTargetMinutes ? <p className="card-sla-target full">SLA configurado: <strong>{formatWorkingMinutes(selectedCard.slaTargetMinutes)}</strong> de expediente. Pausas justificadas não entram na contagem.</p> : null}
                <label>Prioridade<select value={cardForm.priority} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, priority: event.target.value })}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
                <label>Coluna<select value={cardForm.listId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, listId: event.target.value })}><option value="">Automática pelas regras</option>{snapshot.lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label>
                <section className="card-choice-section full" id="card-assignees" tabIndex={-1}><header><strong>Responsáveis</strong><span>Selecione uma ou mais pessoas</span></header><div className="choice-chips">{snapshot.members.filter((member) => member.role === "admin" || member.role === "member").map((member) => <label className={cardForm.assigneeIds.includes(member.userId) ? "selected" : ""} key={member.userId}><input type="checkbox" checked={cardForm.assigneeIds.includes(member.userId)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, assigneeIds: event.target.checked ? [...cardForm.assigneeIds, member.userId] : cardForm.assigneeIds.filter((id) => id !== member.userId) })} /><i>{initials(member.name)}</i>{member.name}</label>)}</div></section>
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

              {selectedCard && cardTab === "attachments" && <section className="card-tab-panel attachments-panel"><header><div><span>DOCUMENTOS</span><h3>Anexos da demanda</h3><p>PDF, imagem, TXT, CSV, DOCX ou XLSX, com até 20 MB.</p></div>{canEdit && !selectedCard.archived && <label className="upload-button">＋ Enviar arquivo<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.docx,.xlsx" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAttachment(file); event.target.value = ""; }} /></label>}</header><div className="attachment-list">{selectedCard.attachments.length === 0 && <div className="empty-view"><span>↥</span><strong>Nenhum anexo</strong><p>Envie documentos para manter todo o processo no mesmo lugar.</p></div>}{selectedCard.attachments.map((attachment) => <article key={attachment.id}><i>{attachment.filename.split(".").pop()?.toUpperCase()}</i><div><strong>{attachment.filename}</strong><span>{formatFileSize(attachment.sizeBytes)} • {attachment.uploadedBy} • {formatMoment(attachment.createdAt)}</span></div>{canPreviewAttachment(attachment) && <button className="attachment-preview-button" onClick={() => setAttachmentPreview(attachment)}>Visualizar</button>}<a href={attachment.downloadUrl}>Baixar</a>{canEdit && !selectedCard.archived && <button onClick={() => void removeAttachment(attachment.id)} aria-label={`Excluir ${attachment.filename}`}>×</button>}</article>)}</div></section>}

              {selectedCard && cardTab === "activity" && <section className="card-tab-panel activity-panel"><div className="card-collaboration"><header><span>COMENTÁRIOS</span><strong>{selectedCard.comments.length}</strong></header><div className="card-comments">{selectedCard.comments.length === 0 && <p className="card-empty-note">Nenhum comentário ainda.</p>}{selectedCard.comments.map((comment) => <article key={comment.id}><i>{initials(comment.authorName)}</i><div><strong>{comment.authorName}<time>{formatMoment(comment.createdAt)}</time></strong><p>{comment.body}</p>{(comment.authorEmail === user.email || isAdmin) && !selectedCard.archived && <div className="comment-actions"><button onClick={() => void editComment(comment.id, comment.body)}>Editar</button><button onClick={() => void deleteComment(comment.id)}>Excluir</button></div>}</div></article>)}</div>{canComment && !selectedCard.archived && <form className="comment-form" onSubmit={addComment}><textarea value={newComment} onChange={(event) => setNewComment(event.target.value)} placeholder="Escreva uma atualização para a equipe. Use @nome para mencionar alguém." rows={3} maxLength={2000} /><button disabled={!newComment.trim() || busy}>Publicar comentário</button></form>}<header className="activity-heading"><span>HISTÓRICO DA DEMANDA</span><strong>{selectedCard.activities.length} evento(s)</strong></header><ol className="activity-list">{selectedCard.activities.slice(0, 20).map((activity) => { const details = activityDetails(activity); return <li key={activity.id}><i /><div><strong>{activity.actorName}</strong> {activityLabel(activity)}{details.length > 0 && <ul className="activity-change-list">{details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}<time>{formatMoment(activity.createdAt)}</time></div></li>; })}</ol></div></section>}
            </div>
          </section>
        </div>
      )}

      {attachmentPreview && (
        <div className="workspace-modal-backdrop attachment-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAttachmentPreview(null); }}>
          <section className="workspace-modal attachment-preview-modal" role="dialog" aria-modal="true" aria-labelledby="attachment-preview-title">
            <header><div><span>PRÉ-VISUALIZAÇÃO SEGURA</span><h2 id="attachment-preview-title">{attachmentPreview.filename}</h2></div><div className="attachment-preview-actions"><a href={attachmentPreview.downloadUrl}>Baixar</a><button onClick={() => setAttachmentPreview(null)} aria-label="Fechar">×</button></div></header>
            <div className="attachment-preview-content">
              {attachmentPreview.contentType.startsWith("image/") ? <Image src={`${attachmentPreview.downloadUrl}?disposition=inline`} alt={`Pré-visualização de ${attachmentPreview.filename}`} width={1600} height={1000} unoptimized /> : <iframe src={`${attachmentPreview.downloadUrl}?disposition=inline`} title={`Pré-visualização de ${attachmentPreview.filename}`} />}
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
            <header><div><span>CONTA PESSOAL</span><h2 id="workspace-modal-title">Perfil e segurança</h2><p>Revise apenas as sessões da identidade atual.</p></div><button onClick={() => setWorkspaceModalOpen(false)} aria-label="Fechar">×</button></header>
            <div className="workspace-settings-layout">
              <nav className="settings-nav" aria-label="Seções das configurações">
                <span className="settings-nav-label">CONTA</span>
                <button className={settingsSection === "security" ? "active" : ""} onClick={() => { setSettingsSection("security"); void loadAuthSessions(); }}><Smartphone aria-hidden="true" /><span>Segurança<small>Dispositivos e sessões</small></span></button>
              </nav>
              <div className="workspace-settings-content">
                {settingsSection === "general" && <><form className="workspace-name-form" onSubmit={saveWorkspace}><label>Nome do workspace<input autoFocus value={workspaceName} disabled={!isAdmin} onChange={(event) => setWorkspaceName(event.target.value)} maxLength={60} required /></label>{isAdmin && <button className="primary-button" disabled={busy}>Salvar nome</button>}</form><div className="workspace-account-summary"><span className="user-avatar">{userInitials}</span><div><strong>{user.displayName}</strong><small>{user.email}</small><em>{roleLabels[snapshot.workspace.role]}</em></div></div>{snapshot.availableWorkspaces.length > 1 && <section className="workspace-switcher"><header><div><strong>Seus workspaces</strong><span>Alterne entre as operações às quais você tem acesso.</span></div></header><div>{snapshot.availableWorkspaces.map((item) => <button className={item.id === snapshot.workspace.id ? "active" : ""} disabled={busy || item.id === snapshot.workspace.id} onClick={() => void switchWorkspace(item.id)} key={item.id}><i>{initials(item.name)}</i><span><strong>{item.name}</strong><small>{roleLabels[item.role]}</small></span><b>{item.id === snapshot.workspace.id ? "Atual" : "Abrir"}</b></button>)}</div></section>}{<section className="board-manager"><header><div><strong>Quadros da operação</strong><span>{snapshot.boards.length} quadro(s) disponíveis</span></div></header><div>{snapshot.boards.map((board) => <button className={board.id === snapshot.board.id ? "active" : ""} key={board.id} onClick={() => void switchBoard(board.id)}><i>{initials(board.name)}</i><span><strong>{board.name}</strong><small>{board.description || "Sem descrição"}</small></span><b>{board.id === snapshot.board.id ? "Atual" : "Abrir"}</b></button>)}</div>{isAdmin && <form className="board-create-form" onSubmit={createBoard}><input value={newBoardName} onChange={(event) => setNewBoardName(event.target.value)} placeholder="Nome do novo quadro" required /><input value={newBoardDescription} onChange={(event) => setNewBoardDescription(event.target.value)} placeholder="Descrição opcional" /><button className="primary-button" disabled={busy}>Criar quadro</button></form>}</section>}</>}
                {settingsSection === "columns" && <ListsSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onMutate={mutate} onConfirm={requestConfirmation} />}
                {settingsSection === "companies" && isAdmin && <CompanySettings companies={snapshot.companies} members={snapshot.members} busy={busy} onCreateCompany={createCompany} onDeleteCompany={deleteCompany} onOpenAccess={() => setSettingsSection("team")} />}
                {settingsSection === "team" && <>
                  <section className="access-admin-hero"><span><Users aria-hidden="true" /></span><div><strong>Controle de acesso do grupo</strong><p>Você define quem entra, qual papel cada pessoa terá e quais empresas poderá consultar ou operar.</p></div><b>{isAdmin ? "Você é administrador" : "Acesso limitado"}</b></section>
                  <section className="workspace-team"><header><div><strong>Usuários liberados</strong><span>{snapshot.members.length} pessoa(s) com acesso ao grupo</span></div><p>O proprietário e os administradores veem todas as empresas. Os demais acessam apenas os CNPJs liberados.</p></header>
                    <div className="workspace-member-list">{snapshot.members.map((member) => <article key={member.userId}><i>{initials(member.name)}</i><div><strong>{member.name}{member.isOwner && <em>Administrador principal</em>}</strong><small>{member.email}</small><span className={`member-activation-status ${member.isActivated ? "active" : "pending"}`}>{member.isActivated ? "Acesso ativo" : "Ativação pendente"}</span></div>{isAdmin && !member.isOwner ? <select aria-label={`Papel de ${member.name}`} value={member.role} disabled={busy} onChange={(event) => void updateMemberRole(member.userId, event.target.value as WorkspaceRole)}><option value="admin">Administrador</option><option value="member">Membro</option><option value="observer">Observador</option><option value="guest">Convidado</option></select> : <b>{roleLabels[member.role]}</b>}{isAdmin && !member.isOwner && <MemberCompanyAccess key={`${member.userId}:${member.companyIds.join(",")}`} member={member} companies={snapshot.companies} busy={busy} onSave={updateMemberCompanies} />}{isAdmin && !member.isOwner && <button className="member-recovery-button" disabled={busy} onClick={() => void generateRecoveryLink(member.userId, member.name)}>{member.isActivated ? "Gerar novo link" : "Gerar link de ativação"}</button>}{isAdmin && !member.isOwner && <button aria-label={`Remover ${member.name}`} disabled={busy} onClick={() => void removeMember(member.userId, member.name)}>×</button>}</article>)}</div>
                  </section>
                  {isAdmin && <form className="workspace-invite-form" onSubmit={addMember}><header><div><strong>Criar e liberar usuário</strong><span>O sistema gerará um link único para a pessoa definir a própria senha.</span></div><b>1. Cadastre · 2. Copie o link · 3. Libere</b></header><div><label>Nome<input value={memberName} onChange={(event) => setMemberName(event.target.value)} placeholder="Nome da pessoa" maxLength={120} /></label><label>E-mail<input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="nome@empresa.com" required /></label><label>Papel<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as WorkspaceRole)}><option value="member">Membro</option><option value="observer">Observador</option><option value="guest">Convidado</option><option value="admin">Administrador</option></select></label><fieldset className="invite-company-scope" disabled={busy || memberRole === "admin"}><legend>{memberRole === "admin" ? "Administrador acessa todas as empresas" : "Empresas autorizadas"}</legend><div>{snapshot.companies.map((company) => <label key={company.id}><input type="checkbox" checked={memberCompanyIds.includes(company.id)} onChange={(event) => setMemberCompanyIds((current) => event.target.checked ? [...current, company.id] : current.filter((id) => id !== company.id))} />{company.isPrincipal ? "★ " : "↳ "}{company.tradeName || company.legalName}</label>)}</div></fieldset><button className="primary-button" disabled={busy || !memberEmail.trim()}>Criar usuário e gerar link</button></div></form>}
                </>}
                {settingsSection === "team" && recoveryLink && <section className="access-recovery-link"><header><div><span>LINK ÚNICO DE RECUPERAÇÃO</span><strong>{recoveryLink.name}</strong><small>Válido até {new Date(recoveryLink.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. O link deixa de funcionar após o primeiro uso.</small></div><button onClick={() => { void navigator.clipboard.writeText(recoveryLink.url).then(() => setToast("Link de recuperação copiado.")); }}>Copiar link</button></header><input value={recoveryLink.url} readOnly aria-label="Link de recuperação" /></section>}
                {settingsSection === "security" && <section className="security-sessions">
                  <header><div><strong>Dispositivos conectados</strong><span>Revise os acessos ativos da sua conta. Endereços IP e identificadores completos do navegador não são armazenados.</span></div><button className="secondary-button" disabled={busy || sessionsLoading || authSessions.length < 2} onClick={() => void revokeAuthSessions("/api/auth/sessions?scope=others")}>Sair dos outros</button></header>
                  {sessionsLoading && <p>Carregando sessões...</p>}
                  {!sessionsLoading && authSessions.length === 0 && <p>Nenhuma sessão gerenciável foi encontrada para este tipo de acesso.</p>}
                  <div>{authSessions.map((session) => <article key={session.id}><i><Smartphone aria-hidden="true" /></i><span><strong>{session.deviceLabel}{session.current && <em>Atual</em>}</strong><small>Último uso: {new Date(session.lastSeenAt).toLocaleString("pt-BR")} · Criada em {new Date(session.createdAt).toLocaleDateString("pt-BR")}</small><small>Expira em {new Date(session.expiresAt).toLocaleString("pt-BR")}</small></span><button className="secondary-button" disabled={busy} onClick={() => void revokeAuthSessions(`/api/auth/sessions/${session.id}`)}>{session.current ? "Sair deste dispositivo" : "Revogar"}</button></article>)}</div>
                  <footer><span>Se você não reconhecer um dispositivo, encerre todas as sessões e entre novamente.</span><button className="danger-button" disabled={busy || sessionsLoading || authSessions.length === 0} onClick={() => void revokeAuthSessions("/api/auth/sessions?scope=all")}>Sair de todos</button></footer>
                </section>}
                {settingsSection === "fields" && <FieldsSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} onConfirm={requestConfirmation} />}
                {settingsSection === "templates" && <TemplatesSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} onConfirm={requestConfirmation} onUseTemplate={(id) => { setWorkspaceModalOpen(false); openFromTemplate(id); }} />}
                {settingsSection === "sla" && <SlaSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} />}
                {settingsSection === "automations" && <RulesSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} onConfirm={requestConfirmation} />}
              </div>
            </div>
          </section>
        </div>
      )}

      {confirmation && (
        <div className="workspace-modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmation(null); }}>
          <section className="workspace-modal confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description">
            <header><div><span>CONFIRMAÇÃO NECESSÁRIA</span><h2 id="confirmation-title">{confirmation.title}</h2></div><button onClick={() => setConfirmation(null)} aria-label="Fechar"><X aria-hidden="true" /></button></header>
            <div className="confirmation-body"><CircleAlert aria-hidden="true" /><p id="confirmation-description">{confirmation.description}</p></div>
            <footer><button type="button" className="secondary-button" onClick={() => setConfirmation(null)}>Cancelar</button><button type="button" className="danger-button" disabled={busy} onClick={() => void confirmPendingAction()}>{confirmation.confirmLabel}</button></footer>
          </section>
        </div>
      )}

      {/* Recolhido por padrão: um copiloto que ocupa espaço sem ter sido pedido
          atrapalha justamente quem já sabe o que fazer. */}
      <AssistantPanel screen={viewCatalog[view].label} openSignal={assistantSignal} />
    </main>
  );
}


/**
 * O fluxo da competência (Modelo 2, "Flow").
 *
 * No lugar da faixa marinho que dizia "N demanda(s) em andamento" — texto que
 * o indicador logo abaixo repetia, e cuja concordância "(s)" era ruído de
 * gerador. O fechamento é o fato mais estruturante do DP: a operação é cíclica
 * e fecha todo mês, e a interface não dizia isso em lugar nenhum.
 *
 * As cinco etapas são os estados que o servidor aceita (`cycleStatuses` em
 * lib/operations.ts), não uma sequência decorativa: avançar entre elas passa
 * pelos bloqueios de `describeClosingBlockers`.
 *
 * O estado é marcado por forma além de cor — ícone de concluído, anel na
 * etapa atual, contorno vazio no que falta — para funcionar também para quem
 * não distingue verde de azul.
 */
function ConnectionMap({ integrations, onNavigate }: {
  integrations: WorkspaceSnapshot["integrations"];
  onNavigate: (target: ActionTarget) => void;
}) {
  /* A peça mais característica do Modelo 2: a marca no centro e os sistemas em
     volta. Para um produto chamado Vinculato, o desenho é a tese — mas só vale
     se o que ele mostra for verdade.

     A fonte é `snapshot.integrations`, o que ESTE grupo tem configurado, e não
     o catálogo do site. O mockup trazia eSocial, FGTS Digital e Pontotel como
     conectados; nenhum dos três existe no produto, e a §31 é explícita: uma
     integração só aparece como disponível quando estiver homologada de ponta a
     ponta. Desenhar linha para conector que não conecta seria vender a conexão
     na tela de quem já é cliente.

     Semanticamente é uma lista, não um desenho: o arranjo em torno do centro é
     apresentação, e quem usa leitor de tela recebe nome, estado e última
     sincronização em texto. */
  if (!integrations.length) {
    return <section className="connection-map connection-map-empty" aria-label="Conexões">
      <h3>Conexões</h3>
      <p>Nenhum conector configurado neste grupo. As integrações disponíveis aparecem em Estado das integrações.</p>
      <button type="button" className="secondary-button" onClick={() => onNavigate("integrations")}>Ver integrações</button>
    </section>;
  }

  const conectadas = integrations.filter((item) => item.status === "connected").length;
  const comErro = integrations.filter((item) => item.status === "error").length;

  return <section className="connection-map" aria-label="Conexões">
    <header>
      <div>
        <span>CONEXÕES</span>
        <strong>{plural(conectadas, "sistema conectado", "sistemas conectados")}</strong>
        <p>{comErro
          ? `${plural(comErro, "conector com erro", "conectores com erro")}, de ${plural(integrations.length, "configurado", "configurados")}.`
          : `de ${plural(integrations.length, "configurado", "configurados")} neste grupo.`}</p>
      </div>
      <button type="button" className="secondary-button" onClick={() => onNavigate("integrations")}>Ver integrações</button>
    </header>

    <div className="connection-map-graph">
      <p className="connection-map-hub" aria-hidden="true"><VinculatoLogo size={22} compact /></p>
      <ul>
        {integrations.map((item) => {
          const tom = connectionTone(item.status);
          return <li key={item.id} data-tone={tom}>
            <i aria-hidden="true" />
            <span>
              <strong>{item.displayName}</strong>
              <small>{connectionStatusLabel(item.status)}
                {item.status === "connected" ? ` · ${lastSyncLabel(item.lastSyncAt)}` : ""}</small>
            </span>
          </li>;
        })}
      </ul>
    </div>
  </section>;
}

const plural = (n: number, um: string, muitos: string) => `${n} ${n === 1 ? um : muitos}`;

function CompetenceFlow({ cycles, scopeLabel, active, onNew, onNavigate }: {
  cycles: WorkspaceSnapshot["payrollCycles"];
  scopeLabel: string;
  active: number;
  onNew?: () => void;
  onNavigate: (target: ActionTarget) => void;
}) {
  const progresso = cycleProgress(cycles);
  const competencia = cycles[0]?.competence ?? "";

  return <section className="competence-flow" aria-label="Fluxo da competência">
    <header>
      <div>
        <span>COMPETÊNCIA · {scopeLabel.toUpperCase()}</span>
        <strong>{competencia ? competenceLabel(competencia) : "Nenhuma competência aberta"}</strong>
        {/* "1 ciclo(s) concluído(s)" é ruído de gerador, não texto de produto —
            a mesma coisa que a §44 já tinha tirado da página de planos. */}
        <p>{progresso
          ? progresso.completa
            ? `${plural(progresso.total, "ciclo concluído", "ciclos concluídos")}. Nada pendente nesta competência.`
            : `${progresso.concluidos} de ${plural(progresso.total, "ciclo concluído", "ciclos concluídos")} · ${plural(active, "demanda em andamento", "demandas em andamento")}.`
          : "Abra a competência em Operação DP para acompanhar o fechamento por aqui."}</p>
      </div>
      <div className="competence-flow-actions">
        <button type="button" className="secondary-button" onClick={() => onNavigate("processes")}>Ver fechamento</button>
        {onNew && <button type="button" className="primary-button" onClick={onNew}><Plus aria-hidden="true" /> Nova demanda</button>}
      </div>
    </header>

    {progresso
      ? <ol className="competence-flow-track">
          {cycleStages.map((stage, index) => {
            const estado = index < progresso.atual ? "done" : index === progresso.atual ? "current" : "todo";
            return <li key={stage.status} data-state={estado}
              aria-current={estado === "current" ? "step" : undefined}>
              <i aria-hidden="true">{estado === "done" ? <Check /> : null}</i>
              <span><strong>{stage.label}</strong><small>{estado === "done" ? "Concluída" : estado === "current" ? stage.note : "Pendente"}</small></span>
            </li>;
          })}
        </ol>
      : null}
  </section>;
}

function OverviewView({ onNavigate, cards, companies, lists, activities, stats, onOpen, onOpenBoard, onNew, canEdit, companyId, scopeLabel, cycles, integrations }: {
  onNavigate: (target: ActionTarget) => void;
  cards: Card[];
  companies: WorkspaceSnapshot["companies"];
  lists: WorkspaceSnapshot["lists"];
  activities: ActivityEvent[];
  cycles: WorkspaceSnapshot["payrollCycles"];
  integrations: WorkspaceSnapshot["integrations"];
  stats: { active: number; attention: number; waiting: number; onTime: number; completed: number; documentsPending: number; activeCompanies: number };
  onOpen: (card: Card) => void;
  onOpenBoard: () => void;
  onNew: () => void;
  canEdit: boolean;
  /** Empresa do recorte; vazio = todas as autorizadas. */
  companyId: string;
  scopeLabel: string;
}) {
  const attention = cards.filter((card) => card.slaStatus === "overdue" || card.slaStatus === "warning").sort((a, b) => (a.slaStatus === "overdue" ? -1 : 1) - (b.slaStatus === "overdue" ? -1 : 1));
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const totalChecklistItems = cards.reduce((total, card) => total + card.checklist.length, 0);
  const checkedItems = cards.reduce((total, card) => total + card.checklist.filter((item) => item.completed).length, 0);
  const maxStatus = Math.max(1, ...lists.map((list) => list.cards.length));
  const visibleColumns = lists.slice(0, 3);

  return <div className="overview-layout">
    <ActionCenter onNavigate={onNavigate} companyId={companyId} />

    <CompetenceFlow cycles={cycles} scopeLabel={scopeLabel} active={stats.active}
      onNew={canEdit ? onNew : undefined} onNavigate={onNavigate} />

    <ConnectionMap integrations={integrations} onNavigate={onNavigate} />

    <section className="overview-metrics" aria-label="Indicadores principais">
      <article><span>Demandas abertas</span><strong>{stats.active}</strong><small>{stats.completed} concluída(s) no quadro</small></article>
      <article className={stats.attention ? "requires-attention" : ""}><span>SLA em risco</span><strong>{stats.attention}</strong><small>{stats.attention ? "Ação necessária hoje" : "Nenhum prazo crítico"}</small></article>
      <article><span>Documentos pendentes</span><strong>{stats.documentsPending}</strong><small>{checkedItems} de {totalChecklistItems} etapas concluídas</small></article>
      {/* Com uma empresa escolhida, "Empresas ativas: 3" seria um número do
          grupo inteiro sentado entre três números do recorte — o tipo de
          vizinhança que faz ler errado sem perceber. */}
      {companyId
        ? <article><span>Empresa em foco</span><strong className="overview-metric-name">{scopeLabel}</strong><small>Os números acima são só desta empresa</small></article>
        : <article><span>Empresas ativas</span><strong>{stats.activeCompanies}</strong><small>Cadastros disponíveis na operação</small></article>}
    </section>

    <section className="overview-sla-band">
      <div><span>SAÚDE DO SLA</span><strong>{stats.onTime}% dentro do prazo</strong><p>{stats.completed} demandas concluídas • {stats.waiting} com SLA pausado</p></div>
      <div className="sla-progress" aria-label={`${stats.onTime}% das demandas dentro do prazo`} role="img"><i style={{ width: `${Math.max(0, Math.min(100, stats.onTime))}%` }} /></div>
      <div className="overview-sla-summary"><strong>{stats.attention}</strong><span>pendência(s)<br />que precisam de atenção</span></div>
    </section>

    <div className="overview-grid">
      <section className="overview-panel attention-panel"><header><div><span>ATENÇÃO HOJE</span><h2>O que exige ação</h2></div><button onClick={onOpenBoard}>Ver quadro <ArrowRight aria-hidden="true" /></button></header><div className="overview-attention-list">
        {attention.length === 0 && <div className="overview-empty"><CheckCircle2 aria-hidden="true" /><strong>Nenhuma demanda crítica agora.</strong><p>Os prazos em aberto estão dentro da política definida.</p></div>}
        {attention.slice(0, 4).map((card) => <button className={`overview-attention-card ${card.slaStatus}`} key={card.id} onClick={() => onOpen(card)}><i /><span><strong>{card.title}</strong><small>{card.company || "Sem empresa"} • {card.assigneeName || "Sem responsável"}</small></span><em>{compactSlaLabel(card.slaStatus, card.dueAt)}</em></button>)}
      </div></section>

      <section className="overview-panel status-panel"><header><div><span>VOLUME POR STATUS</span><h2>Demandas na operação</h2></div><button onClick={onOpenBoard}>Abrir demandas <ArrowRight aria-hidden="true" /></button></header><div className="status-chart" role="img" aria-label="Gráfico de demandas por status">
        {lists.map((list) => <div key={list.id}><span style={{ height: `${Math.max(10, (list.cards.length / maxStatus) * 100)}%` }} /><strong>{list.cards.length}</strong><small>{list.name}</small></div>)}
      </div></section>
    </div>

    <div className="overview-grid overview-bottom-grid">
      <section className="overview-panel board-preview"><header><div><span>PRÉVIA DO QUADRO</span><h2>Próximas demandas</h2></div><button onClick={onOpenBoard}>Ver todas <ArrowRight aria-hidden="true" /></button></header><div className="board-preview-columns">
        {visibleColumns.map((list) => <section key={list.id}><header><strong>{list.name}</strong><b>{list.cards.length}</b></header>{list.cards.slice(0, 2).map((card) => { const company = card.companyId ? companyById.get(card.companyId) : undefined; return <button className={`mini-demand-card sla-${card.slaStatus}`} onClick={() => onOpen(card)} key={card.id}><span>{card.processType}</span><strong>{card.title}</strong><small>{card.company || "Sem empresa"}{company?.taxId ? ` • ${company.taxId}` : ""}</small><em>{compactSlaLabel(card.slaStatus, card.dueAt)}</em></button>; })}{list.cards.length === 0 && <p className="mini-column-empty">Nenhuma demanda</p>}</section>)}
      </div></section>

      <section className="overview-panel activity-panel"><header><div><span>ATIVIDADES RECENTES</span><h2>Histórico da operação</h2></div></header><div className="recent-activity-list">
        {activities.slice(0, 5).map((activity) => <article key={activity.id}><span>{initials(activity.actorName || "DP")}</span><div><strong>{activity.actorName || "Equipe DP"} <small>{activityLabel(activity)}</small></strong><p>{activityDetails(activity)[0] || "Registro atualizado na operação."}</p></div><time>{formatMoment(activity.createdAt)}</time></article>)}
        {activities.length === 0 && <div className="overview-empty"><Clock3 aria-hidden="true" /><strong>O histórico aparecerá aqui.</strong><p>As movimentações de demandas e documentos serão registradas automaticamente.</p></div>}
      </div></section>
    </div>
  </div>;
}

function MemberCompanyAccess({ member, companies, busy, onSave }: { member: WorkspaceSnapshot["members"][number]; companies: WorkspaceSnapshot["companies"]; busy: boolean; onSave: (userId: string, companyIds: string[]) => Promise<void> }) {
  const [selectedIds, setSelectedIds] = useState<string[]>(member.companyIds);
  if (member.role === "admin") return <span className="member-company-summary">Todas as empresas</span>;
  return <details className="member-company-access"><summary>{selectedIds.length ? `${selectedIds.length} empresa(s) liberada(s)` : "Nenhuma empresa liberada"}</summary><div>{companies.map((company) => <label key={company.id}><input type="checkbox" checked={selectedIds.includes(company.id)} disabled={busy} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, company.id] : current.filter((id) => id !== company.id))} />{company.isPrincipal ? "★ " : "↳ "}{company.tradeName || company.legalName}</label>)}</div><button type="button" disabled={busy} onClick={() => void onSave(member.userId, selectedIds)}>Salvar empresas</button></details>;
}

function ProcessTablesView({ cards, lists, onOpen }: { cards: Card[]; lists: WorkspaceSnapshot["lists"]; onOpen: (card: Card) => void }) {
  const grouped = cards.reduce<Record<string, Card[]>>((accumulator, card) => {
    (accumulator[card.processType] ??= []).push(card);
    return accumulator;
  }, {});
  const processNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
  return <div className="process-tables-view">{processNames.length === 0 && <div className="empty-view"><span>▤</span><strong>Nenhuma demanda encontrada</strong><p>Crie uma demanda para iniciar uma tabela de processo.</p></div>}{processNames.map((process) => <section key={process}><header><div><span>FLUXO ESPECÍFICO</span><strong>{process}</strong></div><b>{grouped[process].length} demanda(s)</b></header><DemandTableView cards={grouped[process]} lists={lists} onOpen={onOpen} /></section>)}</div>;
}

function CompanySettings({ companies, members, busy, onCreateCompany, onDeleteCompany, onOpenAccess }: { companies: WorkspaceSnapshot["companies"]; members: WorkspaceSnapshot["members"]; busy: boolean; onCreateCompany: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onDeleteCompany: (id: string, name: string) => void; onOpenAccess: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const companyName = new Map(companies.map((company) => [company.id, company.tradeName || company.legalName]));
  const principalCompanies = companies.filter((company) => company.isPrincipal);
  const orderedCompanies = [...companies].sort((a, b) => Number(b.isPrincipal) - Number(a.isPrincipal) || (companyName.get(a.parentCompanyId ?? "") ?? "").localeCompare(companyName.get(b.parentCompanyId ?? "") ?? "") || (a.tradeName || a.legalName).localeCompare(b.tradeName || b.legalName));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await onCreateCompany({ legalName: data.get("legalName"), tradeName: data.get("tradeName"), taxId: data.get("taxId"), externalCode: data.get("externalCode"), email: data.get("email"), phone: data.get("phone"), companyType: data.get("companyType"), parentCompanyId: data.get("parentCompanyId") });
    if (result) { event.currentTarget.reset(); setShowForm(false); }
  }

  return <div className="company-settings-view">
    <section className="company-settings-intro">
      <span><Building2 aria-hidden="true" /></span><div><strong>Empresas do grupo</strong><p>Cadastre a empresa principal e os CNPJs vinculados. Esses cadastros ficam disponíveis para demandas, folha, permissões e integrações.</p></div><b>{companies.length} empresa(s)</b>
    </section>
    <section className="company-settings-access"><div><strong>Controle de acesso por empresa</strong><p>Após cadastrar um CNPJ, escolha quais usuários poderão consultar ou operar demandas daquela empresa.</p></div><button className="secondary-button" onClick={onOpenAccess}><Users aria-hidden="true" /> Gerenciar usuários e acessos</button></section>
    <section className="company-settings-catalog">
      <header><div><strong>Cadastros do grupo</strong><span>CNPJ, estrutura societária, contato e código externo para Sankhya.</span></div><button className="primary-button" disabled={busy} onClick={() => setShowForm((current) => !current)}><Plus aria-hidden="true" /> {showForm ? "Fechar cadastro" : "Cadastrar empresa"}</button></header>
      {showForm && <form className="company-settings-form" onSubmit={submit}>
        <label>Tipo<select name="companyType" defaultValue={companies.some((company) => company.isPrincipal) ? "subsidiary" : "principal"} disabled={busy}><option value="principal">Empresa principal do grupo</option><option value="subsidiary">Empresa / CNPJ do grupo</option></select></label>
        <label>Empresa principal<select name="parentCompanyId" defaultValue="" disabled={busy}><option value="">Vincular à principal automaticamente</option>{principalCompanies.map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
        <label>Razão social<input name="legalName" placeholder="Empresa Exemplo Ltda." maxLength={160} required disabled={busy} /></label>
        <label>Nome fantasia<input name="tradeName" placeholder="Empresa Exemplo" maxLength={160} disabled={busy} /></label>
        <label>CNPJ<input name="taxId" placeholder="00.000.000/0001-00" maxLength={30} disabled={busy} /></label>
        <label>Código Sankhya<input name="externalCode" placeholder="COD_EMPRESA" maxLength={80} disabled={busy} /></label>
        <label>E-mail<input type="email" name="email" maxLength={160} disabled={busy} /></label>
        <label>Telefone<input name="phone" maxLength={40} disabled={busy} /></label>
        <button className="primary-button" disabled={busy}>Salvar empresa</button>
      </form>}
      <div className="company-settings-list">
        {orderedCompanies.length === 0 && <div className="empty-view"><span><Building2 aria-hidden="true" /></span><strong>Nenhuma empresa cadastrada</strong><p>Cadastre a empresa principal para estruturar o grupo e liberar acessos.</p></div>}
        {orderedCompanies.map((company) => {
          const allowedMembers = members.filter((member) => member.role === "admin" || member.companyIds.includes(company.id)).length;
          return <article className={company.isPrincipal ? "principal" : "subsidiary"} key={company.id}><i>{company.isPrincipal ? "P" : "↳"}</i><div><strong>{company.tradeName || company.legalName}{company.isPrincipal && <em>Principal</em>}</strong><small>{company.isPrincipal ? "Empresa raiz do grupo" : `Grupo: ${companyName.get(company.parentCompanyId ?? "") ?? "Principal"}`} · {company.taxId || "CNPJ não informado"}</small></div><span><small>Usuários com acesso</small><b>{allowedMembers}</b></span><span><small>Sankhya</small><b>{company.externalCode || "Não vinculado"}</b></span><button className="danger-link" type="button" disabled={busy} onClick={() => onDeleteCompany(company.id, company.legalName)}>Excluir</button></article>;
        })}
      </div>
    </section>
  </div>;
}

function PayrollView({ companies, metrics, busy, canEdit, onSaveMetric }: { companies: WorkspaceSnapshot["companies"]; metrics: WorkspaceSnapshot["hrMetrics"]; busy: boolean; canEdit: boolean; onSaveMetric: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null> }) {
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const [selectedPeriod, setSelectedPeriod] = useState(currentPeriod);
  const [form, setForm] = useState({
    companyId: companies.find((company) => company.status === "active")?.id ?? "", period: currentPeriod,
    headcountStart: "0", headcountEnd: "0", leavesCount: "0", admissions: "0", voluntaryTerminations: "0", involuntaryTerminations: "0",
    baseSalary: "0", variablePay: "0", overtimePay: "0", additionalPay: "0", vacationPay: "0", thirteenthPay: "0", terminationPay: "0",
    employeeInss: "0", employeeIrrf: "0", employeeOtherDeductions: "0",
    employerInss: "0", ratContribution: "0", thirdPartyContributions: "0", fgts: "0", fgtsPenalty: "0",
    benefitsCost: "0", provisionsCost: "0", otherCosts: "0", notes: "",
  });
  const companyName = new Map(companies.map((company) => [company.id, company.tradeName || company.legalName]));
  const periods = [...new Set([currentPeriod, ...metrics.map((metric) => metric.period)])].sort((a, b) => b.localeCompare(a));
  const selectedMetrics = metrics.filter((metric) => metric.period === selectedPeriod);
  const toNumber = (value: string | number) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const totalCost = selectedMetrics.reduce((total, metric) => total + metric.payrollCost, 0);
  const totalHeadcount = selectedMetrics.reduce((total, metric) => total + metric.headcount, 0);
  const totalAdmissions = selectedMetrics.reduce((total, metric) => total + metric.admissions, 0);
  const totalTerminations = selectedMetrics.reduce((total, metric) => total + metric.terminations, 0);
  const turnover = totalHeadcount ? ((totalAdmissions + totalTerminations) / 2 / totalHeadcount) * 100 : 0;
  const costPerEmployee = totalHeadcount ? totalCost / totalHeadcount : 0;
  const componentTotals = [
    { label: "Remuneração bruta", value: selectedMetrics.reduce((total, metric) => total + metric.grossPayroll, 0), color: "#62D5B2" },
    { label: "Encargos", value: selectedMetrics.reduce((total, metric) => total + metric.employerCharges, 0), color: "#73b8ff" },
    { label: "Benefícios", value: selectedMetrics.reduce((total, metric) => total + metric.benefitsCost, 0), color: "#b99cff" },
    { label: "Provisões e outros", value: selectedMetrics.reduce((total, metric) => total + metric.provisionsCost + metric.otherCosts, 0), color: "#F4A261" },
  ];
  const formHeadcount = (toNumber(form.headcountStart) + toNumber(form.headcountEnd)) / 2;
  const formTerminations = toNumber(form.voluntaryTerminations) + toNumber(form.involuntaryTerminations);
  const formGrossPayroll = toNumber(form.baseSalary) + toNumber(form.variablePay) + toNumber(form.overtimePay) + toNumber(form.additionalPay) + toNumber(form.vacationPay) + toNumber(form.thirteenthPay) + toNumber(form.terminationPay);
  const formDeductions = toNumber(form.employeeInss) + toNumber(form.employeeIrrf) + toNumber(form.employeeOtherDeductions);
  const formNetPay = Math.max(0, formGrossPayroll - formDeductions);
  const formEmployerCharges = toNumber(form.employerInss) + toNumber(form.ratContribution) + toNumber(form.thirdPartyContributions) + toNumber(form.fgts) + toNumber(form.fgtsPenalty);
  const formTotal = formGrossPayroll + formEmployerCharges + toNumber(form.benefitsCost) + toNumber(form.provisionsCost) + toNumber(form.otherCosts);
  const expectedHeadcount = Math.max(0, toNumber(form.headcountStart) + toNumber(form.admissions) - formTerminations);
  const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  type NumericFormKey = Exclude<keyof typeof form, "companyId" | "period" | "notes">;
  const numericField = (label: string, key: NumericFormKey, step = "1") => <label key={key}>{label}<input type="number" min="0" step={step} value={form[key]} disabled={busy} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await onSaveMetric({ ...form, headcount: formHeadcount, terminations: formTerminations, grossPayroll: formGrossPayroll, employerCharges: formEmployerCharges, netPay: formNetPay, payrollCost: formTotal, source: "manual" });
    if (result) setForm((current) => ({ ...current, headcountStart: "0", headcountEnd: "0", leavesCount: "0", admissions: "0", voluntaryTerminations: "0", involuntaryTerminations: "0", baseSalary: "0", variablePay: "0", overtimePay: "0", additionalPay: "0", vacationPay: "0", thirteenthPay: "0", terminationPay: "0", employeeInss: "0", employeeIrrf: "0", employeeOtherDeductions: "0", employerInss: "0", ratContribution: "0", thirdPartyContributions: "0", fgts: "0", fgtsPenalty: "0", benefitsCost: "0", provisionsCost: "0", otherCosts: "0", notes: "" }));
  }

  return <div className="payroll-view">
    <section className="payroll-toolbar"><div><span>COMPETÊNCIA</span><h2>Painel consolidado da folha</h2><p>Os indicadores são recalculados automaticamente a cada lançamento ou sincronização do Sankhya.</p></div><label>Período<select value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}>{periods.map((period) => <option key={period}>{period}</option>)}</select></label></section>
    <section className="payroll-kpi-grid"><article><WalletCards aria-hidden="true" /><span>Custo total da folha</span><strong>{money(totalCost)}</strong><small>{selectedMetrics.length} empresa(s) com competência</small></article><article><Users aria-hidden="true" /><span>Headcount médio</span><strong>{totalHeadcount}</strong><small>{totalAdmissions} admissões · {totalTerminations} desligamentos</small></article><article><BarChart3 aria-hidden="true" /><span>Turnover</span><strong>{turnover.toFixed(2)}%</strong><small>Movimentação ÷ headcount médio</small></article><article><Building2 aria-hidden="true" /><span>Custo por colaborador</span><strong>{money(costPerEmployee)}</strong><small>Baseado no headcount médio</small></article></section>
    <div className="payroll-layout">
      <section className="payroll-composition"><header><div><strong>Composição do custo</strong><span>Distribuição da competência selecionada</span></div><b>{money(totalCost)}</b></header><div className="payroll-bars">{componentTotals.map((item) => <div key={item.label}><span><strong>{item.label}</strong><small>{money(item.value)}</small></span><i><b style={{ width: `${totalCost ? Math.min(100, (item.value / totalCost) * 100) : 0}%`, backgroundColor: item.color }} /></i></div>)}</div></section>
      <section className="payroll-company-breakdown"><header><div><strong>Folha por empresa</strong><span>{selectedMetrics.length} lançamento(s) em {selectedPeriod}</span></div></header>{selectedMetrics.length === 0 && <div className="empty-view"><span><WalletCards aria-hidden="true" /></span><strong>Sem lançamentos nesta competência</strong><p>Registre os dados da folha para gerar os indicadores automaticamente.</p></div>}{selectedMetrics.map((metric) => <article key={metric.id}><div><strong>{companyName.get(metric.companyId) ?? "Empresa removida"}</strong><small>{metric.headcount} colaboradores · {metric.admissions} admissões · {metric.terminations} desligamentos · líquido {money(metric.netPay)}</small></div><span>{money(metric.payrollCost)}</span><b>{metric.source === "sankhya" ? "Sankhya" : "Manual"}</b></article>)}</section>
    </div>
    {canEdit && <section className="payroll-entry-panel"><header><div><span>NOVO LANÇAMENTO</span><h2>Registrar dados da folha</h2><p>Informe os valores já apurados na folha ou ERP. O sistema consolida custos e indicadores, sem aplicar alíquotas legais por conta própria.</p></div><b>Total calculado: {money(formTotal)}</b></header><form onSubmit={(event) => void submit(event)}>
      <label>Empresa<select value={form.companyId} required disabled={busy} onChange={(event) => setForm({ ...form, companyId: event.target.value })}><option value="" disabled>Selecione</option>{companies.filter((company) => company.status === "active").map((company) => <option value={company.id} key={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
      <label>Competência<input type="month" value={form.period} required disabled={busy} onChange={(event) => setForm({ ...form, period: event.target.value })} /></label>
      <fieldset className="payroll-form-section"><legend>Pessoas e movimentação</legend>{numericField("Headcount no início", "headcountStart")}{numericField("Headcount no fim", "headcountEnd")}{numericField("Afastados no período", "leavesCount")}{numericField("Admissões", "admissions")}{numericField("Desligamentos voluntários", "voluntaryTerminations")}{numericField("Desligamentos involuntários", "involuntaryTerminations")}<p>Headcount médio: <strong>{formHeadcount.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</strong> · encerramento esperado: <strong>{expectedHeadcount.toLocaleString("pt-BR")}</strong></p></fieldset>
      <fieldset className="payroll-form-section"><legend>Proventos da competência</legend>{numericField("Salário-base", "baseSalary", "0.01")}{numericField("Variáveis / comissões", "variablePay", "0.01")}{numericField("Horas extras", "overtimePay", "0.01")}{numericField("Adicionais", "additionalPay", "0.01")}{numericField("Férias + 1/3", "vacationPay", "0.01")}{numericField("13º salário", "thirteenthPay", "0.01")}{numericField("Verbas rescisórias", "terminationPay", "0.01")}<p>Remuneração bruta calculada: <strong>{money(formGrossPayroll)}</strong></p></fieldset>
      <fieldset className="payroll-form-section"><legend>Descontos do colaborador</legend>{numericField("INSS do colaborador", "employeeInss", "0.01")}{numericField("IRRF", "employeeIrrf", "0.01")}{numericField("Outros descontos", "employeeOtherDeductions", "0.01")}<p>Descontos: <strong>{money(formDeductions)}</strong> · líquido calculado: <strong>{money(formNetPay)}</strong></p></fieldset>
      <fieldset className="payroll-form-section"><legend>Encargos do empregador</legend>{numericField("INSS patronal", "employerInss", "0.01")}{numericField("RAT", "ratContribution", "0.01")}{numericField("Terceiros", "thirdPartyContributions", "0.01")}{numericField("FGTS", "fgts", "0.01")}{numericField("Multa de FGTS", "fgtsPenalty", "0.01")}<p>Encargos patronais calculados: <strong>{money(formEmployerCharges)}</strong></p></fieldset>
      <fieldset className="payroll-form-section"><legend>Custos complementares</legend>{numericField("Benefícios", "benefitsCost", "0.01")}{numericField("Provisões", "provisionsCost", "0.01")}{numericField("Outros custos", "otherCosts", "0.01")}<p>Use provisões para férias, 13º e demais ajustes que sua operação acompanhar separadamente.</p></fieldset>
      <div className="payroll-live-totals" aria-live="polite"><span>Bruto<strong>{money(formGrossPayroll)}</strong></span><span>Descontos<strong>{money(formDeductions)}</strong></span><span>Líquido<strong>{money(formNetPay)}</strong></span><span>Encargos<strong>{money(formEmployerCharges)}</strong></span><span>Custo total<strong>{money(formTotal)}</strong></span></div>
      <label className="wide">Observações<textarea rows={3} maxLength={500} value={form.notes} disabled={busy} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Ex.: ajuste de competência, acordo coletivo ou variação relevante" /></label><button className="primary-button" disabled={busy || !form.companyId}><WalletCards aria-hidden="true" /> Salvar e atualizar painel</button>
    </form></section>}
  </div>;
}

export function LegacyCompaniesView({ companies, metrics, cards, busy, canEdit, onCreateCompany, onDeleteCompany, onSaveMetric, onOpenCard }: { companies: WorkspaceSnapshot["companies"]; metrics: WorkspaceSnapshot["hrMetrics"]; cards: Card[]; busy: boolean; canEdit: boolean; onCreateCompany: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onDeleteCompany: (id: string, name: string) => void; onSaveMetric: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onOpenCard: (card: Card) => void }) {
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [showMetricForm, setShowMetricForm] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  async function submitCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await onCreateCompany({ legalName: data.get("legalName"), tradeName: data.get("tradeName"), taxId: data.get("taxId"), externalCode: data.get("externalCode"), email: data.get("email"), phone: data.get("phone"), companyType: data.get("companyType"), parentCompanyId: data.get("parentCompanyId") });
    if (result) { event.currentTarget.reset(); setShowCompanyForm(false); }
  }
  async function submitMetric(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await onSaveMetric({ companyId: data.get("companyId"), period: data.get("period"), headcount: data.get("headcount"), admissions: data.get("admissions"), terminations: data.get("terminations"), payrollCost: data.get("payrollCost"), source: "manual" });
    if (result) { event.currentTarget.reset(); setShowMetricForm(false); }
  }
  const companyName = new Map(companies.map((company) => [company.id, company.tradeName || company.legalName]));
  const principalCompanies = companies.filter((company) => company.isPrincipal);
  const subsidiaryCompanies = companies.filter((company) => !company.isPrincipal).sort((a, b) => (companyName.get(a.parentCompanyId ?? "") ?? "").localeCompare(companyName.get(b.parentCompanyId ?? "") ?? "") || (a.tradeName || a.legalName).localeCompare(b.tradeName || b.legalName));
  const orderedCompanies = [...principalCompanies, ...subsidiaryCompanies];
  const latest = metrics.slice(0, 12);
  const activeCompanies = companies.filter((company) => company.status === "active").length;
  const payrollTotal = latest.reduce((total, metric) => total + metric.payrollCost, 0);
  const selectedCompany = companies.find((company) => company.id === selectedCompanyId) ?? companies[0] ?? null;
  const companyCards = selectedCompany ? cards.filter((card) => card.companyId === selectedCompany.id) : [];
  const companyDocumentPending = companyCards.reduce((total, card) => total + card.checklist.filter((item) => !item.completed).length, 0);
  const companyMetrics = selectedCompany ? metrics.filter((metric) => metric.companyId === selectedCompany.id).sort((a, b) => b.period.localeCompare(a.period)) : [];
  return <div className="companies-view">
    <div className="companies-toolbar"><div><strong>Grupo empresarial</strong><span>Defina a empresa principal e cadastre os CNPJs do grupo para demandas, folha e indicadores.</span></div><div className="companies-actions">{canEdit && <><button className="primary-button" onClick={() => setShowCompanyForm((value) => !value)}><Plus aria-hidden="true" /> Cadastrar empresa</button><button className="secondary-button" onClick={() => setShowMetricForm((value) => !value)}><WalletCards aria-hidden="true" /> Registrar folha</button></>}</div></div>
    <div className="companies-overview"><article><Building2 aria-hidden="true" /><div><strong>{activeCompanies}</strong><span>Empresas ativas</span></div></article><article><CalendarClock aria-hidden="true" /><div><strong>{metrics.length}</strong><span>Competências registradas</span></div></article><article><WalletCards aria-hidden="true" /><div><strong>{payrollTotal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong><span>Folha nos registros recentes</span></div></article></div>
    {selectedCompany && <section className="company-profile-card"><header><div><span>{selectedCompany.isPrincipal ? "EMPRESA PRINCIPAL DO GRUPO" : "EMPRESA DO GRUPO"}</span><h2>{selectedCompany.tradeName || selectedCompany.legalName}</h2><p>{selectedCompany.legalName}</p></div><em className={selectedCompany.status}>{selectedCompany.status === "active" ? "Ativa" : "Inativa"}</em></header><div className="company-profile-data"><div><span>Estrutura</span><strong>{selectedCompany.isPrincipal ? "Empresa principal" : companyName.get(selectedCompany.parentCompanyId ?? "") || "Grupo principal"}</strong></div><div><span>CNPJ</span><strong>{selectedCompany.taxId || "Não informado"}</strong></div><div><span>Contato</span><strong>{selectedCompany.email || selectedCompany.phone || "Não informado"}</strong></div><div><span>Código Sankhya</span><strong>{selectedCompany.externalCode || "Não vinculado"}</strong></div><div><span>Demandas abertas</span><strong>{companyCards.filter((card) => card.slaStatus !== "completed").length}</strong></div><div><span>Documentos pendentes</span><strong>{companyDocumentPending}</strong></div><div><span>Última folha</span><strong>{companyMetrics[0] ? companyMetrics[0].payrollCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "Sem registro"}</strong></div></div><div className="company-profile-demands"><strong>Demandas relacionadas</strong>{companyCards.slice(0, 4).map((card) => <button key={card.id} onClick={() => onOpenCard(card)}><i className={card.slaStatus} /><span>{card.title}<small>{card.processType} • {slaLabel(card)}</small></span><ArrowRight aria-hidden="true" /></button>)}{companyCards.length === 0 && <p>Não há demandas vinculadas a esta empresa.</p>}</div></section>}
    {showCompanyForm && <form className="company-form catalog-card" onSubmit={submitCompany}><header><div><strong>Cadastro no grupo empresarial</strong><span>A primeira empresa será definida como principal. As demais podem ser vinculadas a ela.</span></div></header><div className="catalog-form"><label>Tipo<select name="companyType" defaultValue={companies.some((company) => company.isPrincipal) ? "subsidiary" : "principal"}><option value="principal">Empresa principal do grupo</option><option value="subsidiary">Empresa / CNPJ do grupo</option></select></label><label>Empresa principal<select name="parentCompanyId" defaultValue=""><option value="">Vincular à principal automaticamente</option>{principalCompanies.map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label><label>Razão social<input name="legalName" required placeholder="Empresa Exemplo Ltda." /></label><label>Nome fantasia<input name="tradeName" placeholder="Empresa Exemplo" /></label><label>CNPJ<input name="taxId" placeholder="00.000.000/0001-00" /></label><label>Código Sankhya<input name="externalCode" placeholder="COD_EMPRESA" /></label><label>E-mail<input type="email" name="email" /></label><label>Telefone<input name="phone" /></label><button className="primary-button" disabled={busy}>Salvar empresa</button></div></form>}
    {showMetricForm && <form className="metric-form catalog-card" onSubmit={submitMetric}><header><div><strong>Registrar custo e movimentação da folha</strong><span>Turnover = (admissões + desligamentos) ÷ 2 ÷ headcount médio.</span></div></header><div className="catalog-form"><label>Empresa<select name="companyId" required defaultValue=""><option value="" disabled>Selecione</option>{companies.filter((company) => company.status === "active").map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label><label>Competência<input type="month" name="period" required defaultValue={new Date().toISOString().slice(0, 7)} /></label><label>Headcount<input type="number" name="headcount" min="0" defaultValue="0" /></label><label>Admissões<input type="number" name="admissions" min="0" defaultValue="0" /></label><label>Desligamentos<input type="number" name="terminations" min="0" defaultValue="0" /></label><label>Custo da folha<input type="number" name="payrollCost" min="0" step="0.01" defaultValue="0" /></label><button className="primary-button" disabled={busy || companies.length === 0}>Salvar competência</button></div></form>}
    <section className="companies-list catalog-card"><header><div><strong>Empresas do grupo</strong><span>{companies.length} empresa(s) • vínculo para demandas e indicadores</span></div></header>{companies.length === 0 && <div className="empty-view"><span><Building2 aria-hidden="true" /></span><strong>Nenhuma empresa cadastrada</strong><p>Cadastre a empresa principal do grupo para começar.</p></div>}{orderedCompanies.map((company) => <article className={`${selectedCompany?.id === company.id ? "selected" : ""}${company.isPrincipal ? " principal" : " subsidiary"}`} key={company.id} tabIndex={0} role="button" onClick={() => setSelectedCompanyId(company.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedCompanyId(company.id); }}><i aria-hidden="true">{company.isPrincipal ? "P" : "↳"}</i><div><strong>{company.tradeName || company.legalName}{company.isPrincipal && <em>Principal</em>}</strong><small>{company.isPrincipal ? "Empresa raiz do grupo" : `Grupo: ${companyName.get(company.parentCompanyId ?? "") ?? "Principal"}`} • {company.taxId || "CNPJ não informado"}</small></div><span>{company.email || company.phone || "Sem contato"}</span>{canEdit && <button disabled={busy} onClick={(event) => { event.stopPropagation(); void onDeleteCompany(company.id, company.legalName); }} aria-label={`Excluir ${company.tradeName || company.legalName}`}><Trash2 aria-hidden="true" /><span>Excluir</span></button>}</article>)}</section>
    <section className="metrics-list catalog-card"><header><div><strong>Histórico de folha</strong><span>{metrics.length} competência(s) registrada(s)</span></div></header>{latest.length === 0 && <div className="empty-view"><span><WalletCards aria-hidden="true" /></span><strong>Nenhum indicador de folha</strong><p>Registre uma competência ou conecte o Sankhya.</p></div>}{latest.map((metric) => <article key={metric.id}><div><strong>{companyName.get(metric.companyId) ?? "Empresa removida"}</strong><small>{metric.period} • origem {metric.source}</small></div><span>{metric.headcount} colaboradores</span><span>{metric.admissions} admissões / {metric.terminations} desligamentos</span><b>{metric.payrollCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</b></article>)}</section>
  </div>;
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

function ListsSettings({ snapshot, busy, isAdmin, onMutate, onConfirm }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onMutate: SnapshotMutation; onConfirm: ConfirmHandler }) {
  const [deleteTargets, setDeleteTargets] = useState<Record<string, string>>({});
  const lists = [...snapshot.lists].sort((a, b) => a.position - b.position);
  const behaviorLabel: Record<string, string> = { running: "SLA em andamento", paused: "SLA pausado", completed: "SLA concluído" };

  async function createList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = await onMutate("/api/lists", { method: "POST", body: JSON.stringify({ boardId: snapshot.board.id, name: data.get("name"), slaBehavior: data.get("slaBehavior") }) }, "Coluna criada no quadro.");
    if (next) form.reset();
  }

  async function saveList(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onMutate(`/api/lists/${id}`, { method: "PATCH", body: JSON.stringify({ name: data.get("name"), slaBehavior: data.get("slaBehavior") }) }, "Coluna atualizada.");
  }

  async function reorder(listId: string, direction: -1 | 1) {
    const index = lists.findIndex((list) => list.id === listId);
    const neighbour = lists[index + direction];
    const current = lists[index];
    if (!current || !neighbour) return;
    const first = await onMutate(`/api/lists/${current.id}`, { method: "PATCH", body: JSON.stringify({ position: neighbour.position }) }, "Ordem da coluna atualizada.");
    if (first) await onMutate(`/api/lists/${neighbour.id}`, { method: "PATCH", body: JSON.stringify({ position: current.position }) });
  }

  function removeList(listId: string, listName: string, cards: number) {
    const moveToListId = deleteTargets[listId] ?? "";
    if (cards > 0 && !moveToListId) return;
    onConfirm({
      title: "Excluir coluna?",
      description: cards > 0 ? `${cards} demanda(s) serão transferidas para a coluna selecionada antes da exclusão.` : `A coluna “${listName}” será removida do quadro.`,
      confirmLabel: "Excluir coluna",
      action: () => onMutate(`/api/lists/${listId}`, { method: "DELETE", body: cards > 0 ? JSON.stringify({ moveToListId }) : undefined }, "Coluna excluída com segurança."),
    });
  }

  return <div className="settings-stack"><section className="catalog-section list-manager"><header><div><strong>Colunas do quadro</strong><span>Renomeie, ordene, controle o SLA e mova demandas com segurança antes de excluir.</span></div><b>{lists.length}</b></header><div className="list-manager-items">{lists.map((list, index) => <form key={list.id} onSubmit={(event) => void saveList(event, list.id)}><div className="list-order-controls"><button type="button" disabled={!isAdmin || busy || index === 0} onClick={() => void reorder(list.id, -1)} aria-label={`Mover ${list.name} para a esquerda`}>↑</button><button type="button" disabled={!isAdmin || busy || index === lists.length - 1} onClick={() => void reorder(list.id, 1)} aria-label={`Mover ${list.name} para a direita`}>↓</button></div><label>Nome<input name="name" defaultValue={list.name} maxLength={80} disabled={!isAdmin || busy} required /></label><label>SLA<select name="slaBehavior" defaultValue={list.slaBehavior} disabled={!isAdmin || busy}><option value="running">Em andamento</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label><small>{list.cards.length} demanda(s) · {behaviorLabel[list.slaBehavior]}</small>{isAdmin && <><button className="secondary-button" disabled={busy}>Salvar</button>{list.cards.length > 0 && <label className="list-transfer">Mover para<select value={deleteTargets[list.id] ?? ""} disabled={busy} onChange={(event) => setDeleteTargets((current) => ({ ...current, [list.id]: event.target.value }))}><option value="">Escolha antes de excluir</option>{lists.filter((target) => target.id !== list.id).map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label>}<button type="button" className="danger-link list-delete" disabled={busy || (list.cards.length > 0 && !deleteTargets[list.id])} onClick={() => removeList(list.id, list.name, list.cards.length)}>Excluir</button></>}</form>)}</div></section>{isAdmin && <section className="catalog-section"><header><div><strong>Nova coluna</strong><span>Use uma coluna com SLA pausado apenas quando houver uma justificativa operacional.</span></div></header><form className="catalog-form list-create-form" onSubmit={createList}><label>Nome da coluna<input name="name" placeholder="Ex.: Aguardando aprovação" maxLength={80} required /></label><label>Comportamento do SLA<select name="slaBehavior" defaultValue="running"><option value="running">Em andamento</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label><button className="primary-button" disabled={busy}>Criar coluna</button></form></section>}</div>;
}

function FieldsSettings({ snapshot, busy, isAdmin, onCatalog, onConfirm }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler; onConfirm: ConfirmHandler }) {
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
  return (
    <div className="settings-stack">
      <section className="catalog-section">
        <header><div><strong>Etiquetas operacionais</strong><span>Cores para urgência, área ou classificação complementar.</span></div><b>{snapshot.labels.length}</b></header>
        <div className="label-catalog">
          {snapshot.labels.map((label) => <article key={label.id}><i style={{ backgroundColor: label.color }} /><strong>{label.name}</strong>{isAdmin && <button disabled={busy} onClick={() => onConfirm({ title: "Excluir etiqueta?", description: `A etiqueta “${label.name}” será removida da operação.`, confirmLabel: "Excluir etiqueta", action: () => onCatalog({ resource: "label", operation: "delete", id: label.id }, "Etiqueta excluída.") })} aria-label={`Excluir ${label.name}`}>×</button>}</article>)}
        </div>
        {isAdmin && <form className="catalog-form compact" onSubmit={createLabel}><label>Nome<input name="name" maxLength={40} placeholder="Ex.: Urgente" required /></label><label>Cor<select name="color" defaultValue="#dc2626"><option value="#dc2626">Vermelho</option><option value="#ea580c">Laranja</option><option value="#d97706">Amarelo</option><option value="#16a34a">Verde</option><option value="#0891b2">Ciano</option><option value="#2563eb">Azul</option><option value="#7c3aed">Roxo</option><option value="#64748b">Cinza</option></select></label><button className="primary-button" disabled={busy}>Adicionar</button></form>}
      </section>
      <section className="catalog-section">
        <header><div><strong>Campos personalizados</strong><span>Dados estruturados visíveis nos cartões de DP.</span></div><b>{snapshot.customFields.length}</b></header>
        <div className="field-catalog">
          {snapshot.customFields.map((field) => <article key={field.id}><div><strong>{field.name}{field.required && <em>Obrigatório</em>}</strong><small>{field.fieldKey} • {field.fieldType}{field.options.length ? ` • ${field.options.join(", ")}` : ""}</small></div>{isAdmin && <button disabled={busy} onClick={() => onConfirm({ title: "Excluir campo?", description: `O campo “${field.name}” deixará de estar disponível nas demandas.`, confirmLabel: "Excluir campo", action: () => onCatalog({ resource: "field", operation: "delete", id: field.id }, "Campo excluído.") })} aria-label={`Excluir ${field.name}`}>×</button>}</article>)}
        </div>
        {isAdmin && <form className="catalog-form fields-form" onSubmit={createField}><label>Nome<input name="name" placeholder="Ex.: Matrícula" maxLength={60} required /></label><label>Identificador<input name="fieldKey" placeholder="matricula" pattern="[A-Za-z0-9_]+" required /></label><label>Tipo<select name="fieldType" defaultValue="text"><option value="text">Texto</option><option value="number">Número</option><option value="date">Data</option><option value="select">Lista</option></select></label><label className="wide">Opções da lista<input name="options" placeholder="Opção 1, Opção 2" /></label><label className="catalog-check"><input type="checkbox" name="required" /> Obrigatório</label><button className="primary-button" disabled={busy}>Criar campo</button></form>}
      </section>
    </div>
  );
}

function TemplatesSettings({ snapshot, busy, isAdmin, onCatalog, onConfirm, onUseTemplate }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler; onConfirm: ConfirmHandler; onUseTemplate: (id: string) => void }) {
  async function createTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const checklist = String(data.get("checklist") ?? "").split("\n").map((item) => item.trim()).filter(Boolean);
    const next = await onCatalog({ resource: "template", name: data.get("name"), processType: data.get("processType"), description: data.get("description"), checklist, defaultSlaDays: Number(data.get("defaultSlaDays")) }, "Template criado.");
    if (next) form.reset();
  }
  return (
    <div className="settings-stack">
      <section className="catalog-section">
        <header><div><strong>Templates de processos</strong><span>Checklists e SLA prontos para iniciar uma demanda sem esquecer etapas.</span></div><b>{snapshot.templates.length}</b></header>
        <div className="template-catalog">
          {snapshot.templates.map((template) => <article key={template.id}><div><span>{template.processType}</span><strong>{template.name}</strong><small>{template.checklist.length} etapa(s) • SLA de {template.defaultSlaDays} dia(s) útil(eis)</small></div><button onClick={() => onUseTemplate(template.id)}>Usar</button>{isAdmin && <button className="danger" disabled={busy} onClick={() => onConfirm({ title: "Excluir template?", description: `O template “${template.name}” e seu checklist padrão serão removidos.`, confirmLabel: "Excluir template", action: () => onCatalog({ resource: "template", operation: "delete", id: template.id }, "Template excluído.") })}>Excluir</button>}</article>)}
        </div>
      </section>
      {isAdmin && <section className="catalog-section"><header><div><strong>Novo template</strong><span>Uma etapa por linha no checklist.</span></div></header><form className="catalog-form template-form" onSubmit={createTemplate}><label>Nome<input name="name" placeholder="Ex.: Conciliação cadastral" required /></label><label>Processo<select name="processType" defaultValue="CONCILIAÇÃO CADASTRAL"><option>CONCILIAÇÃO CADASTRAL</option><option>FÉRIAS</option><option>RESCISÃO</option><option>BENEFÍCIOS</option><option>FOLHA</option><option>CADASTRO</option><option>OUTROS</option></select></label><label>SLA (dias úteis)<input type="number" min="1" max="60" name="defaultSlaDays" defaultValue="3" required /></label><label className="wide">Descrição<textarea name="description" rows={2} placeholder="Orientações para o processo" /></label><label className="wide">Etapas<textarea name="checklist" rows={7} placeholder={'Importar dados concluídos\nVincular registros\nTratar divergências'} required /></label><button className="primary-button" disabled={busy}>Salvar template</button></form></section>}
    </div>
  );
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

function RulesSettings({ snapshot, busy, isAdmin, onCatalog, onConfirm }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler; onConfirm: ConfirmHandler }) {
  type ConditionType = "always" | "processType" | "priority" | "toList";
  type ActionType = "moveTo" | "slaStatus" | "labelId";
  const triggerLabels: Record<string, string> = {
    "card.created": "uma demanda for criada",
    "card.moved": "uma demanda for movimentada",
    "assignee.added": "um responsável for atribuído",
    "checklist.completed": "todas as etapas forem concluídas",
    "sla.tick": "o SLA for avaliado",
  };
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("card.created");
  const [conditionType, setConditionType] = useState<ConditionType>("always");
  const [conditionValue, setConditionValue] = useState("");
  const [actionType, setActionType] = useState<ActionType>("moveTo");
  const [actionValue, setActionValue] = useState("");
  const [editorError, setEditorError] = useState("");

  const actionLabel = (action: Record<string, unknown>) => {
    if (typeof action.moveTo === "string") return `mover para ${snapshot.lists.find((list) => list.kind === action.moveTo)?.name ?? action.moveTo}`;
    if (typeof action.slaStatus === "string") return action.slaStatus === "overdue" ? "marcar SLA como atrasado" : action.slaStatus === "completed" ? "marcar como concluída" : action.slaStatus === "paused" ? "pausar o SLA" : "recalcular o SLA";
    if (typeof action.labelId === "string") return `aplicar etiqueta ${snapshot.labels.find((label) => label.id === action.labelId)?.name ?? "selecionada"}`;
    return "executar ação configurada";
  };
  const conditionLabel = (condition: Record<string, unknown>) => {
    if (condition.processType) return `processo é ${condition.processType}`;
    if (condition.priority) return `prioridade é ${condition.priority}`;
    if (condition.listKind) return `coluna é ${snapshot.lists.find((list) => list.kind === condition.listKind)?.name ?? condition.listKind}`;
    if (condition.assignee === "present") return "há responsável atribuído";
    if (condition.allItems === true) return "checklist completo";
    if (condition.dueAt === "past") return "prazo vencido";
    return "sem condição adicional";
  };
  const defaultActionFor = (nextTrigger: string): { type: ActionType; value: string } => {
    if (nextTrigger === "sla.tick") return { type: "slaStatus", value: "overdue" };
    if (nextTrigger === "checklist.completed") return { type: "moveTo", value: snapshot.lists.find((list) => list.kind === "done")?.kind ?? "" };
    if (nextTrigger === "assignee.added") return { type: "moveTo", value: snapshot.lists.find((list) => list.kind === "analysis")?.kind ?? "" };
    return { type: "moveTo", value: snapshot.lists[0]?.kind ?? "" };
  };
  function changeTrigger(nextTrigger: string) {
    setTrigger(nextTrigger);
    setConditionType("always");
    setConditionValue("");
    const nextAction = defaultActionFor(nextTrigger);
    setActionType(nextAction.type);
    setActionValue(nextAction.value);
  }
  function edit(rule?: WorkspaceSnapshot["rules"][number]) {
    setEditorOpen(true);
    setEditingId(rule?.id ?? null);
    setName(rule?.name ?? "");
    const nextTrigger = rule?.trigger ?? "card.created";
    setTrigger(nextTrigger);
    const condition = rule?.condition ?? {};
    if (typeof condition.processType === "string") { setConditionType("processType"); setConditionValue(condition.processType); }
    else if (typeof condition.priority === "string") { setConditionType("priority"); setConditionValue(condition.priority); }
    else if (typeof condition.listKind === "string") { setConditionType("toList"); setConditionValue(condition.listKind); }
    else { setConditionType("always"); setConditionValue(""); }
    const action = rule?.action ?? {};
    if (typeof action.slaStatus === "string") { setActionType("slaStatus"); setActionValue(action.slaStatus); }
    else if (typeof action.labelId === "string") { setActionType("labelId"); setActionValue(action.labelId); }
    else if (typeof action.moveTo === "string") { setActionType("moveTo"); setActionValue(action.moveTo); }
    else { const nextAction = defaultActionFor(nextTrigger); setActionType(nextAction.type); setActionValue(nextAction.value); }
    setEditorError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    if (!actionValue) { setEditorError("Escolha a ação que a automação deverá executar."); return; }
    const fixedCondition = trigger === "assignee.added" ? { assignee: "present" } : trigger === "checklist.completed" ? { allItems: true } : trigger === "sla.tick" ? { dueAt: "past" } : {};
    const condition = conditionType === "processType" ? { processType: conditionValue } : conditionType === "priority" ? { priority: conditionValue } : conditionType === "toList" ? { listKind: conditionValue } : fixedCondition;
    const action = actionType === "moveTo" ? { moveTo: actionValue } : actionType === "slaStatus" ? { slaStatus: actionValue } : { labelId: actionValue };
    const result = await onCatalog({ resource: "rule", operation: editingId ? "update" : "create", id: editingId ?? "", name, trigger, condition, action, enabled: true }, editingId ? "Automação atualizada." : "Automação criada.");
    if (result) setEditorOpen(false);
  }
  const showConditionSelector = trigger === "card.created" || trigger === "card.moved";
  const fixedConditionText = trigger === "assignee.added" ? "Só continua se houver um responsável atribuído." : trigger === "checklist.completed" ? "Só continua quando todas as etapas estiverem concluídas." : trigger === "sla.tick" ? "Só continua quando o prazo estiver vencido." : "Sem condição adicional.";

  return <div className="settings-stack"><section className="catalog-section rules-editor"><header><div><strong>Editor No-Code</strong><span>Regras ativas que executam tarefas automaticamente no fluxo do DP.</span></div>{isAdmin && <button className="secondary-button" onClick={() => edit()}><Plus aria-hidden="true" /> Nova regra</button>}</header><div className="rule-catalog no-code-rule-catalog">{snapshot.rules.length === 0 && <div className="empty-view"><span><ListChecks aria-hidden="true" /></span><strong>Nenhuma automação criada</strong><p>Crie uma regra para padronizar o fluxo da sua operação.</p></div>}{snapshot.rules.map((rule) => <article key={rule.id}><div><strong>{rule.name}</strong><div className="rule-flow"><span>Quando {triggerLabels[rule.trigger] ?? rule.trigger}</span><ArrowRight aria-hidden="true" /><span>Se {conditionLabel(rule.condition)}</span><ArrowRight aria-hidden="true" /><span>Então {actionLabel(rule.action)}</span></div></div>{isAdmin && <><button onClick={() => edit(rule)}>Editar</button><button className="danger" disabled={busy} onClick={() => onConfirm({ title: "Excluir automação?", description: `A regra “${rule.name}” deixará de ser executada na operação.`, confirmLabel: "Excluir automação", action: () => onCatalog({ resource: "rule", operation: "delete", id: rule.id }, "Automação excluída.") })}>Excluir</button></>}</article>)}</div></section>{isAdmin && editorOpen && <form className="catalog-section rule-editor-form no-code-editor" onSubmit={save}><header><div><strong>{editingId ? "Editar automação" : "Nova automação"}</strong><span>Escolha o evento, a condição e o resultado desejado. O sistema traduz isso para uma regra auditável.</span></div><button type="button" className="danger-link" onClick={() => setEditorOpen(false)}>Cancelar</button></header><div className="no-code-editor-body"><label className="wide">Nome da automação<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Ao concluir checklist, finalizar demanda" required /></label><section><span>1. Quando</span><label>Gatilho<select value={trigger} onChange={(event) => changeTrigger(event.target.value)}><option value="card.created">Uma demanda for criada</option><option value="card.moved">Uma demanda for movimentada</option><option value="assignee.added">Um responsável for atribuído</option><option value="checklist.completed">Todas as etapas forem concluídas</option><option value="sla.tick">O SLA estiver vencido</option></select></label></section><ArrowRight className="flow-arrow" aria-hidden="true" /><section><span>2. Se</span>{showConditionSelector ? <><label>Condição<select value={conditionType} onChange={(event) => { setConditionType(event.target.value as ConditionType); setConditionValue(""); }}><option value="always">Sem condição adicional</option>{trigger === "card.created" && <><option value="processType">O processo for</option><option value="priority">A prioridade for</option></>}{trigger === "card.moved" && <option value="toList">A coluna de destino for</option>}</select></label>{conditionType === "processType" && <label>Processo<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option>{["ADMISSÃO", "FÉRIAS", "RESCISÃO", "BENEFÍCIOS", "FOLHA", "CADASTRO", "OUTROS"].map((item) => <option key={item}>{item}</option>)}</select></label>}{conditionType === "priority" && <label>Prioridade<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>}{conditionType === "toList" && <label>Coluna<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.lists.map((list) => <option value={list.kind} key={list.id}>{list.name}</option>)}</select></label>}</> : <div className="fixed-rule-condition"><CheckCircle2 aria-hidden="true" />{fixedConditionText}</div>}</section><ArrowRight className="flow-arrow" aria-hidden="true" /><section><span>3. Então</span><label>Ação<select value={actionType} onChange={(event) => { setActionType(event.target.value as ActionType); setActionValue(""); }}><option value="moveTo">Mover a demanda</option><option value="slaStatus">Atualizar o SLA</option><option value="labelId">Aplicar uma etiqueta</option></select></label>{actionType === "moveTo" && <label>Coluna de destino<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.lists.map((list) => <option value={list.kind} key={list.id}>{list.name}</option>)}</select></label>}{actionType === "slaStatus" && <label>Novo status<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option><option value="safe">Dentro do prazo</option><option value="overdue">Atrasado</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label>}{actionType === "labelId" && <label>Etiqueta<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.labels.map((label) => <option value={label.id} key={label.id}>{label.name}</option>)}</select></label>}</section></div>{editorError && <p className="no-code-editor-error" role="alert"><CircleAlert aria-hidden="true" />{editorError}</p>}<footer><span>Prévia: Quando {triggerLabels[trigger] ?? trigger}, se {conditionType === "always" ? fixedConditionText.toLowerCase() : "a condição selecionada for atendida"}, então {actionType === "moveTo" ? "a demanda será movida" : actionType === "slaStatus" ? "o SLA será atualizado" : "uma etiqueta será aplicada"}.</span><button className="primary-button" disabled={busy}>Salvar automação</button></footer></form>}</div>;
}

function InboxView({ items, busy, canEdit, onConvert, onNew }: { items: InboxItem[]; busy: boolean; canEdit: boolean; onConvert: (item: InboxItem) => Promise<void>; onNew: () => void }) {
  const pending = items.filter((item) => item.status === "new");
  const converted = items.filter((item) => item.status === "converted");
  const channelIcon = (channel: string) => channel === "whatsapp" ? <Smartphone aria-hidden="true" /> : channel === "email" ? <Mail aria-hidden="true" /> : channel === "teams" ? <MessageSquareMore aria-hidden="true" /> : <Plus aria-hidden="true" />;
  return (
    <div className="inbox-layout">
      <section className="inbox-list-panel">
        <header><div><strong>Aguardando triagem</strong><span>{pending.length} nova(s) • {converted.length} convertida(s)</span></div>{canEdit && <button onClick={onNew}><Plus aria-hidden="true" /> Registrar solicitação</button>}</header>
        <div className="inbox-items">
          {pending.length === 0 && <div className="empty-view"><span><CheckCircle2 aria-hidden="true" /></span><strong>Inbox organizada</strong><p>Não há solicitações aguardando triagem.</p></div>}
          {pending.map((item) => <article className="inbox-item" key={item.id}><span className={`channel-icon ${item.channel}`}>{channelIcon(item.channel)}</span><div><div><strong>{item.subject}</strong><time>{formatReceived(item.receivedAt)}</time></div><span>{item.senderName} • {item.channel}</span><p>{item.body}</p>{canEdit && <button disabled={busy} onClick={() => void onConvert(item)}>Transformar em demanda <ArrowRight aria-hidden="true" /></button>}</div></article>)}
        </div>
      </section>
      <aside className="inbox-summary">
        <span>FLUXO DA INBOX</span><h2>Da mensagem à fila certa.</h2><ol><li><b>1</b><div><strong>Capture</strong><p>Registre solicitações de qualquer canal.</p></div></li><li><b>2</b><div><strong>Faça a triagem</strong><p>Revise contexto e prioridade.</p></div></li><li><b>3</b><div><strong>Converta</strong><p>Crie o cartão com histórico de origem.</p></div></li></ol><div className="inbox-converted"><strong>{converted.length}</strong><span>convertida(s) nesta fila</span></div>
      </aside>
    </div>
  );
}

function PlannerView({ cards, blocks, connections, onOpen, onCreateBlock, onDeleteBlock, onSaveConnection }: { cards: Card[]; blocks: WorkspaceSnapshot["plannerBlocks"]; connections: WorkspaceSnapshot["calendarConnections"]; onOpen: (card: Card) => void; onCreateBlock: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onDeleteBlock: (id: string) => Promise<WorkspaceSnapshot | null>; onSaveConnection: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null> }) {
  const scheduled = cards.filter((card) => card.dueAt && card.slaStatus !== "completed").sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const grouped = scheduled.reduce<Record<string, Card[]>>((accumulator, card) => { const key = card.dueAt!.slice(0, 10); (accumulator[key] ??= []).push(card); return accumulator; }, {});
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [blockTitle, setBlockTitle] = useState("");
  const [blockStart, setBlockStart] = useState("");
  const [blockEnd, setBlockEnd] = useState("");
  const [blockCardId, setBlockCardId] = useState("");
  const [blockError, setBlockError] = useState("");
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [calendarProvider, setCalendarProvider] = useState("google");
  const [calendarId, setCalendarId] = useState("");
  async function createBlock(event: FormEvent) {
    event.preventDefault();
    const start = new Date(blockStart);
    const end = new Date(blockEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setBlockError("O término precisa ser posterior ao início do bloco.");
      return;
    }
    setBlockError("");
    const next = await onCreateBlock({ title: blockTitle, startAt: start.toISOString(), endAt: end.toISOString(), cardId: blockCardId || null, blockType: "focus" });
    if (next) { setBlockTitle(""); setBlockStart(""); setBlockEnd(""); setBlockCardId(""); setShowBlockForm(false); }
  }
  async function saveConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = await onSaveConnection({ provider: calendarProvider, externalCalendarId: calendarId, config: { calendarLabel: calendarId || "Calendário principal" } });
    if (next) { setCalendarId(""); setShowConnectionForm(false); }
  }
  return (
    <div className="planner-layout">
      <section className="planner-calendar"><header><div><strong>Agenda por prazo</strong><span>{scheduled.length} atividade(s) programada(s) • {blocks.length} bloco(s) de foco</span></div><button className="secondary-button" onClick={() => { setShowBlockForm((value) => !value); setBlockError(""); }}><Plus aria-hidden="true" /> Bloco de tempo</button></header>{showBlockForm && <form className="planner-block-form" onSubmit={createBlock}><label>Título<input value={blockTitle} onChange={(event) => setBlockTitle(event.target.value)} placeholder="Ex.: Conferir admissões" required /></label><label>Início<input type="datetime-local" value={blockStart} onChange={(event) => setBlockStart(event.target.value)} required /></label><label>Fim<input type="datetime-local" value={blockEnd} onChange={(event) => setBlockEnd(event.target.value)} required /></label><label>Demanda<select value={blockCardId} onChange={(event) => setBlockCardId(event.target.value)}><option value="">Bloco geral</option>{cards.map((card) => <option key={card.id} value={card.id}>{card.title}</option>)}</select></label><button className="primary-button">Salvar bloco</button>{blockError && <p className="planner-form-error" role="alert">{blockError}</p>}</form>}{blocks.length > 0 && <div className="planner-block-list">{blocks.map((block) => <article key={block.id}><CalendarClock aria-hidden="true" /><div><strong>{block.title}</strong><small>{new Date(block.startAt).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} – {new Date(block.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small></div><button onClick={() => void onDeleteBlock(block.id)} aria-label={`Excluir ${block.title}`}><Trash2 aria-hidden="true" /></button></article>)}</div>}{Object.keys(grouped).length === 0 && <div className="empty-view"><span><CalendarClock aria-hidden="true" /></span><strong>Nenhum prazo agendado</strong><p>Defina uma data nas demandas para montar o planner.</p></div>}{Object.entries(grouped).map(([date, dateCards]) => <div className="planner-day" key={date}><div><strong>{formatDate(date, true)}</strong><span>{dateCards.length} demanda(s)</span></div><div>{dateCards.map((card) => <button key={card.id} onClick={() => onOpen(card)}><i className={processColors[card.processType] ?? "gray"} /><span><strong>{card.title}</strong><small>{card.assigneeName || "Sem responsável"} • {card.company || card.processType}</small></span><em className={card.slaStatus}><Clock3 aria-hidden="true" />{slaLabel(card)}</em></button>)}</div></div>)}</section>
      <aside className="planner-focus"><span>FOCO DO DIA</span><h2>{scheduled.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length}</h2><p>demanda(s) precisam de atenção imediata.</p><div><i /><span><strong>Priorize atrasos</strong><small>Comece pelos SLAs vencidos antes de assumir novas atividades.</small></span></div><section className="planner-connections"><header><strong>Calendários externos</strong><button onClick={() => setShowConnectionForm((value) => !value)}>{showConnectionForm ? "Cancelar" : "Configurar"}</button></header>{connections.length === 0 && <p>Conecte Google ou Microsoft Calendar para preparar a sincronização da agenda.</p>}{connections.map((connection) => <article key={connection.id}><CalendarDays aria-hidden="true" /><span><strong>{connection.provider === "microsoft" ? "Microsoft Calendar" : "Google Calendar"}</strong><small>{connection.externalCalendarId || "Calendário principal"} · {connection.status === "connected" ? "conectado" : "aguardando OAuth"}</small></span></article>)}{showConnectionForm && <form onSubmit={saveConnection}><select value={calendarProvider} onChange={(event) => setCalendarProvider(event.target.value)}><option value="google">Google Calendar</option><option value="microsoft">Microsoft Calendar</option></select><input value={calendarId} onChange={(event) => setCalendarId(event.target.value)} placeholder="ID ou nome do calendário (opcional)" /><button className="secondary-button">Salvar configuração</button></form>}</section></aside>
    </div>
  );
}

function IndicatorsView({ cards, companyId, scopeLabel, rules, busy, canManageRules, canExportWorkspace, onToggleRule, onExport, hrMetrics, companies }: { cards: Card[]; companyId: string; scopeLabel: string; canExportWorkspace: boolean; rules: WorkspaceSnapshot["rules"]; busy: boolean; canManageRules: boolean; onToggleRule: (id: string, enabled: boolean) => Promise<void>; onExport: () => void; hrMetrics: WorkspaceSnapshot["hrMetrics"]; companies: WorkspaceSnapshot["companies"] }) {
  const [report, setReport] = useState<{ from: string; to: string; total: number; completed: number; completionRate: number; averageCompletionHours: number; activityCount: number; byProcess: Record<string, number>; hrMetrics?: { admissions: number; terminations: number; averageHeadcount: number; payrollCostTotal: number; turnoverRate: number; payrollByCompany: Record<string, number> } } | null>(null);
  const [reportDays, setReportDays] = useState("30");
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError, setReportError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const to = new Date();
    const from = new Date(Date.now() - (Number(reportDays) - 1) * 86400000);
    const escopo = companyId ? `&companyId=${encodeURIComponent(companyId)}` : "";
    void fetch(`/api/reports?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}${escopo}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Não foi possível carregar o relatório.");
        return response.json();
      })
      .then((payload) => setReport(payload))
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setReport(null);
        setReportError(cause instanceof Error ? cause.message : "Não foi possível carregar o relatório.");
      })
      .finally(() => { if (!controller.signal.aborted) setReportLoading(false); });
    return () => controller.abort();
  }, [reportDays, companyId]);
  const processes = Object.entries(cards.reduce<Record<string, number>>((accumulator, card) => { accumulator[card.processType] = (accumulator[card.processType] ?? 0) + 1; return accumulator; }, {})).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...processes.map(([, count]) => count));
  const statusCounts = { safe: 0, warning: 0, overdue: 0, paused: 0, completed: 0 };
  cards.forEach((card) => { statusCounts[card.slaStatus] += 1; });
  return (
    <div className="indicators-layout">
      <section className="hr-indicators-panel"><header><div><strong>Indicadores do Departamento Pessoal</strong><span>Turnover e custo da folha por competência · {scopeLabel}</span></div><b>{(report?.hrMetrics?.turnoverRate ?? 0).toFixed(2)}%</b></header><div className="hr-indicator-grid"><article><CircleAlert aria-hidden="true" /><strong>{report?.hrMetrics?.turnoverRate?.toFixed(2) ?? "0,00"}%</strong><span>Turnover</span></article><article><Users aria-hidden="true" /><strong>{report?.hrMetrics?.averageHeadcount ?? 0}</strong><span>Headcount médio</span></article><article><Plus aria-hidden="true" /><strong>{report?.hrMetrics?.admissions ?? 0}</strong><span>Admissões</span></article><article><ArrowRight aria-hidden="true" /><strong>{report?.hrMetrics?.terminations ?? 0}</strong><span>Desligamentos</span></article><article><WalletCards aria-hidden="true" /><strong>{(report?.hrMetrics?.payrollCostTotal ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong><span>Custo da folha</span></article></div><div className="hr-indicator-note">{hrMetrics.length ? `${hrMetrics.length} competência(s) cadastrada(s) em ${companies.length} empresa(s).` : "Cadastre empresas e competências para calcular os indicadores."}</div></section>
      <section className="metrics-panel"><header><div><strong>Volume por processo</strong><span>{cards.length} demanda(s) · {scopeLabel}</span></div><div className="export-actions">
        <button className="export-button" onClick={onExport}><Download aria-hidden="true" /> Exportar CSV</button>
        {/* A exportação completa do grupo (§50) mora aqui porque esta é a tela
            de tirar dado do produto. A rota já existia e a página de privacidade
            passou a dizer que o administrador exporta a qualquer momento —
            sem porta, seria mais uma promessa sem porta. */}
        {canExportWorkspace && <a className="export-button" href="/api/workspace/export" download title="Empresas, colaboradores, demandas, competências, obrigações, pagamentos e auditoria em um JSON. Segredos cifrados, chaves internas e o conteúdo dos anexos ficam de fora, e o arquivo diz quais.">
          <Download aria-hidden="true" /> Exportar tudo (JSON)
        </a>}
      </div></header><div className="process-bars">{processes.length === 0 && <div className="panel-empty">Nenhuma demanda nos filtros atuais.</div>}{processes.map(([process, count]) => <div key={process}><span>{process}</span><i><b style={{ width: `${(count / max) * 100}%` }} /></i><strong>{count}</strong></div>)}</div></section>
      <section className="sla-panel"><header><strong>Saúde dos SLAs</strong><span>Visão atual</span></header><div className="sla-donut" style={{ background: `conic-gradient(#23d8a1 0 ${(statusCounts.safe / Math.max(1, cards.length)) * 100}%, #f2a13e 0 ${((statusCounts.safe + statusCounts.warning) / Math.max(1, cards.length)) * 100}%, #ef5b5b 0 ${((statusCounts.safe + statusCounts.warning + statusCounts.overdue) / Math.max(1, cards.length)) * 100}%, #8b98a7 0 100%)` }}><span><strong>{cards.length - statusCounts.overdue}</strong><small>sob controle</small></span></div><ul><li><i className="safe" />No prazo <b>{statusCounts.safe}</b></li><li><i className="warning" />Atenção <b>{statusCounts.warning}</b></li><li><i className="overdue" />Atrasadas <b>{statusCounts.overdue}</b></li><li><i className="paused" />Pausadas/concluídas <b>{statusCounts.paused + statusCounts.completed}</b></li></ul></section>
      <section className="report-panel" aria-live="polite"><header><div><strong>Histórico e produtividade</strong><span>Indicadores calculados a partir da auditoria do workspace.</span></div><select value={reportDays} onChange={(event) => { setReportDays(event.target.value); setReportLoading(true); setReportError(""); }}><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option></select></header>{reportLoading && <div className="report-state"><i /> Atualizando relatório…</div>}{reportError && <div className="report-state error"><CircleAlert aria-hidden="true" /> {reportError}</div>}{report && !reportLoading && <div className="report-metrics"><article><strong>{report.total}</strong><span>Demandas no período</span></article><article><strong>{report.completionRate}%</strong><span>Taxa de conclusão</span></article><article><strong>{report.averageCompletionHours}h</strong><span>Tempo médio</span></article><article><strong>{report.activityCount}</strong><span>Eventos auditados</span></article></div>}<div className="report-process-list">{report && !reportLoading && Object.entries(report.byProcess).sort((a, b) => b[1] - a[1]).map(([process, count]) => <span key={process}><b>{process}</b><i style={{ width: `${Math.max(8, (count / Math.max(1, report.total)) * 100)}%` }} /><em>{count}</em></span>)}</div></section>
      <section className="rules-panel"><header><div><strong>Automações nativas</strong><span>Gatilho → condição → ação</span></div><b>{rules.filter((rule) => rule.enabled).length} ativas</b></header><div>{rules.map((rule, index) => <article key={rule.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{rule.name}</strong><small>{rule.trigger.replaceAll(".", " ")}</small></div><label className="rule-switch"><input type="checkbox" checked={rule.enabled} disabled={busy || !canManageRules} onChange={(event) => void onToggleRule(rule.id, event.target.checked)} /><i /></label></article>)}</div></section>
    </div>
  );
}
