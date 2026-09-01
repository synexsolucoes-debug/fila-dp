"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  defaultPanelLocation, panelPath, parsePanelPath,
  type PanelLocation, type PanelSettingsSection, type PanelView,
} from "@/lib/panel-routes";
import {
  Archive,
  ArrowRight,
  BarChart3,
  Bell,
  Blocks,
  Bot,
  Building2,
  Cable,
  HardHat,
  History,
  Check,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  Download,
  GitBranch,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  MessageCircle,
  MessageSquareMore,

  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldQuestion,
  AlertTriangle,
  UserRoundCog,
  Smartphone,
  Star,
  Stethoscope,

  Timer,
  Trash2,
  Upload,
  Users,
  WalletCards,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";
import { HistoryView } from "./features/history/HistoryView";
import type { ActivityEvent, Card, CardAttachment, InboxItem, ProcessFlowSummary, WorkspaceRole, WorkspaceSnapshot } from "@/lib/fila-dp-types";
import type { ActionTarget } from "@/lib/action-center";
import { RULE_TRIGGERS, RULE_TRIGGER_LABELS } from "@/lib/automation-rules";
import { hasSubNavigation, visibleProcessGroups } from "@/lib/process-navigation";
import { PRIORITY_LABELS } from "@/lib/work-items";
import { capabilitiesForRole, workspaceRoles } from "@/lib/authorization";
import { capabilityAreas, capabilitiesOfArea, capabilityCatalog, type CapabilityArea } from "@/lib/capability-catalog";
import { formatWorkingMinutes } from "@/lib/fila-dp-sla";
import { overviewPeriodLabel, overviewPeriods, periodWindowEnd, periodWindowStart, withinPeriod, type OverviewPeriod } from "@/lib/overview-period";
import { AnimatedTabs, competenceLabel, ProcessTabsProvider, useShortcuts, connectionStatusLabel, connectionTone, cycleProgress, cycleStages, lastSyncLabel, MemberModules, MotionCard, PageTransition, StaggerContainer, StaggerItem } from "./features/shared";
import { RequestError, requestErrorFrom, supportReference } from "./request-error";
import { AssistantPanel } from "./features/assistant/AssistantPanel";
import { RegistrationsView } from "./features/registrations";
import { OperationsView } from "./features/operations";
import { ProcessManagementView } from "./features/processes";
import { AuxiliaryModulesView } from "./features/auxiliary";
import { IntegrationsView } from "./features/integrations";
import { PaymentsView, contractorSections, isContractorSection, type ContractorSectionId } from "./features/payments";
import { TimeTrackingView } from "./features/time";
import { EpiControlView } from "./features/epi";
import { ActionCenter } from "./features/action-center";
import { AgentsView, CardProcessPanel, TriageView, WorkCenterView } from "./features/work";
import { PayrollImportDialog } from "./features/payroll/PayrollImportDialog";

/* Os oito destinos do Pagamento PJ (§74) estão escritos aqui um a um, e não
   como `ContractorSectionId`: esta união é a lista de telas do painel, e é ela
   que se lê para conferir que toda tela tem porta no menu. Um apelido de tipo
   esconderia oito telas de quem confere. */
type View = "overview" | "work" | "board" | "inbox" | "planner" | "processManagement" | "processes" | "auxiliary" | "psychologistPayments" | "contractorPayments" | "contractorProviders" | "contractorCycles" | "contractorClosings" | "contractorAdjustments" | "contractorLimits" | "contractorCaju" | "contractorArchive" | "timeTracking" | "epi" | "integrations" | "agents" | "triage" | "registrations" | "payroll" | "indicators" | "history";
type BoardMode = "kanban" | "table" | "calendar" | "process";

/** Destinos que a faixa de indicadores alcança (§14). Subconjunto de `View`. */
type OverviewFocusTarget = "board" | "processManagement" | "processes" | "integrations" | "history";

type CardTab = "details" | "process" | "checklist" | "attachments" | "activity";
type SettingsSection = "general" | "companies" | "columns" | "team" | "security" | "fields" | "templates" | "sla" | "automations";

/**
 * Cada seção de configuração precisa de um cabeçalho próprio.
 *
 * Antes o cabeçalho tinha só dois textos escritos à mão — um para "security" e
 * outro para todo o resto — o que fazia sete telas anunciarem "Usuários e
 * acessos" no título. Com o mapa, acrescentar uma seção sem lhe dar um nome
 * passa a ser um erro de tipo, e não uma tela mal rotulada em produção.
 */
const settingsSectionMeta: Record<SettingsSection, { group: string; title: string; description: string }> = {
  security: { group: "CONTA", title: "Perfil e segurança", description: "Revise apenas as sessões da identidade atual." },
  general: { group: "WORKSPACE", title: "Geral", description: "Nome do workspace, quadros disponíveis e a conta com que você está entrando." },
  companies: { group: "WORKSPACE", title: "Empresas", description: "Cadastre, edite e organize os CNPJs do grupo." },
  team: { group: "PESSOAS E ACESSO", title: "Usuários e acessos", description: "Defina o departamento e os módulos disponíveis para cada usuário." },
  columns: { group: "OPERAÇÃO", title: "Colunas", description: "Nome, ordem e efeito de cada coluna sobre o SLA." },
  fields: { group: "OPERAÇÃO", title: "Campos e etiquetas", description: "Etiquetas e campos personalizados que aparecem nas demandas." },
  /* "Modelos", e não "Templates": a tela vizinha chama a mesma coisa de modelo
     de processo, e duas palavras para um conceito só é o tipo de divergência
     que faz alguém procurar a configuração no lugar errado. */
  templates: { group: "OPERAÇÃO", title: "Modelos", description: "Checklists e SLA prontos para abrir uma demanda sem esquecer etapas." },
  sla: { group: "OPERAÇÃO", title: "SLA e calendário", description: "Expediente, feriados e metas de prazo por processo." },
  automations: { group: "OPERAÇÃO", title: "Automações", description: "Regras que reagem automaticamente aos eventos das demandas." },
};

/* O menu lateral das configurações escrito como dado, e não como sete botões
   soltos no JSX. Sete das nove seções existiam, funcionavam e conversavam com
   a API — e nenhuma tinha botão que levasse até elas. Escritas aqui, a lista de
   seções e a lista de portas ficam lado a lado, e um teste consegue exigir que
   toda seção de `SettingsSection` apareça neste menu. */
/* O `adminOnly` é da SEÇÃO, e não do grupo.
   Enquanto foi do grupo, o agrupamento e a autorização eram a mesma decisão:
   pôr "Geral" (que todo mundo abre) ao lado de "Empresas" (que só admin abre)
   era impossível sem abrir uma das duas para quem não deve. O resultado era um
   menu organizado pela regra de acesso em vez de pelo assunto — "Conta e
   workspace" juntava segurança pessoal com quadros do grupo porque as duas
   eram públicas, não porque tenham a ver uma com a outra.
   Separar as duas coisas mantém a autorização idêntica — o mesmo conjunto de
   sete seções continua exigindo administrador — e libera o menu para ser
   agrupado por assunto: onde se configura o ambiente, quem tem acesso, como a
   operação roda, e a conta de quem está usando. */
const settingsNavGroups: Array<{ label: string; sections: Array<{ section: SettingsSection; icon: LucideIcon; hint: string; adminOnly: boolean }> }> = [
  { label: "WORKSPACE", sections: [
    { section: "general", icon: LayoutDashboard, hint: "Nome, workspaces e quadros", adminOnly: false },
    { section: "companies", icon: Building2, hint: "CNPJs do grupo", adminOnly: true },
  ] },
  { label: "PESSOAS E ACESSO", sections: [
    { section: "team", icon: Users, hint: "Departamento e módulos", adminOnly: true },
  ] },
  { label: "OPERAÇÃO", sections: [
    { section: "columns", icon: ListChecks, hint: "Etapas e SLA", adminOnly: true },
    { section: "fields", icon: Blocks, hint: "Etiquetas e campos", adminOnly: true },
    { section: "templates", icon: ClipboardCheck, hint: "Checklists prontos", adminOnly: true },
    { section: "sla", icon: CalendarClock, hint: "Expediente e feriados", adminOnly: true },
    { section: "automations", icon: Workflow, hint: "Regras automáticas", adminOnly: true },
  ] },
  { label: "CONTA", sections: [
    { section: "security", icon: Smartphone, hint: "Dispositivos e sessões", adminOnly: false },
  ] },
];
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
  employeeId: string;
  requesterUserId: string;
  competence: string;
  title: string;
  description: string;
  companyId: string;
  company: string;
  requesterAreaId: string;
  responsibleAreaId: string;
  processType: string;
  priority: string;
  assigneeName: string;
  dueAt: string;
  listId: string;
  templateId: string;
  processVersionId: string;
  assigneeIds: string[];
  labelIds: string[];
  customValues: Record<string, string>;
};

const emptyCardForm: CardForm = {
  boardId: "",
  employeeId: "",
  requesterUserId: "",
  competence: "",
  title: "",
  description: "",
  companyId: "",
  company: "",
  requesterAreaId: "",
  responsibleAreaId: "",
  processType: "CONCILIAÇÃO CADASTRAL",
  priority: "normal",
  assigneeName: "",
  dueAt: "",
  listId: "",
  templateId: "",
  /* Versão publicada do processo que esta demanda vai executar (§10).
     Vazio significa demanda avulsa — o caminho que sempre existiu e continua
     valendo para o trabalho que não tem processo modelado. */
  processVersionId: "",
  assigneeIds: [],
  labelIds: [],
  customValues: {},
};

/**
 * Um processo publicado, do jeito que a modal de nova demanda precisa dele.
 *
 * Só o necessário para escolher: o nome, a área dona (§4 — é ela que responde
 * pelo trabalho) e a versão que será instanciada. O resto do catálogo fica na
 * tela de Processos, que é onde ele é editado.
 */
type StartableProcess = {
  id: string; name: string; areaName: string; versionId: string; versionLabel: string; stepCount: number;
};
type EmployeeStartOption = {
  id: string; company_id: string; full_name: string; social_name: string;
  registration_number: string; employment_status: string;
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
/**
 * Ícone de cada processo (§25, §70).
 *
 * A estrutura — quais processos existem e que módulos moram em cada um — vive
 * em `lib/process-navigation.ts`, que é puro e testável. O que fica aqui é só
 * o desenho: o ícone que representa o processo no menu e no cabeçalho
 * contextual. Separar os dois evita que um módulo puro precise importar React.
 */
const processGroupIcons: Record<string, LucideIcon> = {
  "operacao-dp": ClipboardCheck,
  pagamentos: WalletCards,
  epi: HardHat,
  jornada: Timer,
  desenho: Workflow,
  cadastros: Users,
  analise: BarChart3,
};

/** Rótulo das três famílias do menu. "Processos" é o que a operação executa;
 *  "Áreas" são os módulos de quem responde por uma área (§91); "Apoio" é a base
 *  e a leitura sobre as quais eles rodam (§27). */
const processKindLabels: Record<string, string> = {
  process: "PROCESSOS",
  area: "ÁREAS",
  support: "APOIO E GOVERNANÇA",
};

type ViewEntry = {
  /** Título curto: menu lateral e contexto do assistente. */
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Rota do catálogo de módulos. Ausente = sempre disponível. */
  module?: string;
  /** Papéis que não veem a tela. A regra ficava repetida em sete botões. */
  hiddenFor?: WorkspaceRole[];
  /**
   * A tela desenha o próprio cabeçalho de página — e por isso a casca não
   * desenha o dela (§41).
   *
   * Sem esta marca, Pagamentos PJ abria com o título três vezes: uma na aba do
   * processo, uma no cabeçalho da casca ("CONTROLE DE PAGAMENTO / Pagamentos
   * PJ / Apure o líquido devido…") e uma no cabeçalho do próprio módulo
   * ("CONTROLE DE PAGAMENTO / Pagamentos PJ / Quanto o prestador tem a
   * receber…") — dois textos diferentes para a mesma tela, um embaixo do
   * outro. É o sintoma exato da §2: partes construídas separadamente, cada uma
   * assumindo que era a dona do topo.
   *
   * A marca fica aqui e não no componente porque quem decide se a casca
   * desenha é a casca. Um módulo não tem como suprimir o cabeçalho de fora
   * dele sem que os dois passem a conhecer um ao outro.
   */
  ownHeader?: boolean;
  /** Ação primária da barra superior. Ausente = a barra não oferece nenhuma:
   *  a tela tem os próprios comandos e um botão genérico ali criaria dois
   *  caminhos para a mesma coisa, ou um caminho para coisa nenhuma. */
  primaryAction?: { label: string; kind: "card" | "inbox" };
};

/** Uma tela do Pagamento PJ, com rótulo e descrição vindos do catálogo do módulo. */
function contractorEntry(id: ContractorSectionId): ViewEntry {
  const section = contractorSections.find((entry) => entry.id === id);
  if (!section) throw new Error(`destino de Pagamento PJ desconhecido: ${id}`);
  return {
    label: section.label, icon: section.icon, module: "contractorPayments",
    hiddenFor: ["guest"], ownHeader: true,
    eyebrow: "PAGAMENTO PJ", title: section.label, description: section.description,
  };
}

const viewCatalog: Record<View, ViewEntry> = {
  overview: {
    label: "Visão geral", icon: LayoutDashboard,
    eyebrow: "VISÃO GERAL", title: "Visão geral",
    description: "Acompanhe o que exige ação e mantenha a operação sob controle.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  work: {
    label: "Meu trabalho", icon: ClipboardList,
    eyebrow: "CENTRAL DE TRABALHO", title: "O que está comigo hoje",
    description: "Demandas, aprovações, movimentações, entregas, pendências, triagem e falhas que exigem ação — em uma lista só.",
    ownHeader: true,
  },
  board: {
    label: "Demandas", icon: ListChecks,
    eyebrow: "DEMANDAS", title: "Quadro de demandas",
    description: "Acompanhe prioridades, responsáveis e próximos passos.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  inbox: {
    label: "Inbox", icon: Inbox, module: "inbox",
    eyebrow: "TRIAGEM MULTICANAL", title: "Caixa de entrada",
    description: "Transforme solicitações recebidas em demandas rastreáveis.",
    primaryAction: { label: "Nova solicitação", kind: "inbox" },
  },
  planner: {
    label: "Planner", icon: CalendarDays, module: "planner",
    eyebrow: "AGENDA DO ANALISTA", title: "Meu planner",
    description: "Organize sua execução a partir dos prazos da operação.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  processManagement: {
    label: "Processos", icon: Workflow, module: "processes", hiddenFor: ["guest"], ownHeader: true,
    eyebrow: "GESTÃO E MODELAGEM", title: "Processos",
    description: "Desenhe, documente, versione e publique processos BPMN ligados às áreas, empresas e responsabilidades do grupo.",
  },
  processes: {
    label: "Operação DP", icon: ClipboardCheck, module: "processes",
    eyebrow: "OPERAÇÃO DO DP", title: "Cockpit de fechamento",
    description: "Coordene competências, gates, aprovações e obrigações. A admissão digital permanece integralmente na Sólides.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  auxiliary: {
    label: "Módulos auxiliares", icon: Blocks, module: "auxiliary", hiddenFor: ["guest"],
    eyebrow: "SERVIÇOS DA COMPETÊNCIA", title: "Módulos auxiliares",
    description: "Controle entradas, aprovações, saídas e fechamento de Benefícios, Psicologia e Prestadores PJ.",
  },
  agents: {
    label: "Agentes", icon: Bot, module: "integrations", hiddenFor: ["guest", "observer"], ownHeader: true,
    eyebrow: "CENTRAL DE AGENTES", title: "Automação sob controle",
    description: "Estado, cadência, execução e histórico dos agentes que leem os sistemas de origem.",
  },
  triage: {
    label: "Triagem", icon: ShieldQuestion, module: "integrations", hiddenFor: ["guest"], ownHeader: true,
    eyebrow: "CENTRAL DE TRIAGEM", title: "O que o sistema não teve certeza",
    description: "Entradas que a automação não conseguiu classificar sozinha e aguardam decisão humana.",
  },
  registrations: {
    label: "Cadastros", icon: Users, module: "registrations", hiddenFor: ["guest"],
    eyebrow: "BASE OPERACIONAL", title: "Cadastros",
    description: "Administre empresas, colaboradores e estruturas auxiliares em um só lugar.",
  },
  timeTracking: {
    label: "Ponto", icon: Timer, module: "timeTracking", hiddenFor: ["guest"],
    eyebrow: "CONFERÊNCIA OPERACIONAL", title: "Ponto",
    description: "Confira marcações, trate inconsistências e envie os eventos de hora para a folha com a rubrica configurada.",
  },
  epi: {
    label: "Controle de EPI", icon: HardHat, module: "epi", hiddenFor: ["guest"],
    eyebrow: "SEGURANÇA DO TRABALHO", title: "Controle de EPI",
    description: "Cadastro, entrega, devolução, troca, descarte e análise de desconto de equipamentos de proteção.",
  },
  payroll: {
    label: "Folha", icon: WalletCards, module: "payroll",
    eyebrow: "FOLHA E INDICADORES", title: "Folha de pagamento",
    description: "Registre a competência e acompanhe custos, headcount e turnover automaticamente.",
  },
  psychologistPayments: {
    label: "Pagamento de Psicólogos", icon: Stethoscope,
    module: "psychologistPayments", hiddenFor: ["guest", "observer"], ownHeader: true,
    eyebrow: "CONTROLE FINANCEIRO", title: "Pagamento de Psicólogos",
    description: "Apure as consultas válidas da competência e controle quanto pagar a cada psicólogo. O módulo é exclusivamente administrativo e financeiro.",
  },
  /* Os oito destinos do Pagamento PJ (§74). Escritos um a um pelo mesmo motivo
     que a união acima: quem confere que toda tela tem porta no menu lê este
     catálogo. O rótulo e a descrição vêm do catálogo do módulo — repetir a
     frase aqui seria criar a segunda cópia que diverge da primeira. Todos
     carregam a permissão do módulo inteiro: dividir a leitura não divide o
     acesso. */
  contractorPayments: { ...contractorEntry("contractorPayments") },
  contractorProviders: { ...contractorEntry("contractorProviders") },
  contractorCycles: { ...contractorEntry("contractorCycles") },
  contractorClosings: { ...contractorEntry("contractorClosings") },
  contractorAdjustments: { ...contractorEntry("contractorAdjustments") },
  contractorLimits: { ...contractorEntry("contractorLimits") },
  contractorCaju: { ...contractorEntry("contractorCaju") },
  contractorArchive: { ...contractorEntry("contractorArchive") },
  indicators: {
    label: "Relatórios", icon: BarChart3, module: "indicators",
    eyebrow: "RELATÓRIOS", title: "Relatórios da operação",
    description: "Monitore SLAs, volume, produtividade e regras ativas do workspace.",
  },
  history: {
    label: "Histórico", icon: History,
    eyebrow: "HISTÓRICO DA OPERAÇÃO",
    title: "Tudo o que aconteceu",
    description: "A trilha completa de movimentações: quem fez, o quê, em qual demanda e quando.",
    ownHeader: true,
  },
  integrations: {
    label: "Estado das integrações", icon: Cable, module: "integrations", hiddenFor: ["guest"],
    eyebrow: "INFRAESTRUTURA OPERACIONAL", title: "Estado das integrações",
    description: "Acompanhe conexões e últimas execuções deste workspace. A administração fica na console global.",
  },
};

/** Ordem do menu. É a ordem de declaração do catálogo — mantê-las separadas
 *  criaria a quinta lista para desalinhar. */
const navOrder = Object.keys(viewCatalog) as View[];

/**
 * A barra inferior cabe em cinco alvos de toque. Os quatro destinos usados em
 * toda rotina ficam expostos; os demais continuam alcançáveis pelo botão
 * "Mais", agrupados com os mesmos contextos do menu lateral.
 */
const mobilePrimaryViews = new Set<View>(["overview", "work", "board", "inbox"]);

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
  const headers = new Headers(options?.headers);
  if (!(options?.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...options,
    headers,
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
    solidesAttachments: card.solidesAttachments ?? null,
    customValues: card.customValues && typeof card.customValues === "object" && !Array.isArray(card.customValues) ? card.customValues : {},
  });

  return {
    ...snapshot,
    lists: Array.isArray(snapshot.lists) ? snapshot.lists.map((list) => ({ ...list, cards: Array.isArray(list.cards) ? list.cards.map(normalizeCard) : [] })) : [],
    archivedCards: Array.isArray(snapshot.archivedCards) ? snapshot.archivedCards.map(normalizeCard) : [],
    inbox: Array.isArray(snapshot.inbox) ? snapshot.inbox : [],
    rules: Array.isArray(snapshot.rules) ? snapshot.rules : [],
    members: Array.isArray(snapshot.members) ? snapshot.members.map((member) => ({
      ...member,
      isActivated: member.isActivated !== false,
      companyIds: Array.isArray(member.companyIds) ? member.companyIds : [],
      departmentId: member.departmentId ?? null,
      departmentName: member.departmentName ?? "",
    })) : [],
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

/**
 * O identificador que uma pessoa dita ao telefone: `#DM-2471`.
 *
 * O prefixo mora aqui, na apresentação, e não no banco: guardar "DM-2471" como
 * texto impediria ordenar por número e transformaria qualquer mudança de
 * prefixo numa migration de dados.
 *
 * Demanda de banco anterior à 0070 não tem número. Aí a resposta é vazia e a
 * tela não mostra nada — melhor a ausência do que um `#DM-0` que parece uma
 * demanda de verdade.
 */
function referenceLabel(card: Card) {
  return card.referenceNumber == null ? "" : `#DM-${card.referenceNumber}`;
}

/**
 * Processo, etapa e progresso no cartão do quadro.
 *
 * O `tasksTotal` é o que a **versão do processo prevê**, somando as tarefas de
 * todas as etapas. Como a versão é imutável, o denominador é fixo desde a
 * criação: "7 de 18" continua sendo de 18 enquanto a demanda anda, que é o que
 * permite ler o progresso como avanço no processo, e não como uma fração cujo
 * fundo se mexe.
 *
 * Sem tarefa nenhuma o percentual não aparece — 0% num cartão recém-criado
 * parece atraso, quando é apenas ausência de item.
 */
function CardProcessLine({ flow }: { flow: ProcessFlowSummary }) {
  const pct = flow.tasksTotal > 0 ? Math.round((flow.tasksDone / flow.tasksTotal) * 100) : null;
  return <>
    <span className="dashboard-card-step" title={`Processo: ${flow.definitionName} • versão ${flow.versionNumber}`}>
      <Workflow aria-hidden="true" />{flow.stepLabel}
    </span>
    {pct !== null && <span className="dashboard-card-progress" title="Tarefas concluídas nas etapas já percorridas">
      <i><b style={{ width: `${pct}%` }} /></i>
      {flow.tasksDone} de {flow.tasksTotal} tarefas • {pct}%
    </span>}
  </>;
}

/**
 * A mesma obrigação, uma linha só, com a contagem de empresas.
 *
 * A consulta devolve **uma linha por empresa**: doze filiais com o mesmo
 * eSocial S-1299 ocupavam as seis vagas do painel com o mesmo prazo repetido,
 * e a sétima obrigação — de outro tipo, talvez mais urgente — não aparecia. A
 * especificação pede o formato agregado ("Empresas: 12"), e ele é o que deixa a
 * lista responder "o que vence", em vez de "onde vence".
 *
 * Agrupa por obrigação + competência + vencimento: mesma obrigação com prazos
 * diferentes são dois compromissos distintos, e juntá-los esconderia o mais
 * apertado atrás do mais folgado. Mantém o menor `daysRemaining` do grupo pelo
 * mesmo motivo.
 *
 * Sem consulta nova — é agregação do que o snapshot já traz.
 */
function groupObligations(items: readonly WorkspaceSnapshot["upcomingObligations"][number][]) {
  const grupos = new Map<string, WorkspaceSnapshot["upcomingObligations"][number]
    & { companies: number }>();
  for (const item of items) {
    const chave = `${item.title}|${item.competence}|${item.dueDate}`;
    const atual = grupos.get(chave);
    if (!atual) { grupos.set(chave, { ...item, companies: 1 }); continue; }
    atual.companies += 1;
    if (item.daysRemaining < atual.daysRemaining) atual.daysRemaining = item.daysRemaining;
  }
  return [...grupos.values()];
}

function slaLabel(card: Card) {
  if (card.slaStatus === "overdue") return `Atrasada • ${formatDue(card.dueAt)}`;
  if (card.slaStatus === "warning") return card.dueAt ? `Atenção • ${formatDue(card.dueAt)}` : "Atenção no SLA";
  if (card.slaStatus === "paused") return "SLA pausado";
  if (card.slaStatus === "completed") return "Concluída";
  return card.dueAt ? formatDue(card.dueAt) : "Sem prazo";
}

/**
 * Origem e destino são parte do processo operacional, não uma etiqueta livre.
 * O cartão recebe somente os IDs; os nomes configuráveis são resolvidos pelo
 * catálogo do workspace para que renomear uma área não deixe snapshots textuais
 * espalhados pelas demandas.
 */
function DemandAreaFlow({ card, areas }: { card: Card; areas: WorkspaceSnapshot["areas"] }) {
  if (!card.requesterAreaId && !card.responsibleAreaId) return null;
  const requester = areas.find((area) => area.id === card.requesterAreaId)?.name ?? "Área não informada";
  const responsible = areas.find((area) => area.id === card.responsibleAreaId)?.name ?? "Área não informada";
  return <span className="demand-area-flow" aria-label={`Fluxo entre áreas: ${requester} para ${responsible}`}>
    <span>{requester}</span><ArrowRight aria-hidden="true" /><span>{responsible}</span>
  </span>;
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

function SolidesAttachmentSyncPanel({ card, busy, canAuthorize, onAuthorize }: {
  card: Card;
  busy: boolean;
  canAuthorize: boolean;
  onAuthorize: () => void;
}) {
  const sync = card.solidesAttachments;
  if (!sync) return null;
  const content = {
    AWAITING_AUTHORIZATION: {
      tone: "waiting", title: "Aguardando sua autorização",
      description: "O agente só pode trazer os documentos desta pessoa depois de uma confirmação específica para esta demanda.",
    },
    QUEUED: {
      tone: "working", title: "Transferência autorizada",
      description: "O pedido está na fila do worker local. Mantenha o worker aberto e conectado.",
    },
    RUNNING: {
      tone: "working", title: "Baixando e conferindo anexos",
      description: "O worker está trazendo os documentos e a ficha cadastral para esta demanda.",
    },
    COMPLETED: {
      tone: "success", title: "Anexos da Sólides concluídos",
      description: `${sync.uploadedCount} ${sync.uploadedCount === 1 ? "arquivo foi anexado" : "arquivos foram anexados"} e as cópias temporárias foram apagadas.`,
    },
    FAILED: {
      tone: "error", title: "A transferência precisa de atenção",
      description: sync.errorCode === "AUTHENTICATION_REQUIRED"
        ? "A sessão da Sólides precisa ser renovada no worker local. Depois, autorize novamente."
        : "Nada será reutilizado para outra pessoa. Confira o worker e autorize uma nova tentativa.",
    },
  }[sync.state];
  const showButton = sync.state === "AWAITING_AUTHORIZATION" || sync.state === "FAILED";
  return <section className={`solides-attachment-sync ${content.tone}`} role={sync.state === "FAILED" ? "alert" : "status"} aria-live="polite">
    <div><span>SÓLIDES</span><strong>{content.title}</strong><p>{content.description}</p></div>
    {showButton && canAuthorize && <button type="button" disabled={busy} onClick={onAuthorize}>
      {sync.state === "FAILED" ? "Autorizar novamente" : "Autorizar anexos da Sólides"}
    </button>}
  </section>;
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
    "tangerino.attachments.authorized": "autorizou os anexos da Sólides",
    "tangerino.attachments.completed": "trouxe os anexos da Sólides",
    "card.restored": "restaurou a demanda",
    "automation.executed": "executou uma automação",
    /* Processo e automação na mesma linha do tempo (§45). Sem estas entradas, o
       histórico dizia "atualizou a demanda" justamente nos eventos que
       explicam por que ela mudou de etapa. */
    "process.instance_started": "abriu a demanda a partir de um processo",
    "process.step_advanced": "avançou a etapa do processo",
    "integration.demand_created": "abriu a demanda a partir de uma leitura automática",
    "teams.movement_confirmed": "confirmou uma movimentação vinda do Teams",
    "sla.paused": "pausou o SLA",
    "sla.resumed": "retomou o SLA",
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
  if (activity.eventType === "process.step_advanced") {
    const destino = String(payload.toStepLabel ?? payload.toStepId ?? "próxima etapa");
    const agente = payload.agentKey ? ` Proposta do agente ${String(payload.agentKey)}, confirmada por uma pessoa.` : "";
    return [`Para ${destino}.${agente}`];
  }
  if (activity.eventType === "process.instance_started") {
    return [`Processo ${String(payload.processName ?? payload.processDefinitionId ?? "")} ${String(payload.versionNumber ?? "")}`.trim()];
  }
  if (activity.eventType === "integration.demand_created") {
    return [`Origem: ${String(payload.source ?? "integração")}.`];
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

export function WorkspaceApp({ user, signOutPath, initialLocation = defaultPanelLocation }: {
  user: User;
  signOutPath: string;
  /**
   * Onde o endereço mandou abrir (§43).
   *
   * Vem resolvido do servidor, e não de um efeito depois da hidratação: com
   * efeito, quem abre o link de uma demanda vê a visão geral piscar antes dela.
   */
  initialLocation?: PanelLocation;
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<View>(initialLocation.view as View);
  const [contractorPaymentFocus, setContractorPaymentFocus] = useState<{
    companyId: string; competence: string; closingId: string;
  } | null>(null);
  const [boardMode, setBoardMode] = useState<BoardMode>("kanban");
  const [cardTab, setCardTab] = useState<CardTab>("details");
  /** Segurança continua sendo a abertura padrão; administradores também podem
   * alcançar daqui o cadastro hierárquico de usuários do Workspace. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    (initialLocation.settings ?? "security") as SettingsSection);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [startupFailure, setStartupFailure] = useState<unknown>(null);
  const [toast, setToast] = useState("");
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [cardModalOpen, setCardModalOpen] = useState(false);
  /* Os processos publicados que podem originar uma demanda (§10).
     Carregados quando a modal de criação abre, e não no snapshot de abertura:
     o catálogo cresce com a operação e quase toda visita ao painel não abre
     esta modal — é o mesmo motivo pelo qual o histórico carrega sob demanda. */
  const [startableProcesses, setStartableProcesses] = useState<StartableProcess[] | null>(null);
  const [employeeStartOptions, setEmployeeStartOptions] = useState<EmployeeStartOption[] | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [cardForm, setCardForm] = useState<CardForm>(emptyCardForm);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [newComment, setNewComment] = useState("");
  const [commentAttachment, setCommentAttachment] = useState<File | null>(null);
  const [inboxModalOpen, setInboxModalOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(Boolean(initialLocation.settings));
  /* O nome do grupo em edição, ou `null` quando ninguém digitou nada ainda.
     O estado guardava a string direto e só era preenchido por
     `openWorkspaceSettings`. Desde a §46 a modal também abre pelo endereço —
     `/painel/configuracoes/grupo`, que é o link que se manda para alguém e o
     que sobrevive a um F5 —, e por esse caminho aquela função não roda: o
     administrador chegava a "Nome do workspace" em branco, num campo
     `required`. Parecia que o grupo tinha perdido o nome, e salvar dali o
     renomearia para o que a pessoa digitasse.

     Derivar do snapshot em vez de sincronizar por efeito resolve os dois
     caminhos de abertura de uma vez, e sem a chance de o efeito apagar o que
     está sendo digitado. */
  const [workspaceNameEdit, setWorkspaceNameEdit] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [slaFilter, setSlaFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState(initialLocation.companyId || "all");
  /**
   * Recorte de período da Visão geral (§13).
   *
   * Fica ao lado do seletor de empresa e vale para a Visão geral inteira —
   * indicadores, fluxos, vencimentos e movimentações. É diferente do `dueFilter`
   * logo abaixo, que é filtro do quadro e não sai dele.
   */
  const [periodFilter, setPeriodFilter] = useState<OverviewPeriod>("all");
  const [processFilter, setProcessFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState("all");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberRole, setMemberRole] = useState<WorkspaceRole>("member");
  const [memberCompanyIds, setMemberCompanyIds] = useState<string[]>([]);
  const [memberDepartmentId, setMemberDepartmentId] = useState("");
  const [memberModuleKeys, setMemberModuleKeys] = useState<string[]>([]);
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

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [assistantSignal, setAssistantSignal] = useState(0);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("syncing");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const sidebarPreferenceLoaded = useRef(false);
  const mobileNavigationRef = useRef<HTMLDetailsElement>(null);
  const realtimeCursorRef = useRef("");
  const touchCardMoveRef = useRef<{ cardId: string; x: number; y: number } | null>(null);
  const suppressCardOpenRef = useRef<string | null>(null);

  /**
   * Tema (§7).
   *
   * O Vinculato tem um tema só, e ele é escuro — decisão de produto, tomada
   * depois de o claro existir e ser avaliado. O que sobra aqui é a única parte
   * que o CSS não resolve sozinho: `color-scheme` é o que faz a barra de
   * rolagem, o seletor de data e os demais controles nativos do navegador
   * acompanharem o tema. Sem ele, o painel escuro abre um calendário branco.
   *
   * A escala clara continua declarada em `dashboard-modern.css` porque é a
   * camada base sobre a qual as regras `.theme-dark` escrevem — apagá-la
   * exigiria reescrever cada regra do painel, e o resultado na tela seria
   * exatamente o mesmo.
   */
  useEffect(() => {
    document.documentElement.style.colorScheme = "dark";
    // A escolha de quem experimentou a alternância enquanto ela existiu não
    // pode sobreviver a ela: sem esta linha, um valor guardado ficaria no
    // navegador da pessoa sem nada que o leia nem o apague.
    window.localStorage.removeItem("vinculato-theme");
  }, []);

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

  /* Catálogo de processos que podem originar demanda (§10).
     Carrega uma vez, na primeira abertura da modal de criação. Falha aqui não
     interrompe nada: a lista fica vazia e a modal segue oferecendo a demanda
     avulsa — perder o atalho é bem menos grave do que impedir a criação. */
  useEffect(() => {
    if (!cardModalOpen || startableProcesses !== null) return;
    let cancelado = false;
    void (async () => {
      try {
        const resposta = await fetch("/api/processes", { cache: "no-store" });
        if (!resposta.ok) throw new Error(String(resposta.status));
        const corpo = await resposta.json() as { processes?: unknown };
        const lista = Array.isArray(corpo.processes) ? corpo.processes : [];
        const disponiveis = lista.flatMap((item) => {
          const processo = item as Record<string, unknown>;
          const versao = processo.currentVersion as Record<string, unknown> | null;
          /* Só entra o que a operação pode de fato executar: versão publicada
             (§8.3 — rascunho não vira demanda) e início manual permitido. Um
             processo em rascunho na lista seria um caminho que o servidor
             recusaria depois do clique. */
          if (!versao || String(versao.status) !== "published") return [];
          if (processo.allowManualStart === false) return [];
          if (processo.active === false) return [];
          return [{
            id: String(processo.id ?? ""),
            name: String(processo.name ?? ""),
            areaName: String(processo.ownerDepartmentName || "Sem área definida"),
            versionId: String(versao.id ?? ""),
            versionLabel: `v${Number(versao.versionMajor ?? 1)}.${Number(versao.versionMinor ?? 0)}`,
            stepCount: Number(processo.stepCount ?? 0),
          }];
        }).filter((processo) => processo.versionId && processo.name);
        if (!cancelado) setStartableProcesses(disponiveis);
      } catch {
        if (!cancelado) setStartableProcesses([]);
      }
    })();
    return () => { cancelado = true; };
  }, [cardModalOpen, startableProcesses]);

  /* Colaboradores ativos para vincular a demanda ao titular correto. */
  useEffect(() => {
    if (!cardModalOpen || selectedCardId || employeeStartOptions !== null) return;
    let cancelled = false;
    void fetch("/api/employees?status=active&limit=100", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : { employees: [] })
      .then((payload: Record<string, unknown>) => {
        if (cancelled) return;
        const employees = Array.isArray(payload.employees) ? payload.employees as EmployeeStartOption[] : [];
        setEmployeeStartOptions(employees.filter((employee) => employee.employment_status !== "terminated"));
      })
      .catch(() => { if (!cancelled) setEmployeeStartOptions([]); });
    return () => { cancelled = true; };
  }, [cardModalOpen, selectedCardId, employeeStartOptions]);

  /* ---------------------------------------------------------------------- *
   * Endereço do painel (§43, §44)
   *
   * Duas direções, e as duas precisam existir para a navegação do navegador
   * funcionar:
   *
   *   estado → endereço, para que copiar o link, abrir em outra aba e mandar
   *   para um colega levem ao mesmo lugar;
   *   endereço → estado, para que voltar e avançar façam o que a pessoa espera
   *   em vez de sair do produto.
   *
   * `replaceState` na primeira sincronização e `pushState` nas seguintes: sem
   * isso, o primeiro render empilharia uma entrada de histórico idêntica à
   * atual e o botão voltar precisaria de dois cliques para sair da tela.
   * ---------------------------------------------------------------------- */
  const locationSynced = useRef(false);
  const currentPath = useMemo(() => panelPath({
    view: view as PanelView,
    recordId: cardModalOpen && selectedCardId ? selectedCardId : "",
    settings: workspaceModalOpen ? settingsSection as PanelSettingsSection : null,
    companyId: companyFilter === "all" ? "" : companyFilter,
  }), [view, cardModalOpen, selectedCardId, workspaceModalOpen, settingsSection, companyFilter]);

  useEffect(() => {
    const here = `${window.location.pathname}${window.location.search}`;
    if (here === currentPath) { locationSynced.current = true; return; }
    if (locationSynced.current) window.history.pushState(null, "", currentPath);
    else window.history.replaceState(null, "", currentPath);
    locationSynced.current = true;
  }, [currentPath]);

  useEffect(() => {
    function applyLocation() {
      const next = parsePanelPath(window.location.pathname, window.location.search);
      setView(next.view as View);
      setCompanyFilter(next.companyId || "all");
      setWorkspaceModalOpen(Boolean(next.settings));
      if (next.settings) setSettingsSection(next.settings as SettingsSection);
      if (!next.recordId) {
        setCardModalOpen(false);
        setSelectedCardId(null);
      }
    }
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, []);

  /**
   * Abre a demanda que o endereço pediu, assim que ela existe.
   *
   * Só uma vez: depois disso, quem manda na demanda aberta é o clique da
   * pessoa. Reabrir a cada carregamento de snapshot faria o modal ressurgir
   * sozinho depois de a pessoa fechá-lo.
   */
  const deepLinkedCardOpened = useRef(false);
  useEffect(() => {
    if (deepLinkedCardOpened.current || !initialLocation.recordId || !snapshot) return;
    const card = [...snapshot.lists.flatMap((list) => list.cards), ...snapshot.archivedCards]
      .find((item) => item.id === initialLocation.recordId);
    deepLinkedCardOpened.current = true;
    if (card) openCard(card);
    // Demanda que não está no quadro carregado não é erro de endereço: ela pode
    // ser de outro quadro ou de uma empresa fora do escopo da pessoa. A tela
    // abre onde dá para abrir, e quem recusa acesso continua sendo o servidor.
  }, [snapshot, initialLocation.recordId]);

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
  /* A janela do período, calculada uma vez: quatro blocos da Visão geral
     perguntam a mesma coisa, e recalcular `new Date()` em cada um deles abriria
     a porta para dois blocos discordarem sobre onde o dia termina. */
  const periodEnd = useMemo(() => periodWindowEnd(periodFilter), [periodFilter]);
  const inPeriod = useCallback(
    (dueAt: string | null | undefined) => withinPeriod(dueAt, periodEnd),
    [periodEnd],
  );
  const scopedCards = useMemo(
    () => activeCards.filter((card) => (companyFilter === "all" || card.companyId === companyFilter) && inPeriod(card.dueAt)),
    [activeCards, companyFilter, inPeriod],
  );
  const scopedLists = useMemo(() => (snapshot?.lists ?? []).map((list) => ({
    ...list,
    cards: list.cards.filter((card) => (companyFilter === "all" || card.companyId === companyFilter) && inPeriod(card.dueAt)),
  })), [snapshot?.lists, companyFilter, inPeriod]);
  /* O fluxo da competência respeita o seletor de empresa, como todo o resto da
     Visão geral desde `db5300b`. Com uma empresa escolhida, o ciclo mostrado é
     o dela; sem, é o do grupo, e o avanço é o do ciclo menos adiantado. */
  const scopedCycles = useMemo(() => (snapshot?.payrollCycles ?? [])
    .filter((cycle) => companyFilter === "all" || cycle.companyId === companyFilter),
  [snapshot?.payrollCycles, companyFilter]);

  /* Fluxos em andamento (§15), vencimentos (§16) e movimentações (§19) sob os
     mesmos dois filtros do topo. O servidor já entregou tudo recortado por
     acesso; aqui só se aplica a escolha de quem está olhando. */
  const scopedFlows = useMemo(() => (snapshot?.processFlows ?? [])
    .filter((flow) => (companyFilter === "all" || flow.companyId === companyFilter) && inPeriod(flow.dueAt)),
  [snapshot?.processFlows, companyFilter, inPeriod]);
  /* A etapa de cada demanda, para o cartão do quadro (§38, §95).
     O §95 pede que "progressos, SLA, etapa e responsável" fiquem claros no
     quadro, e a etapa era a única das quatro que não aparecia — apesar de a
     §38 separar status de etapa justamente porque são coisas diferentes.

     Nenhuma consulta nova: `processFlows` já resolve o rótulo no servidor
     (nome dado na configuração, senão o do desenho BPMN) para as demandas em
     execução, com o mesmo recorte de empresa. Aqui é só o cruzamento por id.

     A consulta tem teto de 60 demandas em andamento. Passando disso, o cartão
     simplesmente não mostra etapa — melhor a ausência do que um rótulo
     inventado. */
  const flowByCard = useMemo(() => new Map(
    (snapshot?.processFlows ?? []).map((flow) => [flow.cardId, flow]),
  ), [snapshot?.processFlows]);

  const scopedObligations = useMemo(() => (snapshot?.upcomingObligations ?? [])
    .filter((item) => (companyFilter === "all" || item.companyId === companyFilter)
      && withinPeriod(`${item.dueDate}T12:00:00Z`, periodEnd)),
  [snapshot?.upcomingObligations, companyFilter, periodEnd]);
  /* A movimentação é o oposto do vencimento: olha para trás. A janela do
     período vale como "quanto tempo atrás", e `all` mostra tudo o que veio no
     snapshot — que já é uma janela, a do §39. */
  const scopedActivities = useMemo(() => {
    const events = snapshot?.recentActivity ?? [];
    const floor = periodWindowStart(periodFilter);
    if (floor === null) return events;
    return events.filter((event) => {
      const at = Date.parse(event.createdAt);
      return Number.isNaN(at) || at >= floor;
    });
  }, [snapshot?.recentActivity, periodFilter]);
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
  /** O valor do campo: o que está sendo digitado, ou o nome vigente do grupo. */
  const workspaceName = workspaceNameEdit ?? snapshot?.workspace.name ?? "";
  const userInitials = initials(user.displayName);
  const canEdit = snapshot ? ["admin", "member"].includes(snapshot.workspace.role) : false;
  const canComment = snapshot ? ["admin", "member", "guest"].includes(snapshot.workspace.role) : false;
  const isAdmin = snapshot?.workspace.role === "admin";
  const activeDepartments = useMemo(
    () => (snapshot?.areas ?? []).filter((area) => area.status === "active"),
    [snapshot?.areas],
  );
  const selectedDepartmentModules = useMemo(() => {
    if (!snapshot || !memberDepartmentId) return [];
    const department = snapshot.areas.find((area) => area.id === memberDepartmentId);
    const catalog = new Map(snapshot.modules.map((module) => [module.key, module]));
    return (department?.moduleKeys ?? []).map((key) => catalog.get(key)).filter((module) => module !== undefined);
  }, [memberDepartmentId, snapshot]);
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

  /* Os processos que esta pessoa alcança, e em qual deles ela está.
     `visibleProcessGroups` recebe o recorte já pronto — plano e papel — e é o
     único caminho para o menu, para a subnavegação e para os cartões da home.
     Um processo cujas telas estejam todas fora do alcance não aparece em lugar
     nenhum, que é o que a §30 exige. */
  const navGroups = useMemo(() => visibleProcessGroups(visibleViews), [visibleViews]);
  const activeGroup = useMemo(
    () => navGroups.find((group) => group.views.includes(view)) ?? null,
    [navGroups, view],
  );

  /* Atalhos de quem está usando o painel (§67).
     A lista vem do servidor sem recorte de acesso — a decisão de quem vê o quê
     é uma só e mora acima, em `visibleViews`. Aqui ela é aplicada: um destino
     favoritado antes de o plano mudar não pode continuar aparecendo. */
  const shortcuts = useShortcuts(view, Boolean(snapshot));
  const shortcutViews = useMemo(() => {
    const visible = new Set(visibleViews);
    const favorites = shortcuts.favorites.filter((id): id is View => visible.has(id as View));
    // O recente não repete o que já está fixado: o atalho apareceria duas vezes
    // na mesma coluna, e a segunda não acrescenta nada.
    const fixed = new Set<string>([...favorites, "overview"]);
    const recents = shortcuts.recents
      .filter((id): id is View => visible.has(id as View) && !fixed.has(id))
      .slice(0, 3);
    return { favorites, recents };
  }, [shortcuts.favorites, shortcuts.recents, visibleViews]);

  /* Os mesmos atalhos, prontos para a home. O rótulo e o ícone vêm do catálogo
     de telas, que é da casca — a home recebe a lista montada em vez de uma
     cópia do catálogo. */
  const homeShortcuts = useMemo(() => [
    ...shortcutViews.favorites.map((id) => ({ id, label: viewCatalog[id].label, icon: viewCatalog[id].icon, fixed: true })),
    ...shortcutViews.recents.map((id) => ({ id, label: viewCatalog[id].label, icon: viewCatalog[id].icon, fixed: false })),
  ], [shortcutViews]);

  const stats = useMemo(() => {
    const active = scopedCards.filter((card) => card.slaStatus !== "completed");
    const waitingListIds = new Set(snapshot?.lists.filter((list) => list.slaBehavior === "paused").map((list) => list.id) ?? []);
    const completed = scopedCards.filter((card) => card.slaStatus === "completed").length;
    return {
      active: active.length,
      attention: active.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length,
      waiting: active.filter((card) => waitingListIds.has(card.listId)).length,
      /* `null` quando não há demanda no recorte, em vez de 100%.
         Sem nenhuma demanda, "100% dentro do prazo" é uma afirmação sobre nada
         — e é o número mais tranquilizador da tela, exibido justamente quando
         não há evidência para tranquilizar ninguém. Ausência é verdade;
         percentual sobre denominador zero, não. */
      onTime: scopedCards.length
        ? Math.round(((scopedCards.length - scopedCards.filter((card) => card.slaStatus === "overdue").length) / scopedCards.length) * 100)
        : null,
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
      employeeId: card.employeeId ?? "",
      requesterUserId: card.requesterUserId ?? "",
      competence: "",
      title: card.title,
      description: card.description,
      companyId: card.companyId ?? "",
      company: card.company,
      requesterAreaId: card.requesterAreaId ?? "",
      responsibleAreaId: card.responsibleAreaId ?? "",
      processType: card.processType,
      priority: card.priority,
      assigneeName: card.assigneeName,
      dueAt: card.dueAt ?? "",
      listId: card.listId,
      templateId: "",
      /* Vazio ao abrir uma demanda existente: a origem já foi decidida na
         criação e não se troca depois. Trocar a versão de uma demanda em
         andamento reescreveria as etapas por baixo de quem está executando —
         é a mesma razão pela qual a versão instanciada é imutável (§8.3). */
      processVersionId: "",
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
      /* Demanda que nasce de um processo (§10).
         O caminho é o endpoint que já instancia versão publicada: é ele que
         materializa etapas, tarefas, SLA, responsáveis padrão e regras a partir
         da versão — e é por isso que a criação não pode reimplementar nada
         disso aqui. Duplicar essas regras no formulário faria a demanda criada
         pela tela divergir da criada por integração ou automação, que passam
         pelo mesmo endpoint. */
      if (cardForm.processVersionId) {
        /* `mutate` não serve aqui: ele aplica a resposta como se fosse o
           snapshot do workspace, e o `instantiate` devolve `{ instance: { cardId } }`.
           Passar por ele derrubava o painel inteiro para a tela de erro — não é
           hipótese, foi o que aconteceu no primeiro ensaio deste fluxo.
           O caminho certo é o mesmo que o avanço de etapa já usa: chamar a rota
           e então recarregar o snapshot por `/api/workspace`. */
        setBusy(true);
        setError("");
        try {
          const resposta = await fetch(
            `/api/processes/versions/${encodeURIComponent(cardForm.processVersionId)}/instantiate`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
              boardId: cardForm.boardId,
              title: cardForm.title,
              description: cardForm.description,
              companyId: cardForm.companyId,
              employeeId: cardForm.employeeId,
              requesterUserId: cardForm.requesterUserId,
              requesterAreaId: cardForm.requesterAreaId,
              responsibleAreaId: cardForm.responsibleAreaId,
              competence: cardForm.competence,
              priority: cardForm.priority,
              trigger: "manual",
            }) },
          );
          const corpo = await resposta.json() as { error?: string };
          if (!resposta.ok) throw new Error(corpo.error || "Não foi possível iniciar o processo.");
          applySnapshot(await requestSnapshot("/api/workspace"), "Demanda criada a partir do processo.");
          setCardModalOpen(false);
        } catch (causa) {
          setError(causa instanceof Error ? causa.message : "Não foi possível iniciar o processo.");
        } finally {
          setBusy(false);
        }
        return;
      }
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

  /**
   * Cancelar é dizer que este trabalho não vai acontecer (spec: Ações da demanda).
   *
   * Não usa `requestConfirmation` como o arquivamento: aquele diálogo confirma,
   * e aqui é preciso **coletar** o motivo. Sem motivo o servidor recusa, e a
   * restrição no banco recusa junto — cancelamento mudo é a informação que falta
   * exatamente quando alguém pergunta, meses depois, por que não aconteceu.
   */
  async function cancelCard() {
    if (!selectedCardId) return;
    const reason = window.prompt(
      "Por que esta demanda está sendo cancelada?\n\nO motivo fica no histórico e é o que responde a essa pergunta depois.");
    /* `null` é desistência do diálogo, e não deve virar erro na tela. Texto em
       branco é tentativa de cancelar sem dizer por quê, e aí o aviso é devido. */
    if (reason === null) return;
    if (!reason.trim()) { setToast("Cancelamento precisa de um motivo."); return; }
    const next = await mutate(`/api/cards/${selectedCardId}/cancel`,
      { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }, "Demanda cancelada.");
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
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cards/${selectedCardId}/comments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: newComment }),
      });
      const payload = await response.json() as WorkspaceSnapshot & { error?: string; createdCommentId?: string };
      if (!response.ok || !payload.createdCommentId) {
        throw new Error(payload.error || "Não foi possível publicar o comentário.");
      }
      applySnapshot(normalizeWorkspaceSnapshot(payload));
      if (commentAttachment) {
        const form = new FormData();
        form.set("file", commentAttachment);
        form.set("commentId", payload.createdCommentId);
        const upload = await fetch(`/api/cards/${selectedCardId}/attachments`, { method: "POST", body: form });
        const uploaded = await upload.json() as WorkspaceSnapshot & { error?: string };
        if (!upload.ok) throw new Error(uploaded.error || "O comentário foi publicado, mas o anexo não foi enviado.");
        applySnapshot(normalizeWorkspaceSnapshot(uploaded));
      }
      setNewComment("");
      setCommentAttachment(null);
      setToast(commentAttachment ? "Comentário e anexo publicados." : "Comentário publicado.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível publicar o comentário.");
    } finally {
      setBusy(false);
    }
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
    setWorkspaceNameEdit(null);
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
    if (!memberEmail.trim() || !memberDepartmentId || memberModuleKeys.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: memberEmail,
          name: memberName,
          role: memberRole,
          companyIds: memberCompanyIds,
          departmentId: memberDepartmentId,
          moduleKeys: memberModuleKeys,
        }),
      });
      const payload = await response.json() as { error?: string; snapshot?: WorkspaceSnapshot; activation?: { url: string; expiresAt: string; name: string } | null };
      if (!response.ok || !payload.snapshot) throw new Error(payload.error || "Não foi possível criar o usuário.");
      applySnapshot(normalizeWorkspaceSnapshot(payload.snapshot), payload.activation ? "Usuário criado. Compartilhe o link de ativação somente com a pessoa indicada." : "Acesso da equipe atualizado.");
      if (payload.activation) setRecoveryLink(payload.activation);
      setMemberEmail("");
      setMemberName("");
      setMemberRole("member");
      setMemberCompanyIds([]);
      setMemberDepartmentId("");
      setMemberModuleKeys([]);
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

  function selectableDepartmentModuleKeys(departmentId: string) {
    if (!snapshot) return [];
    const department = snapshot.areas.find((area) => area.id === departmentId && area.status === "active");
    if (!department) return [];
    const hardBlocks = new Set(["module_inactive", "workspace_inactive", "subscription_inactive", "not_in_plan", "revoked_by_platform"]);
    const catalog = new Map(snapshot.modules.map((module) => [module.key, module]));
    return department.moduleKeys.filter((key) => {
      const moduleEntry = catalog.get(key);
      return Boolean(moduleEntry && !hardBlocks.has(moduleEntry.reason));
    });
  }

  function selectMemberDepartment(departmentId: string) {
    setMemberDepartmentId(departmentId);
    setMemberModuleKeys(selectableDepartmentModuleKeys(departmentId));
  }

  function updateMemberDepartment(userId: string, memberName: string, departmentId: string) {
    const department = snapshot?.areas.find((area) => area.id === departmentId);
    const moduleKeys = selectableDepartmentModuleKeys(departmentId);
    if (!department || moduleKeys.length === 0) {
      setError("Este departamento precisa ter ao menos um módulo disponível antes de receber usuários.");
      return;
    }
    requestConfirmation({
      title: "Alterar departamento principal?",
      description: `${memberName} passará a acessar somente os módulos de ${department.name}. As liberações anteriores serão substituídas.`,
      confirmLabel: "Alterar departamento",
      action: () => mutate(`/api/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ departmentId, moduleKeys }),
      }, "Departamento e módulos do usuário atualizados."),
    });
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
      setWorkspaceNameEdit(null);
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

  async function uploadAttachment(file: File, commentId?: string) {
    if (!selectedCardId) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      if (commentId) form.set("commentId", commentId);
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

  function authorizeSolidesAttachments() {
    if (!selectedCardId) return;
    requestConfirmation({
      title: "Autorizar anexos da Sólides?",
      description: "Os documentos desta pessoa e a ficha cadastral serão baixados da Sólides e anexados somente a esta demanda. As cópias temporárias do worker serão apagadas após a verificação.",
      confirmLabel: "Autorizar anexos da Sólides",
      action: () => mutate(`/api/cards/${selectedCardId}/solides-attachments/authorize`, { method: "POST" },
        "Autorização registrada. O worker iniciará a transferência."),
    });
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

  async function updateCompany(id: string, payload: Record<string, unknown>) {
    return mutate(`/api/companies/${id}`, { method: "PATCH", body: JSON.stringify(payload) }, "Empresa atualizada.");
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
    <main className={`dashboard-shell theme-dark${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="dashboard-sidebar">
        <button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((current) => !current)} aria-label={sidebarCollapsed ? "Abrir menu lateral" : "Recolher menu lateral"} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? "Abrir menu" : "Recolher menu"}>
          {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </button>
        <button className="brand dashboard-brand" onClick={() => setView("overview")} aria-label="Vinculato — visão geral">
          {/* Variante clara do logotipo: a barra lateral é superfície escura. */}
          <span className="dashboard-brand-logo dashboard-brand-logo-full"><VinculatoLogo size={28} tone="light" /></span>
          <span className="dashboard-brand-logo dashboard-brand-logo-mark"><VinculatoLogo size={28} compact tone="light" /></span>
        </button>
        <div className="sidebar-group-context">
          <span>GRUPO OPERACIONAL</span>
          <strong>{snapshot.workspace.name}</strong>
          <small>{principalCompany ? `Principal: ${principalCompany.tradeName || principalCompany.legalName}` : "Defina a empresa principal"}</small>
        </div>
        <nav aria-label="Navegação do painel">
          {/* A home fica fora de qualquer processo: ela é a porta para todos.
              Pô-la dentro de um deles diria que a visão da operação pertence a
              um processo específico, e ela é justamente o contrário. */}
          <button type="button" title="Início" className={`${view === "overview" ? "active " : ""}sidebar-nav-item sidebar-nav-home mobile-primary`}
            onClick={() => setView("overview")} aria-current={view === "overview" ? "page" : undefined}>
            <span aria-hidden="true"><LayoutDashboard /></span> Início
          </button>

          {/* Atalhos (§67): o caminho curto para quem já sabe onde vai.
              Organizar por processo tornou o menu compreensível e fundo ao
              mesmo tempo — alcançar um destino custa dois níveis. Quem trabalha
              em três destinos o dia inteiro paga esse preço dezenas de vezes
              por dia, e é para essa pessoa que este bloco existe.
              Ele não aparece vazio: um rótulo "ATALHOS" sobre nada anuncia uma
              seção que não existe, e no primeiro dia de uso é exatamente isso
              que haveria. */}
          {(shortcutViews.favorites.length > 0 || shortcutViews.recents.length > 0) && (
            <div className="sidebar-nav-group sidebar-shortcuts">
              <span className="sidebar-nav-section">ATALHOS</span>
              {shortcutViews.favorites.map((id, index) => {
                const entry = viewCatalog[id];
                const ItemIcon = entry.icon;
                return <button key={`fav-${id}`} type="button" title={entry.label}
                  style={{ "--stagger-index": index } as CSSProperties}
                  className={`${view === id ? "active " : ""}sidebar-nav-item sidebar-shortcut mobile-secondary`}
                  onClick={() => setView(id)} aria-current={view === id ? "page" : undefined}>
                  <span aria-hidden="true"><ItemIcon /></span> {entry.label}
                  <Star aria-hidden="true" className="sidebar-shortcut-mark" />
                </button>;
              })}
              {shortcutViews.recents.map((id, index) => {
                const entry = viewCatalog[id];
                const ItemIcon = entry.icon;
                return <button key={`recent-${id}`} type="button" title={`${entry.label} — visitado recentemente`}
                  style={{ "--stagger-index": shortcutViews.favorites.length + index } as CSSProperties}
                  className={`${view === id ? "active " : ""}sidebar-nav-item sidebar-shortcut sidebar-shortcut-recent mobile-secondary`}
                  onClick={() => setView(id)} aria-current={view === id ? "page" : undefined}>
                  <span aria-hidden="true"><ItemIcon /></span> {entry.label}
                  <History aria-hidden="true" className="sidebar-shortcut-mark" />
                </button>;
              })}
            </div>
          )}

          {/* Duas famílias, cada uma com o próprio rótulo, e nenhuma desenhada
              quando fica vazia — um rótulo sozinho anuncia algo que não existe.
              O menu mostra o *processo*; os módulos dele só aparecem quando ele
              é o processo aberto (§66). Sem isso a barra volta a ter quinze
              itens simultâneos, que é o que a §64 pede para acabar. */}
          {(["process", "area", "support"] as const).map((kind) => {
            const groups = navGroups.filter((group) => group.kind === kind);
            if (!groups.length) return null;
            return <div key={kind} className="sidebar-nav-group">
              <span className="sidebar-nav-section">{processKindLabels[kind]}</span>
              {groups.map((group) => {
                const GroupIcon = processGroupIcons[group.id] ?? Blocks;
                const open = activeGroup?.id === group.id;
                const entrance = group.views[0];
                const groupBadge = group.views.reduce((total, id) => total + (navBadges[id as View] ?? 0), 0);
                const sub = hasSubNavigation(group);
                return <div key={group.id} className="sidebar-process">
                  <button type="button" title={group.label}
                    className={`${open && (!sub || view === entrance) ? "active " : ""}${open ? "open " : ""}sidebar-nav-item sidebar-process-item ${mobilePrimaryViews.has(entrance as View) ? "mobile-primary" : "mobile-secondary"}`}
                    onClick={() => setView(entrance as View)}
                    aria-current={open && !sub ? "page" : undefined}
                    aria-expanded={sub ? open : undefined}>
                    <span aria-hidden="true"><GroupIcon /></span> {group.label}
                    {groupBadge ? <b>{groupBadge}</b> : null}
                  </button>
                  {/* Os módulos do processo aberto. `hidden` em vez de não
                      renderizar: o `details` da navegação compacta já
                      alcança todos, e remontar a lista a cada troca perderia
                      a animação de entrada dela. */}
                  {sub && open && <div className="sidebar-process-views" role="group" aria-label={`Módulos de ${group.label}`}>
                    {group.views.map((id, index) => {
                      const entry = viewCatalog[id as View];
                      const badge = navBadges[id as View];
                      return <button key={id} type="button" style={{ "--stagger-index": index } as CSSProperties}
                        className={`${view === id ? "active " : ""}sidebar-process-view`}
                        onClick={() => setView(id as View)} aria-current={view === id ? "page" : undefined}>
                        {entry.label}{badge ? <b>{badge}</b> : null}
                      </button>;
                    })}
                  </div>}
                </div>;
              })}
            </div>;
          })}
          <details ref={mobileNavigationRef} className="sidebar-mobile-more">
            <summary className={mobilePrimaryViews.has(view) ? "" : "active"} aria-label="Abrir todos os módulos">
              <span aria-hidden="true"><MoreHorizontal /></span><span>Mais</span>
            </summary>
            <div className="sidebar-mobile-more-panel">
              {navGroups.map((group) => {
                const items = group.views.filter((id) => !mobilePrimaryViews.has(id as View));
                if (!items.length) return null;
                return <section key={group.id} aria-labelledby={`mobile-nav-${group.id}`}>
                  <span id={`mobile-nav-${group.id}`}>{group.label.toUpperCase()}</span>
                  <div>{items.map((id) => {
                    const entry = viewCatalog[id as View];
                    const Icon = entry.icon;
                    const badge = navBadges[id as View];
                    return <button key={id} type="button" className={view === id ? "active" : ""}
                      onClick={() => { setView(id as View); mobileNavigationRef.current?.removeAttribute("open"); }}
                      aria-current={view === id ? "page" : undefined}>
                      <span aria-hidden="true"><Icon /></span><span>{entry.label}</span>{badge ? <b>{badge}</b> : null}
                    </button>;
                  })}</div>
                </section>;
              })}
            </div>
          </details>
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
          <div className="sidebar-structure-summary"><i>{workspaceInitials}</i><span><strong>{principalCompany?.tradeName || principalCompany?.legalName || "Sem principal"}</strong><small>{plural(snapshot.companies.length, "empresa no grupo", "empresas no grupo")}</small></span></div>
        </div>
        <div className="sidebar-account">
          <span className="user-avatar">{userInitials}</span>
          <span><strong>{user.displayName}</strong><small>{user.email}</small></span>
          <div className="sidebar-account-actions">
            {/* Configurações na navegação, e não só atrás do avatar (§46).
                O avatar é o lugar onde se procura "minha conta"; quem procura
                "configurar o grupo" olha o menu, não a foto. Enquanto a única
                porta era o avatar, nove seções de configuração ficavam a um
                clique que ninguém sabia que existia. */}
            <button type="button" className="switch-account-button"
              onClick={openWorkspaceSettings}
              aria-label="Abrir configurações" title="Configurações"><Settings aria-hidden="true" /></button>
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
            {/* Período (§13). Só aparece na Visão geral porque é só lá que ele
                manda: exibi-lo no quadro sugeriria um recorte que o quadro não
                aplica, e filtro que não filtra é pior que filtro nenhum. */}
            {view === "overview" && <label className="header-period-select"><CalendarClock aria-hidden="true" /><select aria-label="Selecionar período" value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value as OverviewPeriod)}>{overviewPeriods.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>}
            <button className="global-search-trigger" aria-label="Busca global" title="Busca global" onClick={() => setSearchOpen(true)}><Search aria-hidden="true" /><span>Buscar demanda, empresa ou CNPJ</span><kbd>⌘ K</kbd></button>
            <button aria-label="Notificações" title="Notificações" onClick={() => setNotificationsOpen(true)}><Bell aria-hidden="true" />{snapshot.notifications.some((item) => !item.readAt) && <i />}</button>
            <button className="help-button" aria-label="Abrir o assistente" title="Ajuda" onClick={() => setAssistantSignal((current) => current + 1)}><CircleHelp aria-hidden="true" /></button>
            {/* O rótulo muda com o papel porque a porta é a mesma, mas o que
                há atrás dela não: para o administrador este botão é a única
                entrada para empresas, usuários, colunas e automações, e dizer
                só "Perfil e segurança" escondia tudo isso. */}
            <button className="header-profile" aria-label={isAdmin ? "Abrir configurações do workspace e do perfil" : "Abrir perfil e segurança"} title={isAdmin ? "Configurações do workspace" : "Perfil e segurança"} onClick={openSecuritySettings}><span>{userInitials}</span></button>
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
          <ProcessTabsProvider>{(tabsTarget) => <>
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
          {/* Cabeçalho do processo (§69, §70).
              Fica FORA da transição de módulo de propósito: trocar de aba
              dentro do mesmo processo não pode fazer o cabeçalho dele piscar,
              senão a troca de contexto — que é o que a §69 quer comunicar —
              deixa de se distinguir da troca de tela dentro do contexto. */}
          {/* Cabeçalho do processo (§69, §70), agora para todo processo.
              Antes ele só aparecia quando o processo tinha mais de um módulo,
              e o de um módulo só — Controle de EPI, com dez destinos próprios —
              escondia os seus numa barra dentro do módulo, 200px abaixo e com
              outro desenho. Eram duas gramáticas para "trocar de assunto dentro
              do processo". Agora o cabeçalho é um só: ele mostra os módulos
              quando há mais de um, e empresta o lugar ao módulo quando há um. */}
          {activeGroup && (
            <section className="process-context" aria-label={`Processo ${activeGroup.label}`}>
              <div className="process-context-identity">
                <span aria-hidden="true">{(() => {
                  const GroupIcon = processGroupIcons[activeGroup.id] ?? Blocks;
                  return <GroupIcon />;
                })()}</span>
                <div>
                  <strong>{activeGroup.label}</strong>
                  <p>{activeGroup.description}</p>
                </div>
                {/* Onde se fixa um atalho (§67). Fica aqui, e não no menu,
                    porque é aqui que a pessoa está quando descobre que volta
                    sempre a esta tela — a decisão nasce do uso, não da lista. */}
                <button type="button" className="process-context-pin"
                  onClick={() => shortcuts.toggleFavorite(view)}
                  aria-pressed={shortcuts.isFavorite(view)}
                  title={shortcuts.isFavorite(view) ? "Remover dos atalhos" : "Fixar nos atalhos"}>
                  <Star aria-hidden="true" />
                  <span className="sr-only">
                    {shortcuts.isFavorite(view)
                      ? `Remover ${header.title} dos atalhos`
                      : `Fixar ${header.title} nos atalhos`}
                  </span>
                </button>
              </div>
              {hasSubNavigation(activeGroup) ? (
                <AnimatedTabs
                  label={`Módulos de ${activeGroup.label}`}
                  tabs={activeGroup.views.map((id) => ({
                    id: id as View,
                    label: viewCatalog[id as View].label,
                    icon: viewCatalog[id as View].icon,
                    badge: navBadges[id as View],
                  }))}
                  active={view}
                  onChange={setView}
                />
              ) : (
                /* Processo de um módulo só: o lugar das abas fica reservado e
                   quem o preenche é o módulo, que é dono dos contadores. */
                <div className="process-context-slot" ref={tabsTarget} />
              )}
            </section>
          )}

          {/* `transitionKey` remonta este bloco a cada troca de módulo, o que
              reinicia a animação de entrada. Sem a chave, a transição só
              rodaria na primeira vez. */}
          <PageTransition transitionKey={view} className="view-transition">
          {/* A tela que desenha o próprio cabeçalho não recebe este (§41). */}
          {!header.ownHeader && <div className="dashboard-heading">
            <div><span className="dashboard-eyebrow">{header.eyebrow}</span><h1>{view === "overview" ? `Olá, ${user.displayName.split(" ")[0] || "equipe"}.` : header.title}</h1><p>{view === "overview" ? "Veja as prioridades da operação e avance com segurança." : header.description}</p><div className={`dashboard-sync-status ${realtimeStatus}`} aria-live="polite"><RefreshCw aria-hidden="true" /><span>{formatSyncStatus(lastUpdatedAt, realtimeStatus)}</span></div></div>
            <div className="dashboard-date"><span>HOJE</span><strong>{today}</strong></div>
          </div>}

          {view === "overview" && <OverviewView cycles={scopedCycles} integrations={snapshot.integrations}
            processes={navGroups} processBadges={navBadges} onOpenProcess={(target) => setView(target as View)}
            shortcuts={homeShortcuts}
            flows={scopedFlows} obligations={scopedObligations} periodLabel={overviewPeriodLabel(periodFilter)}
            onOpenCard={(cardId) => { const card = activeCards.find((item) => item.id === cardId); if (card) openCard(card); }}
            onFocus={(target, sla) => {
              /* O indicador leva ao módulo já recortado (§14). Zerar os outros
                 filtros do quadro é parte do contrato: chegar de um número e
                 encontrar uma lista menor que ele, porque um filtro antigo
                 continuava ligado, faz o indicador parecer errado. */
              setAssigneeFilter("all"); setProcessFilter("all"); setDueFilter("all");
              setSlaFilter(sla); setView(target as View);
            }}
            onNavigate={(target) => setView(target)} cards={scopedCards} companies={snapshot.companies} lists={scopedLists} activities={scopedActivities} stats={stats} onOpen={openCard} onOpenBoard={() => setView("board")} onNew={openNewCard} canEdit={canEdit} companyId={companyFilter === "all" ? "" : companyFilter} scopeLabel={companyFilter === "all" ? companyScopeLabel : (snapshot.companies.find((company) => company.id === companyFilter)?.tradeName || snapshot.companies.find((company) => company.id === companyFilter)?.legalName || "Empresa selecionada")} />}

          {view === "processManagement" && <ProcessManagementView role={snapshot.workspace.role} />}

          {view === "processes" && <OperationsView role={snapshot.workspace.role} />}

          {view === "auxiliary" && <AuxiliaryModulesView role={snapshot.workspace.role} />}

          {view === "psychologistPayments" && <PaymentsView role={snapshot.workspace.role} module="psychology" />}

          {isContractorSection(view) && <PaymentsView role={snapshot.workspace.role} module="contractors" section={view}
            focus={contractorPaymentFocus} />}

          {view === "timeTracking" && <TimeTrackingView role={snapshot.workspace.role} />}

          {view === "epi" && <EpiControlView role={snapshot.workspace.role} />}

          {view === "integrations" && <IntegrationsView role={snapshot.workspace.role} />}

          {/* As três centrais operacionais. Elas são camadas de leitura sobre o
              que já existe: nenhuma delas cria objeto de trabalho novo, e cada
              item que mostram é resolvido na tela do módulo dono dele. */}
          {view === "work" && <WorkCenterView onOpenCompanyFilter={(companyId) => setCompanyFilter(companyId || "all")} />}

          {view === "triage" && <TriageView initialItemId={initialLocation.view === "triage" ? initialLocation.recordId : ""} />}

          {view === "agents" && <AgentsView />}

          {view === "registrations" && <RegistrationsView role={snapshot.workspace.role}
            onOpenContractorPayment={(target) => { setContractorPaymentFocus(target); setView("contractorClosings"); }} />}

          {view === "board" && (
            <>
              <div className="dashboard-stats">
                <article><span>Demandas ativas</span><strong>{stats.active}</strong><small>{plural(stats.completed, "concluída", "concluídas")}</small></article>
                <article><span>Exigem atenção</span><strong>{stats.attention}</strong><small className="warning-text">SLA hoje ou atrasado</small></article>
                <article><span>Aguardando terceiros</span><strong>{stats.waiting}</strong><small>SLA pausado</small></article>
                <article><span>Dentro do prazo</span><strong>{stats.onTime === null ? "—" : `${stats.onTime}%`}</strong><small className="safe-text">{stats.onTime === null ? "Nenhuma demanda no recorte" : "Das demandas em aberto"}</small></article>
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
                            <div className="dashboard-task-labels">{referenceLabel(card) && <span className="dashboard-card-reference">{referenceLabel(card)}</span>}<span className={processColors[card.processType] ?? "gray"}>{card.processType}</span>{card.priority === "urgent" && <span className="urgent">URGENTE</span>}{card.labels.slice(0, 1).map((label) => <span className="custom-label" style={{ color: label.color, backgroundColor: `${label.color}18` }} key={label.id}>{label.name}</span>)}</div>
                            <h2>{card.title}</h2>
                            <p>{card.company || "Sem empresa informada"}{card.companyId && snapshot.companies.find((company) => company.id === card.companyId)?.taxId ? <small> • {snapshot.companies.find((company) => company.id === card.companyId)?.taxId}</small> : null}</p>
                            <DemandAreaFlow card={card} areas={snapshot.areas} />
                            {/* Processo, etapa e progresso — as três coisas que a
                                especificação pede no cartão e que já existiam
                                calculadas no servidor, sem chegar à tela.

                                Processo e etapa são coisas diferentes e ficam em
                                linhas diferentes: o processo diz *que trabalho é
                                este*, a etapa diz *onde ele está*. O progresso
                                conta as tarefas já instanciadas — as das etapas
                                percorridas —, não as do processo inteiro, porque
                                as etapas à frente ainda não geraram tarefa. */}
                            {flowByCard.get(card.id) && <CardProcessLine flow={flowByCard.get(card.id)!} />}
                            {card.customValues.matricula && <small className="dashboard-card-employee">Colaborador: {card.customValues.matricula}</small>}
                            <div className="dashboard-task-bottom"><span className={`dashboard-sla ${card.slaStatus}${card.dueAt ? " has-due" : ""}`}><Clock3 aria-hidden="true" /> {slaLabel(card)}</span><span className="dashboard-check" title="Checklist concluído"><ListChecks aria-hidden="true" /> {completed}/{card.checklist.length}</span>{card.attachments.length > 0 && <span className="dashboard-comments" title="Anexos"><Paperclip aria-hidden="true" /> {card.attachments.length}</span>}{card.comments.length > 0 && <span className="dashboard-comments" title="Comentários"><MessageCircle aria-hidden="true" /> {card.comments.length}</span>}{(() => {
                              /* Avatar com inicial ao lado de "Sem responsável" é
                                 contradição: o círculo afirma que há alguém. Sem
                                 responsável, fica só o texto. */
                              const dono = card.assignees[0]?.name || card.assigneeName;
                              return <span className="dashboard-task-owner" title={dono || "Sem responsável"}>
                                {dono && <span className="dashboard-mini-avatar">{initials(dono)}</span>}
                                <b className={dono ? "" : "dashboard-owner-none"}>{dono || "Sem responsável"}</b>
                                {card.assignees.length > 1 && <small className="avatar-more">+{card.assignees.length - 1}</small>}
                              </span>;
                            })()}</div>
                          </article>
                        );
                      })}
                      {canEdit && <button className="dashboard-add-card" onClick={() => { setCardForm({ ...emptyCardForm, boardId: snapshot.board.id, listId: list.id }); setSelectedCardId(null); setCardTab("details"); setCardModalOpen(true); }}><Plus aria-hidden="true" /> Adicionar demanda</button>}
                    </div>
                  </section>
                  );
                })}
              </div>}
              {boardMode === "table" && <DemandTableView cards={filteredActiveCards} lists={snapshot.lists} areas={snapshot.areas} onOpen={openCard} />}
              {boardMode === "calendar" && <DemandCalendarView cards={filteredActiveCards} onOpen={openCard} />}
              {boardMode === "process" && <ProcessTablesView cards={filteredActiveCards} lists={snapshot.lists} areas={snapshot.areas} onOpen={openCard} />}
            </>
          )}

          {view === "inbox" && <InboxView items={snapshot.inbox} busy={busy} canEdit={canEdit} onConvert={convertInbox} onNew={() => setInboxModalOpen(true)} />}
          {view === "planner" && <PlannerView cards={activeCards} blocks={snapshot.plannerBlocks} connections={snapshot.calendarConnections} onOpen={openCard} onCreateBlock={(payload) => mutate("/api/planner/blocks", { method: "POST", body: JSON.stringify(payload) }, "Bloco adicionado ao planner.")} onDeleteBlock={(id) => mutate(`/api/planner/blocks/${id}`, { method: "DELETE" }, "Bloco removido do planner.")} onSaveConnection={(payload) => mutate("/api/calendar/connections", { method: "POST", body: JSON.stringify(payload) }, "Calendário externo configurado. A sincronização será ativada após a conexão OAuth.")} />}
          {view === "payroll" && <PayrollView companies={snapshot.companies} metrics={snapshot.hrMetrics} busy={busy} canEdit={canEdit} onSaveMetric={saveHrMetric} onImportPayroll={(body) => mutate("/api/hr-metrics/import/pdf", { method: "POST", body }, "Extrato da folha importado e painéis atualizados.")} />}
          {view === "indicators" && <IndicatorsView canExportWorkspace={isAdmin} cards={scopedCards} companyId={companyFilter === "all" ? "" : companyFilter} scopeLabel={companyFilter === "all" ? companyScopeLabel : (snapshot.companies.find((item) => item.id === companyFilter)?.tradeName || snapshot.companies.find((item) => item.id === companyFilter)?.legalName || "Empresa selecionada")} rules={snapshot.rules} busy={busy} canManageRules={isAdmin} onToggleRule={toggleRule} onExport={exportCsv} hrMetrics={snapshot.hrMetrics} companies={snapshot.companies} />}
          {/* O histórico completo (spec: "Ver histórico completo"). Carrega
              sob demanda, e não junto do snapshot: a trilha cresce sem limite,
              e trazê-la na abertura faria todo mundo pagar por uma tela que
              quase ninguém abre. */}
          {view === "history" && <HistoryView onOpenCard={(cardId) => {
            const card = allCards.find((item) => item.id === cardId);
            if (card) openCard(card);
          }} />}
          </PageTransition>
          </>}</ProcessTabsProvider>
        </div>
      </section>

      {error && <div className="workspace-toast error" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
      {toast && <div className="workspace-toast" role="status"><span>✓</span>{toast}</div>}
      {/* O teto de favoritos precisa ser dito: sem o recado, marcar o nono
          simplesmente não faria nada, e a pessoa concluiria que o botão está
          quebrado. */}
      {shortcuts.notice && <div className="workspace-toast error" role="alert">
        <span>!</span>{shortcuts.notice}
        <button type="button" onClick={shortcuts.dismissNotice} aria-label="Fechar aviso">×</button>
      </div>}
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
            <div className="notification-actions"><span>{plural(snapshot.notifications.filter((item) => !item.readAt).length, "não lida", "não lidas")}</span><button disabled={busy || !snapshot.notifications.some((item) => !item.readAt)} onClick={() => void markAllNotifications()}>Marcar todas como lidas</button></div>
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
        /* A demanda passou de modal centrada a gaveta à direita, como a maquete
           pede. A diferença não é de gosto: a modal centrada tapa o quadro, e
           quem trabalha uma fila abre demanda atrás de demanda comparando com o
           que está atrás. A gaveta deixa a coluna de origem visível.

           `role="dialog"` e `aria-modal` continuam: para quem usa leitor de
           tela ou teclado, o comportamento é o mesmo — o foco fica preso
           dentro e Esc fecha. O que muda é a posição na tela. */
        <div className="workspace-modal-backdrop demand-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCardModalOpen(false); }}>
          <section className="workspace-modal card-modal demand-detail-modal demand-drawer" role="dialog" aria-modal="true" aria-labelledby="card-modal-title">
            <header><div><span>{selectedCard ? `Demanda • ${selectedCard.processType}` : "Nova demanda"}{selectedCard && referenceLabel(selectedCard) && <b className="demand-reference">{referenceLabel(selectedCard)}</b>}{selectedCard?.cancelledAt && <b className="demand-cancelled" title={selectedCard.cancellationReason}>CANCELADA</b>}</span><h2 id="card-modal-title">{selectedCard ? selectedCard.title : "Adicionar à fila"}</h2>{selectedCard && <p className="demand-detail-meta">{snapshot.lists.find((list) => list.id === selectedCard.listId)?.name ?? "Sem status"} • {selectedCard.company || "Sem empresa vinculada"} • {snapshot.areas.find((area) => area.id === selectedCard.requesterAreaId)?.name || "Sem área solicitante"} → {snapshot.areas.find((area) => area.id === selectedCard.responsibleAreaId)?.name || "Sem área responsável"}</p>}</div><button onClick={() => setCardModalOpen(false)} aria-label="Fechar">×</button></header>
            {selectedCard && <nav className="card-dialog-tabs" aria-label="Seções da demanda"><button className={cardTab === "details" ? "active" : ""} onClick={() => setCardTab("details")}>Detalhes</button><button className={cardTab === "process" ? "active" : ""} onClick={() => setCardTab("process")}>Processo</button><button className={cardTab === "checklist" ? "active" : ""} onClick={() => setCardTab("checklist")}>Checklist <b>{selectedCard.checklist.filter((item) => item.completed).length}/{selectedCard.checklist.length}</b></button><button className={cardTab === "attachments" ? "active" : ""} onClick={() => setCardTab("attachments")}>Anexos <b>{selectedCard.attachments.length}</b></button><button className={cardTab === "activity" ? "active" : ""} onClick={() => setCardTab("activity")}>Atividade <b>{selectedCard.comments.length + selectedCard.activities.length}</b></button></nav>}
            <div className="card-modal-body single">
              {selectedCard && (() => {
                /* O fluxo desta demanda já vem no snapshot — a mesma fonte que
                   a Visão geral usa. Nenhuma consulta nova para desenhar a
                   barra: quando a demanda não nasceu de processo, não há fluxo,
                   e a faixa mostra o checklist no lugar do progresso da versão. */
                const fluxo = flowByCard.get(selectedCard.id);
                const feitos = selectedCard.checklist.filter((item) => item.completed).length;
                const pendentes = selectedCard.checklist.length - feitos;
                return <>
                  {/* Progresso da demanda (maquete 4).
                      A barra sai do total que a VERSÃO do processo prevê, e não
                      das tarefas já materializadas: "7 de 18" continua sendo de
                      18 enquanto a demanda anda. Sem tarefa nenhuma prevista,
                      barra nenhuma é desenhada — barra vazia se lê como "0%
                      concluído", que afirma progresso sem denominador. */}
                  <section className="demand-progress" aria-label="Progresso da demanda">
                    <header>
                      <span>PROGRESSO DA DEMANDA</span>
                      <strong>{fluxo && fluxo.tasksTotal > 0
                        ? `${fluxo.tasksDone} de ${fluxo.tasksTotal} tarefas · ${fluxo.progress}%`
                        : selectedCard.checklist.length
                          ? `${feitos} de ${selectedCard.checklist.length} itens do checklist`
                          : "Sem tarefas previstas"}</strong>
                    </header>
                    {fluxo && fluxo.tasksTotal > 0 && <div className="demand-progress-bar" role="img"
                      aria-label={`${fluxo.progress}% concluído, ${fluxo.tasksDone} de ${fluxo.tasksTotal} tarefas`}>
                      <i style={{ width: `${Math.max(0, Math.min(100, fluxo.progress))}%` }} />
                    </div>}
                  </section>

                  {/* Os oito campos da maquete, em texto e lado a lado.
                      Eles existiam espalhados pelo formulário de edição, onde
                      só se lê um campo de cada vez porque cada um é um controle.
                      Aqui é leitura: quem abre a demanda quer saber de quem ela
                      é e quando vence antes de decidir mexer em alguma coisa.

                      "Próxima etapa" não aparece aqui: as transições possíveis
                      dependem de bloqueios que só o servidor sabe avaliar, e
                      elas já são carregadas — com o motivo de cada bloqueio — na
                      aba Processo. Repetir o rótulo aqui, sem o bloqueio junto,
                      prometeria um avanço que pode não estar liberado. */}
                  <dl className="demand-fields">
                    <div><dt>Responsável</dt><dd>{selectedCard.assignees.map((item) => item.name).join(", ") || selectedCard.assigneeName || "Não atribuído"}</dd></div>
                    <div><dt>Prazo</dt><dd>{selectedCard.dueAt ? formatDue(selectedCard.dueAt) : "Sem prazo"}</dd></div>
                    <div><dt>Criada em</dt><dd>{formatMoment(selectedCard.createdAt)}</dd></div>
                    <div><dt>Competência</dt><dd>{selectedCard.competence ? competenceLabel(selectedCard.competence) : "Sem competência"}</dd></div>
                    <div><dt>Prioridade</dt><dd>{PRIORITY_LABELS[selectedCard.priority] ?? selectedCard.priority}</dd></div>
                    <div><dt>Tipo</dt><dd>{selectedCard.processType}</dd></div>
                    <div className="demand-field-wide">
                      <dt>Etapa atual</dt>
                      <dd>{fluxo
                        ? <button type="button" className="demand-field-link" onClick={() => setCardTab("process")}>
                            {fluxo.stepLabel || "Não iniciada"}
                            {fluxo.versionNumber ? <em>v{fluxo.versionNumber}</em> : null}
                          </button>
                        : "Demanda avulsa, sem processo"}</dd>
                    </div>
                  </dl>

                  <section className="demand-detail-summary">
                    <div className={`demand-sla-state ${selectedCard.slaStatus}`}><span>SLA</span><strong>{slaLabel(selectedCard)}</strong><small>{selectedCard.slaStatus === "paused" ? selectedCard.slaPausedReason || "Pausa justificada" : selectedCard.dueAt ? `Vencimento: ${formatDue(selectedCard.dueAt)}` : "Defina um prazo para controlar o SLA"}</small></div>
                    <div className="demand-document-state"><span>DOCUMENTOS</span><strong>{feitos} aprovados</strong><small>{pendentes} pendente(s) • {selectedCard.attachments.length} anexo(s)</small></div>
                  </section>
                </>;
              })()}
              {(!selectedCard || cardTab === "details") &&
              <form className={`card-form ${!canEdit ? "read-only" : ""}`} onSubmit={saveCard}>
                {/* Origem da demanda (§10): o processo publicado.
                    A demanda é a EXECUÇÃO de um processo (§4), então escolher
                    qual vem antes de tudo. Agrupado por área porque é a área
                    que responde pelo trabalho, e porque "Admissão" pode existir
                    em duas áreas com regras diferentes — sem o agrupamento, as
                    duas apareceriam como o mesmo nome repetido.
                    Escolher um processo faz a criação passar pelo endpoint que
                    instancia a versão: etapas, tarefas, SLA e responsáveis
                    padrão vêm de lá, e não daqui. */}
                {!selectedCard && startableProcesses !== null && startableProcesses.length > 0 && (
                  <label className="full">Processo
                    <select value={cardForm.processVersionId} disabled={!canEdit}
                      onChange={(event) => setCardForm({ ...cardForm, processVersionId: event.target.value })}>
                      <option value="">Demanda avulsa — sem processo</option>
                      {[...new Set(startableProcesses.map((item) => item.areaName))].sort().map((area) => (
                        <optgroup label={area} key={area}>
                          {startableProcesses.filter((item) => item.areaName === area).map((item) => (
                            <option value={item.versionId} key={item.versionId}>
                              {item.name} · {item.versionLabel} · {plural(item.stepCount, "etapa", "etapas")}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <small className="card-form-hint">{cardForm.processVersionId
                      ? "A etapa inicial, suas tarefas e o SLA vêm da versão publicada deste processo."
                      : "Sem processo, a demanda nasce solta: você define as etapas à mão."}</small>
                  </label>
                )}
                {!selectedCard && !cardForm.processVersionId && <label className="full">Começar com um template<select value={cardForm.templateId} onChange={(event) => { const template = snapshot.templates.find((item) => item.id === event.target.value); setCardForm({ ...cardForm, templateId: event.target.value, processType: template?.processType ?? cardForm.processType, description: template?.description ?? cardForm.description }); }}><option value="">Demanda em branco</option>{snapshot.templates.filter((item) => item.active).map((template) => <option value={template.id} key={template.id}>{template.name} • SLA {template.defaultSlaDays} dia(s) útil(eis)</option>)}</select></label>}
                {!selectedCard && <label className="full">Processo operacional<select value={cardForm.boardId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, boardId: event.target.value, listId: "" })}>{snapshot.boards.map((board) => <option value={board.id} key={board.id}>{board.boardType === "process" ? `Processo: ${board.name}` : `Quadro geral: ${board.name}`}</option>)}</select><small className="card-process-helper">A demanda será criada e movimentada somente nas colunas deste processo.</small></label>}
                <label className="full">Título da demanda<input autoFocus value={cardForm.title} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, title: event.target.value })} placeholder="Ex.: Conciliar colaborador com o ERP" required /></label>
                <label className="full">Descrição<textarea value={cardForm.description} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, description: event.target.value })} placeholder="Contexto e orientações para execução" rows={4} /></label>
                {/* O tipo vigente entra na lista quando não estiver nela.
                    Demanda criada a partir de um processo publicado recebe o
                    CÓDIGO do processo como tipo — `EPI_ENTREGA`, e não um dos
                    sete rótulos escritos aqui. O `<select>` sem opção
                    correspondente cai na primeira, e a tela passava a mostrar
                    "CONCILIAÇÃO CADASTRAL" logo abaixo de um campo que dizia
                    "EPI_ENTREGA": dois valores para o mesmo dado na mesma
                    tela. Pior que a divergência visual, salvar dali gravava a
                    primeira opção por cima do tipo real, sem ninguém pedir.

                    A opção extra é separada das sete por `optgroup` para não
                    parecer parte do catálogo padrão. */}
                {!cardForm.processVersionId &&
                  <label>Tipo de processo<select value={cardForm.processType} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, processType: event.target.value })}>
                    {cardForm.processType && !processTypeOptions.includes(cardForm.processType)
                      && <optgroup label="Tipo vigente desta demanda"><option>{cardForm.processType}</option></optgroup>}
                    <optgroup label="Tipos do catálogo">
                      {processTypeOptions.map((tipo) => <option key={tipo}>{tipo}</option>)}
                    </optgroup>
                  </select></label>}
                <label>Empresa<select value={cardForm.companyId} disabled={!canEdit} onChange={(event) => { const company = snapshot.companies.find((item) => item.id === event.target.value); setCardForm({ ...cardForm, companyId: event.target.value, company: company ? (company.tradeName || company.legalName) : cardForm.company }); }}><option value="">Sem empresa vinculada</option>{snapshot.companies.filter((company) => company.status === "active" || company.id === cardForm.companyId).map((company) => <option value={company.id} key={company.id}>{company.tradeName || company.legalName}{company.taxId ? ` • ${company.taxId}` : ""}{company.status !== "active" ? " (inativa)" : ""}</option>)}</select></label>
                {!selectedCard && <label>Colaborador<select value={cardForm.employeeId} disabled={!canEdit || employeeStartOptions === null} onChange={(event) => setCardForm({ ...cardForm, employeeId: event.target.value })}><option value="">{employeeStartOptions === null ? "Carregando..." : "Não informado"}</option>{(employeeStartOptions ?? []).filter((employee) => !cardForm.companyId || employee.company_id === cardForm.companyId).map((employee) => <option key={employee.id} value={employee.id}>{employee.social_name || employee.full_name} • {employee.registration_number}</option>)}</select></label>}
                {!selectedCard && <label>Solicitante<select value={cardForm.requesterUserId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, requesterUserId: event.target.value })}><option value="">Usuário atual</option>{snapshot.members.map((member) => <option key={member.userId} value={member.userId}>{member.name} • {member.email}</option>)}</select></label>}
                {!selectedCard && <label>Competência<input type="month" value={cardForm.competence} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, competence: event.target.value })} /></label>}
                <label>Área solicitante<select value={cardForm.requesterAreaId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, requesterAreaId: event.target.value })}><option value="">Não informada</option>{snapshot.areas.filter((area) => area.status === "active" || area.id === cardForm.requesterAreaId).map((area) => <option value={area.id} key={area.id}>{area.name} · {area.code}</option>)}</select></label>
                <label>Área responsável<select value={cardForm.responsibleAreaId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, responsibleAreaId: event.target.value })}><option value="">Não informada</option>{snapshot.areas.filter((area) => area.status === "active" || area.id === cardForm.responsibleAreaId).map((area) => <option value={area.id} key={area.id}>{area.name} · {area.code}</option>)}</select></label>
                {!cardForm.processVersionId && <label>Prazo<input id="card-due-at" type="datetime-local" value={dueInputValue(cardForm.dueAt, snapshot.settings.dayEnd)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, dueAt: event.target.value })} /></label>}
                {selectedCard?.slaTargetMinutes ? <p className="card-sla-target full">SLA configurado: <strong>{formatWorkingMinutes(selectedCard.slaTargetMinutes)}</strong> de expediente. Pausas justificadas não entram na contagem.</p> : null}
                <label>Prioridade<select value={cardForm.priority} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, priority: event.target.value })}>{["low", "normal", "high", "urgent"].map((nivel) => <option key={nivel} value={nivel}>{PRIORITY_LABELS[nivel]}</option>)}</select></label>
                {!cardForm.processVersionId && <label>Coluna<select value={cardForm.listId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, listId: event.target.value })}><option value="">Automática pelas regras</option>{snapshot.lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label>}
                <section className="card-choice-section full" id="card-assignees" tabIndex={-1}><header><strong>Responsáveis</strong><span>Selecione uma ou mais pessoas</span></header><div className="choice-chips">{snapshot.members.filter((member) => member.role === "admin" || member.role === "member").map((member) => <label className={cardForm.assigneeIds.includes(member.userId) ? "selected" : ""} key={member.userId}><input type="checkbox" checked={cardForm.assigneeIds.includes(member.userId)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, assigneeIds: event.target.checked ? [...cardForm.assigneeIds, member.userId] : cardForm.assigneeIds.filter((id) => id !== member.userId) })} /><i>{initials(member.name)}</i>{member.name}</label>)}</div></section>
                <section className="card-choice-section full"><header><strong>Etiquetas</strong><span>Classifique sem alterar o processo</span></header><div className="choice-chips label-choices">{snapshot.labels.map((label) => <label className={cardForm.labelIds.includes(label.id) ? "selected" : ""} style={{ borderColor: cardForm.labelIds.includes(label.id) ? label.color : undefined }} key={label.id}><input type="checkbox" checked={cardForm.labelIds.includes(label.id)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, labelIds: event.target.checked ? [...cardForm.labelIds, label.id] : cardForm.labelIds.filter((id) => id !== label.id) })} /><i style={{ backgroundColor: label.color }} />{label.name}</label>)}</div></section>
                {snapshot.customFields.map((field) => <label key={field.id}>{field.name}{field.fieldType === "select" ? <select value={cardForm.customValues[field.fieldKey] ?? ""} disabled={!canEdit} required={field.required} onChange={(event) => setCardForm({ ...cardForm, customValues: { ...cardForm.customValues, [field.fieldKey]: event.target.value } })}><option value="">Selecione</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select> : <input type={field.fieldType === "date" ? "date" : field.fieldType === "number" ? "number" : "text"} value={cardForm.customValues[field.fieldKey] ?? ""} disabled={!canEdit} required={field.required} onChange={(event) => setCardForm({ ...cardForm, customValues: { ...cardForm.customValues, [field.fieldKey]: event.target.value } })} />}</label>)}
                <div className="card-form-actions full">{selectedCard && canEdit && !selectedCard.archived && <button type="button" className="danger-link" onClick={archiveCard}>Arquivar demanda</button>}{selectedCard && canEdit && !selectedCard.archived && !selectedCard.closedAt && <button type="button" className="danger-link" onClick={cancelCard}>Cancelar demanda</button>}{selectedCard && canEdit && !selectedCard.archived && <button type="button" className="secondary-button" onClick={() => void toggleSlaPause()}>{selectedCard.slaStatus === "paused" ? "Retomar SLA" : "Pausar SLA"}</button>}<span /><button type="button" className="secondary-button" onClick={() => setCardModalOpen(false)}>Fechar</button>{canEdit && !selectedCard?.archived && <button className="primary-button" disabled={busy}>{selectedCard ? "Salvar alterações" : "Criar demanda"}</button>}</div>
              </form>}

              {/* A etapa do processo, em texto, com o motivo de cada bloqueio
                  (§42, §43, §44). A demanda que não veio de processo diz isso
                  em uma frase, em vez de mostrar um painel vazio. */}
              {selectedCard && cardTab === "process" && <section className="card-tab-panel">
                <CardProcessPanel cardId={selectedCard.id} canAdvance={canEdit && !selectedCard.archived}
                  onAdvanced={() => { void requestSnapshot("/api/workspace").then(applySnapshot).catch(() => undefined); }} />
              </section>}

              {selectedCard && cardTab === "checklist" && (
                <section className="card-tab-panel checklist-panel">
                  <div><span>CHECKLIST</span><strong>{selectedCard.checklist.filter((item) => item.completed).length}/{selectedCard.checklist.length}</strong></div>
                  <div className="checklist-progress"><i style={{ width: `${selectedCard.checklist.length ? (selectedCard.checklist.filter((item) => item.completed).length / selectedCard.checklist.length) * 100 : 0}%` }} /></div>
                  {/* A marca "Pendente" por item, como a maquete pede.
                      A caixa desmarcada já diz que falta — mas ela diz isso só
                      pela ausência de um traço de 8px, e quem percorre uma lista
                      de dez itens procurando o que falta acaba contando caixas.
                      A palavra dá o que a caixa não dá: um alvo de leitura. */}
                  <ul>{selectedCard.checklist.map((item) => <li key={item.id} data-pendente={item.completed ? "false" : "true"}>
                    <label>
                      <input type="checkbox" checked={item.completed} disabled={!canEdit} onChange={(event) => void toggleChecklist(item.id, event.target.checked)} />
                      <span>{item.title}</span>
                    </label>
                    {!item.completed && <b className="checklist-pendente">Pendente</b>}
                  </li>)}</ul>
                  {canEdit && <form onSubmit={addChecklistItem}><input value={newChecklistItem} onChange={(event) => setNewChecklistItem(event.target.value)} placeholder="Nova etapa obrigatória" /><button disabled={!newChecklistItem.trim()}>＋</button></form>}
                  <p>Ao concluir todas as etapas, a demanda será movida automaticamente para Concluído.</p>
                </section>
              )}

              {selectedCard && cardTab === "attachments" && <section className="card-tab-panel attachments-panel">
                <header><div><span>DOCUMENTOS</span><h3>Anexos da demanda</h3><p>PDF, imagem, TXT, CSV, DOCX ou XLSX, com até 20 MB.</p></div>{canEdit && !selectedCard.archived && <label className="upload-button">＋ Enviar arquivo<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.docx,.xlsx" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAttachment(file); event.target.value = ""; }} /></label>}</header>
                <SolidesAttachmentSyncPanel card={selectedCard} busy={busy} canAuthorize={canEdit && !selectedCard.archived} onAuthorize={authorizeSolidesAttachments} />
                <div className="attachment-list">
                  {selectedCard.attachments.length === 0 && <div className="empty-view"><span>↥</span><strong>Nenhum anexo</strong><p>Envie documentos para manter todo o processo no mesmo lugar.</p></div>}
                  {selectedCard.attachments.map((attachment) => <article key={attachment.id}>
                    <i>{attachment.filename.split(".").pop()?.toUpperCase()}</i>
                    <div><strong>{attachment.filename}</strong><span>{formatFileSize(attachment.sizeBytes)} • {attachment.uploadedBy} • {formatMoment(attachment.createdAt)}</span></div>
                    <div className="attachment-actions">
                      {canPreviewAttachment(attachment) && <button type="button" className="attachment-preview-button" onClick={() => setAttachmentPreview(attachment)}>Visualizar</button>}
                      <a href={attachment.downloadUrl}>Baixar</a>
                      {canEdit && !selectedCard.archived && <button type="button" className="attachment-delete-button" title={`Excluir ${attachment.filename}`} onClick={() => void removeAttachment(attachment.id)} aria-label={`Excluir ${attachment.filename}`}>×</button>}
                    </div>
                  </article>)}
                </div>
              </section>}

              {selectedCard && cardTab === "activity" && <section className="card-tab-panel activity-panel"><div className="card-collaboration"><header><span>COMENTÁRIOS</span><strong>{selectedCard.comments.length}</strong></header><div className="card-comments">{selectedCard.comments.length === 0 && <p className="card-empty-note">Nenhum comentário ainda.</p>}{selectedCard.comments.map((comment) => <article key={comment.id}><i>{initials(comment.authorName)}</i><div><strong>{comment.authorName}<time>{formatMoment(comment.createdAt)}</time></strong><p>{comment.body}</p>{selectedCard.attachments.filter((attachment) => attachment.commentId === comment.id).map((attachment) => <a key={attachment.id} href={attachment.downloadUrl} className="comment-attachment"><Paperclip aria-hidden="true" />{attachment.filename}</a>)}{(comment.authorEmail === user.email || isAdmin) && !selectedCard.archived && <div className="comment-actions"><button onClick={() => void editComment(comment.id, comment.body)}>Editar</button><button onClick={() => void deleteComment(comment.id)}>Excluir</button></div>}</div></article>)}</div>{canComment && !selectedCard.archived && <form className="comment-form" onSubmit={addComment}><textarea value={newComment} onChange={(event) => setNewComment(event.target.value)} placeholder="Escreva uma atualização para a equipe. Use @nome para mencionar alguém." rows={3} maxLength={2000} /><label className="upload-button">Anexar arquivo<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.docx,.xlsx" disabled={busy} onChange={(event) => setCommentAttachment(event.target.files?.[0] ?? null)} /></label>{commentAttachment ? <small>Arquivo: {commentAttachment.name}</small> : null}<button disabled={!newComment.trim() || busy}>Publicar comentário</button></form>}<header className="activity-heading"><span>HISTÓRICO DA DEMANDA</span><strong>{plural(selectedCard.activities.length, "evento", "eventos")}</strong></header><ol className="activity-list">{selectedCard.activities.slice(0, 20).map((activity) => { const details = activityDetails(activity); return <li key={activity.id}><i /><div><strong>{activity.actorName}</strong> {activityLabel(activity)}{details.length > 0 && <ul className="activity-change-list">{details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}<time>{formatMoment(activity.createdAt)}</time></div></li>; })}</ol></div></section>}
            </div>

            {/* O rodapé de ações da maquete, fixo no pé da gaveta.
                Antes estas ações moravam dentro da faixa de resumo, no topo: ao
                rolar até o checklist ou os comentários — que é onde se decide
                avançar — elas ficavam duas telas acima. Fixas no pé, a decisão e
                o botão que a executa ficam no mesmo lugar.

                "Avançar etapa" leva à aba Processo em vez de avançar daqui: o
                destino depende de bloqueios que só o servidor avalia, e é lá que
                eles são carregados com o motivo de cada um. Um botão que
                avançasse direto teria de escolher o destino sozinho — e falhar
                calado quando houvesse bloqueio. */}
            {selectedCard && canEdit && !selectedCard.archived && <footer className="demand-drawer-actions">
              {flowByCard.has(selectedCard.id) && <button type="button" className="primary-button" onClick={() => setCardTab("process")}>
                <GitBranch aria-hidden="true" /> Avançar etapa
              </button>}
              <button type="button" className="secondary-button" onClick={() => focusCardField("card-assignees")}>Reatribuir</button>
              <button type="button" className="secondary-button" onClick={() => focusCardField("card-due-at")}>Prazo</button>
              <button type="button" className="secondary-button" onClick={() => { setCardTab("activity"); setNewComment("Solicitação de documentos: informe quais documentos ainda precisam ser enviados."); }}>Solicitar documento</button>
              <button type="button" className="secondary-button demand-drawer-complete" onClick={completeSelectedCard}>
                <CheckCircle2 aria-hidden="true" /> Concluir
              </button>
            </footer>}
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
            <header><div><span>{settingsSectionMeta[settingsSection].group}</span><h2 id="workspace-modal-title">{settingsSectionMeta[settingsSection].title}</h2><p>{settingsSectionMeta[settingsSection].description}</p></div><button onClick={() => setWorkspaceModalOpen(false)} aria-label="Fechar">×</button></header>
            <div className="workspace-settings-layout">
              <nav className="settings-nav" aria-label="Seções das configurações">
                {/* Filtra por seção e só então decide se o grupo aparece: um
                    rótulo de grupo sem nenhum botão embaixo é uma promessa de
                    seção que a pessoa não tem. Para quem não é administrador,
                    "Pessoas e acesso" e "Operação" somem inteiros. */}
                {settingsNavGroups
                  .map((group) => ({ ...group, sections: group.sections.filter((item) => isAdmin || !item.adminOnly) }))
                  .filter((group) => group.sections.length > 0)
                  .flatMap((group) => [
                  <span className="settings-nav-label" key={group.label}>{group.label}</span>,
                  /* O `aria-label` repete o título porque em telas estreitas o
                     CSS esconde o `<span>` e deixa só o ícone: sem ele o botão
                     fica sem nome acessível justamente onde ninguém consegue
                     adivinhar o desenho. */
                  ...group.sections.map((item) => (
                    <button key={item.section} aria-label={settingsSectionMeta[item.section].title} className={settingsSection === item.section ? "active" : ""} onClick={() => { setSettingsSection(item.section); if (item.section === "security") void loadAuthSessions(); }}>
                      <item.icon aria-hidden="true" /><span>{settingsSectionMeta[item.section].title}<small>{item.hint}</small></span>
                    </button>
                  )),
                ])}
              </nav>
              <div className="workspace-settings-content">
                {settingsSection === "general" && <>
                  {/* Os números antes dos formulários, como a maquete põe: quem
                      abre a administração precisa saber o tamanho do que vai
                      alterar antes de alterar. */}
                  <AdminIndicators snapshot={snapshot} />
                  <form className="workspace-name-form" onSubmit={saveWorkspace}><label>Nome do workspace<input autoFocus value={workspaceName} disabled={!isAdmin} onChange={(event) => setWorkspaceNameEdit(event.target.value)} maxLength={60} required /></label>{isAdmin && <button className="primary-button" disabled={busy}>Salvar nome</button>}</form>
                  <div className="workspace-account-summary"><span className="user-avatar">{userInitials}</span><div><strong>{user.displayName}</strong><small>{user.email}</small><em>{roleLabels[snapshot.workspace.role]}</em></div></div>

                  {/* Workspaces e quadros viraram tabela (maquete 3).
                      Eram duas listas de botões onde o estado só aparecia no
                      rótulo do próprio botão. A tabela separa o que é dado do
                      que é ação: papel, situação e tamanho ficam em coluna, e o
                      botão da última coluna faz uma coisa só. A situação do
                      grupo — arquivado, em análise — não cabia em botão algum e
                      simplesmente não era mostrada. */}
                  {snapshot.availableWorkspaces.length > 1 && <section className="workspace-switcher">
                    <header><div><strong>Seus workspaces</strong><span>Alterne entre as operações às quais você tem acesso.</span></div></header>
                    <div className="overview-table-scroll">
                      <table className="overview-table admin-table">
                        <thead><tr>
                          <th scope="col">Workspace</th>
                          <th scope="col">Seu papel</th>
                          <th scope="col">Situação</th>
                          <th scope="col"><span className="sr-only">Ação</span></th>
                        </tr></thead>
                        <tbody>
                          {snapshot.availableWorkspaces.map((item) => <tr key={item.id} aria-current={item.id === snapshot.workspace.id ? "true" : undefined}>
                            <th scope="row"><strong>{item.name}</strong>{item.isOwner && <small>Você é o titular</small>}</th>
                            <td>{roleLabels[item.role]}</td>
                            {/* `statusReason` explica por que o grupo saiu de
                                operação; sem ele "Arquivado" é um rótulo que
                                não diz o que fazer a respeito. */}
                            <td>{item.operational
                              ? <span className="admin-tag ok">Em operação</span>
                              : <span className="admin-tag idle" title={item.statusReason || undefined}>{item.statusReason || item.status}</span>}</td>
                            <td className="admin-acao">{item.id === snapshot.workspace.id
                              ? <span className="admin-tag atual">Atual</span>
                              : <button type="button" className="secondary-button" disabled={busy} onClick={() => void switchWorkspace(item.id)}>Abrir</button>}</td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div>
                  </section>}

                  <section className="board-manager">
                    <header><div><strong>Quadros da operação</strong><span>{plural(snapshot.boards.length, "quadro disponível", "quadros disponíveis")}</span></div></header>
                    <div className="overview-table-scroll">
                      <table className="overview-table admin-table">
                        <thead><tr>
                          <th scope="col">Quadro</th>
                          <th scope="col">Tipo</th>
                          <th scope="col">Etapas</th>
                          <th scope="col"><span className="sr-only">Ação</span></th>
                        </tr></thead>
                        <tbody>
                          {snapshot.boards.map((board) => <tr key={board.id} aria-current={board.id === snapshot.board.id ? "true" : undefined}>
                            <th scope="row"><strong>{board.name}</strong><small>{board.description || "Sem descrição"}</small></th>
                            <td>{board.boardType || "—"}</td>
                            <td>{board.stages.length}</td>
                            <td className="admin-acao">{board.id === snapshot.board.id
                              ? <span className="admin-tag atual">Atual</span>
                              : <button type="button" className="secondary-button" onClick={() => void switchBoard(board.id)}>Abrir</button>}</td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div>
                    {isAdmin && <form className="board-create-form" onSubmit={createBoard}><input value={newBoardName} onChange={(event) => setNewBoardName(event.target.value)} placeholder="Nome do novo quadro" required /><input value={newBoardDescription} onChange={(event) => setNewBoardDescription(event.target.value)} placeholder="Descrição opcional" /><button className="primary-button" disabled={busy}>Criar quadro</button></form>}
                  </section>
                </>}
                {settingsSection === "columns" && <ListsSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onMutate={mutate} onConfirm={requestConfirmation} />}
                {settingsSection === "companies" && isAdmin && <CompanySettings companies={snapshot.companies} members={snapshot.members} busy={busy} onCreateCompany={createCompany} onUpdateCompany={updateCompany} onDeleteCompany={deleteCompany} onOpenAccess={() => setSettingsSection("team")} />}
                {settingsSection === "team" && <>
                  <section className="access-admin-hero">
                    <span><Users aria-hidden="true" /></span>
                    <div>
                      <strong>Workspace → Departamento → Módulos</strong>
                      <p>O departamento principal define os módulos que a pessoa recebe por padrão. Em “Usuários e acessos” você abre exceção para alguém, inclusive em módulo que a área dela não tem.</p>
                    </div>
                    <b>{isAdmin ? "Você é administrador" : "Acesso limitado"}</b>
                  </section>
                  <section className="workspace-team">
                    <header>
                      <div><strong>Usuários liberados</strong><span>{plural(snapshot.members.length, "pessoa com acesso ao grupo", "pessoas com acesso ao grupo")}</span></div>
                      <p>O papel define as ações; o departamento dá os módulos padrão; a exceção individual vence o departamento; a empresa limita os CNPJs.</p>
                    </header>
                    <div className="workspace-member-list">{snapshot.members.map((member) => (
                      <article key={member.userId}>
                        <i>{initials(member.name)}</i>
                        <div>
                          <strong>{member.name}{member.isOwner && <em>Administrador principal</em>}</strong>
                          <small>{member.email}</small>
                          <span className={`member-activation-status ${member.isActivated ? "active" : "pending"}`}>{member.isActivated ? "Acesso ativo" : "Ativação pendente"}</span>
                          <span className={`member-department-status ${member.departmentId ? "assigned" : "missing"}`}>
                            <Building2 aria-hidden="true" /> {member.departmentName || (member.isOwner ? "Proprietário do Workspace" : "Sem departamento")}
                          </span>
                        </div>
                        {isAdmin && !member.isOwner ? (
                          <select aria-label={`Papel de ${member.name}`} value={member.role} disabled={busy} onChange={(event) => void updateMemberRole(member.userId, event.target.value as WorkspaceRole)}>
                            <option value="admin">Administrador</option><option value="member">Membro</option><option value="observer">Observador</option><option value="guest">Convidado</option>
                          </select>
                        ) : <b>{roleLabels[member.role]}</b>}
                        {isAdmin && !member.isOwner && (
                          <select className="member-department-select" aria-label={`Departamento de ${member.name}`} value={member.departmentId ?? ""} disabled={busy}
                            onChange={(event) => updateMemberDepartment(member.userId, member.name, event.target.value)}>
                            {!member.departmentId && <option value="">Selecione o departamento</option>}
                            {activeDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}
                          </select>
                        )}
                        {isAdmin && !member.isOwner && <MemberCompanyAccess key={`${member.userId}:${member.companyIds.join(",")}`} member={member} companies={snapshot.companies} busy={busy} onSave={updateMemberCompanies} />}
                        {isAdmin && !member.isOwner && <button className="member-recovery-button" disabled={busy} onClick={() => void generateRecoveryLink(member.userId, member.name)}>{member.isActivated ? "Gerar novo link" : "Gerar link de ativação"}</button>}
                        {isAdmin && !member.isOwner && <button aria-label={`Remover ${member.name}`} disabled={busy} onClick={() => void removeMember(member.userId, member.name)}>×</button>}
                        {isAdmin && !member.isOwner && <details className="member-modules-details"><summary>Módulos deste usuário</summary><MemberModules memberId={member.userId} key={`${member.userId}:${member.departmentId ?? "none"}`} memberName={member.name} canManage={isAdmin} /></details>}
                      </article>
                    ))}</div>
                  </section>

                  {/* A matriz fica logo abaixo da lista, e antes do formulário
                      que cria usuário: os dois lugares em que se escolhe um
                      papel são o seletor de cada linha acima e o `<select>` do
                      formulário abaixo. Ela precisa estar entre os dois, e não
                      numa seção que ninguém abre no momento de decidir. */}
                  <PermissionMatrix />

                  {isAdmin && <form className="workspace-invite-form" onSubmit={addMember}>
                    <header><div><strong>Criar e liberar usuário</strong><span>Defina a lotação e os módulos antes de gerar o acesso.</span></div><b>1. Identidade · 2. Departamento · 3. Módulos · 4. Ativação</b></header>
                    <div>
                      <label>Nome<input value={memberName} onChange={(event) => setMemberName(event.target.value)} placeholder="Nome da pessoa" maxLength={120} /></label>
                      <label>E-mail<input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="nome@empresa.com" required /></label>
                      <label>Papel<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as WorkspaceRole)}><option value="member">Membro</option><option value="observer">Observador</option><option value="guest">Convidado</option><option value="admin">Administrador</option></select></label>
                      <label>Departamento principal<select value={memberDepartmentId} required onChange={(event) => selectMemberDepartment(event.target.value)}>
                        <option value="">Selecione…</option>{activeDepartments.map((department) => <option value={department.id} key={department.id}>{department.name} · {department.code}</option>)}
                      </select></label>
                      <fieldset className="invite-module-scope" disabled={busy || !memberDepartmentId}>
                        <legend>Módulos liberados neste departamento</legend>
                        {!memberDepartmentId && <p>Selecione o departamento para ver os módulos disponíveis.</p>}
                        {memberDepartmentId && selectedDepartmentModules.length === 0 && <p>Este departamento ainda não possui módulos configurados.</p>}
                        <div>{selectedDepartmentModules.map((module) => {
                          const hardBlocked = ["module_inactive", "workspace_inactive", "subscription_inactive", "not_in_plan", "revoked_by_platform"].includes(module.reason);
                          return <label key={module.key} data-disabled={hardBlocked || undefined}>
                            <input type="checkbox" checked={memberModuleKeys.includes(module.key)} disabled={hardBlocked}
                              onChange={(event) => setMemberModuleKeys((current) => event.target.checked ? [...current, module.key] : current.filter((key) => key !== module.key))} />
                            <span><strong>{module.name}</strong><small>{hardBlocked ? module.message : module.description}</small></span>
                          </label>;
                        })}</div>
                      </fieldset>
                      <fieldset className="invite-company-scope" disabled={busy || memberRole === "admin"}><legend>{memberRole === "admin" ? "Administrador acessa todas as empresas" : "Empresas autorizadas"}</legend><div>{snapshot.companies.map((company) => <label key={company.id}><input type="checkbox" checked={memberCompanyIds.includes(company.id)} onChange={(event) => setMemberCompanyIds((current) => event.target.checked ? [...current, company.id] : current.filter((id) => id !== company.id))} />{company.isPrincipal ? "★ " : "↳ "}{company.tradeName || company.legalName}</label>)}</div></fieldset>
                      <button className="primary-button" disabled={busy || !memberEmail.trim() || !memberDepartmentId || memberModuleKeys.length === 0}>Criar usuário e gerar link</button>
                    </div>
                  </form>}
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
              {/* A última sincronização passa a ser dita em qualquer estado, e
                  não só no conectado. Era justamente no conector com erro que
                  ela faltava — e é ali que ela responde a pergunta que importa:
                  há quanto tempo este sistema parou de trazer dado. Ausência
                  não vira data inventada: `lastSyncLabel(null)` diz "nunca
                  sincronizou". */}
              <small>{connectionStatusLabel(item.status)} · {lastSyncLabel(item.lastSyncAt)}</small>
            </span>
          </li>;
        })}
      </ul>
    </div>
  </section>;
}

/**
 * Os sete tipos do catálogo padrão do DP.
 *
 * A demanda que nasce de um processo publicado NÃO usa esta lista: ela recebe o
 * código do próprio processo (`EPI_ENTREGA`, por exemplo). Por isso o seletor
 * precisa admitir um valor de fora dela — e por isso a lista mora aqui, e não
 * escrita dentro do JSX, onde não dava para perguntar se um valor pertence a
 * ela.
 */
const processTypeOptions = ["CONCILIAÇÃO CADASTRAL", "RESCISÃO", "FÉRIAS", "BENEFÍCIOS", "FOLHA", "CADASTRO", "OUTROS"];

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

function OverviewView({ onNavigate, cards, companies, lists, activities, stats, onOpen, onOpenBoard, onNew, canEdit, companyId, scopeLabel, cycles, integrations, processes, processBadges, onOpenProcess, shortcuts, flows, obligations, periodLabel, onOpenCard, onFocus }: {
  onNavigate: (target: ActionTarget) => void;
  /** Demandas em execução, já sob os filtros do topo (§15). */
  flows: WorkspaceSnapshot["processFlows"];
  /** Obrigações em aberto, já sob os filtros do topo (§16). */
  obligations: WorkspaceSnapshot["upcomingObligations"];
  /** Rótulo do período escolhido, para os estados vazios dizerem o porquê. */
  periodLabel: string;
  onOpenCard: (cardId: string) => void;
  /**
   * Navega para o módulo já com o recorte de SLA aplicado (§14).
   *
   * Tipo próprio em vez de `ActionTarget`: aquele é a lista de destinos que
   * *resolvem uma pendência* da central de ação, e alargá-lo para caber um
   * indicador apagaria a razão de ele existir.
   */
  onFocus: (target: OverviewFocusTarget, sla: "all" | "overdue") => void;
  /** Processos que esta pessoa alcança, no mesmo recorte do menu (§30). */
  processes: ReadonlyArray<{ id: string; label: string; description: string; views: readonly string[] }>;
  /** Contagens já apuradas pelo painel — o cartão do processo não consulta nada. */
  processBadges: Partial<Record<string, number>>;
  onOpenProcess: (view: string) => void;
  /** Atalhos já montados pela casca: rótulo e ícone vêm do catálogo de telas,
   *  que é dela. `fixed` separa o que a pessoa fixou do que ela só visitou. */
  shortcuts: ReadonlyArray<{ id: string; label: string; icon: LucideIcon; fixed: boolean }>;
  cards: Card[];
  companies: WorkspaceSnapshot["companies"];
  lists: WorkspaceSnapshot["lists"];
  activities: ActivityEvent[];
  cycles: WorkspaceSnapshot["payrollCycles"];
  integrations: WorkspaceSnapshot["integrations"];
  stats: { active: number; attention: number; waiting: number; onTime: number | null; completed: number; documentsPending: number; activeCompanies: number };
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
  const visibleColumns = lists.slice(0, 3);
  /* Demanda por id, para a linha do histórico dizer a que ela se refere.
     `activities` e `cards` já vêm do mesmo snapshot e do mesmo recorte, então
     não há consulta nova; o evento cuja demanda o recorte não alcança fica sem
     a coluna, e não com o título de outra. */
  const cardById = new Map(cards.map((card) => [card.id, card]));

  /* A aba escolhida do bloco de status. Vazia = ainda não escolheram, e aí o
     padrão é a primeira coluna com demanda: abrir numa aba vazia faria a tela
     parecer sem dados quando há. */
  const [statusTab, setStatusTab] = useState("");
  const statusList = lists.find((list) => list.id === statusTab)
    ?? lists.find((list) => list.cards.length > 0)
    ?? lists[0]
    ?? null;
  const integrationsFailing = integrations.filter((item) => item.status === "error").length;

  /* Os números dos três contextos (§7.2).
     Todos derivam das mesmas demandas, fluxos e integrações que o snapshot já
     traz — nenhuma consulta nova, nenhum valor fixo. Onde não há dado, o texto
     diz que não há, em vez de mostrar zero como se fosse medição. */
  /* "Vence hoje" é `slaStatus === "warning"`, e não uma comparação de data
     feita aqui. A primeira versão deste bloco calculava pelo calendário e
     mostrava "Vencendo hoje: 0" logo acima de uma lista com três demandas
     etiquetadas "Vence hoje" — dois cálculos para a mesma pergunta, discordando
     na mesma tela. Quem decide o que é hoje é o SLA, que conhece expediente e
     feriado; o calendário do navegador não. `compactSlaLabel` já traduz esse
     status com estas mesmas palavras no cartão. */
  const venceHoje = cards.filter((card) => card.slaStatus === "warning").length;
  const atrasadas = cards.filter((card) => card.slaStatus === "overdue").length;
  const hojeExigeAcao = venceHoje + atrasadas > 0;
  /* Processos DISTINTOS em execução, não fluxos: doze admissões correndo são um
     processo com doze demandas, e contá-las como doze processos diria que a
     operação roda doze fluxos diferentes. */
  const processosEmExecucao = new Set(flows.map((flow) => flow.definitionId)).size;
  const integracoesConectadas = integrations.filter((item) => item.status === "connected").length;
  const obrigacoesVencidas = obligations.filter((item) => item.daysRemaining < 0).length;
  const ultimaSincronizacao = (() => {
    const marcas = integrations.map((item) => item.lastSyncAt).filter((value): value is string => Boolean(value));
    if (marcas.length === 0) return null;
    const recente = marcas.reduce((maior, atual) => (atual > maior ? atual : maior));
    return new Date(recente).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  })();

  /* Os cinco indicadores da maquete.
     Cada um traz um número e a frase que o qualifica. A maquete desenha uma
     variação percentual ao lado do número — "+12% vs. mês anterior" — e ela
     não entra: o snapshot não carrega nenhuma série histórica, então o
     percentual teria de ser inventado, que é o que a §13 proíbe em primeiro
     lugar. No lugar dele vai um segundo fato medido: o número que explica o
     primeiro. É a mesma linha de texto e diz algo verdadeiro.

     Nada foi perdido dos três contextos que estavam aqui: os sete valores que
     eles mostravam continuam na tela, seis deles como a frase de apoio de um
     indicador. */
  const kpis: Array<{
    key: string;
    icon: LucideIcon;
    label: string;
    value: string;
    support: string;
    target: OverviewFocusTarget;
    sla: "all" | "overdue";
    /** Pinta o cartão de alerta — sempre derivado de um número, nunca fixo. */
    alert: boolean;
    /** Só o SLA tem barra: é o único indicador que é uma proporção. */
    bar?: number | null;
  }> = [
    {
      key: "demands-open", icon: ClipboardList, label: "Demandas em aberto",
      value: String(stats.active),
      support: `${stats.completed} concluída(s) no período · ${stats.waiting} aguardando terceiros`,
      target: "board", sla: "all", alert: false,
    },
    {
      key: "flows-running", icon: GitBranch, label: "Fluxos em andamento",
      value: String(flows.length),
      /* Processos DISTINTOS, não fluxos: doze admissões correndo são um
         processo com doze demandas, e contá-las como doze processos diria que
         a operação roda doze fluxos diferentes (§4). */
      support: `${plural(processosEmExecucao, "processo distinto", "processos distintos")} · ${stats.documentsPending} tarefa(s) pendente(s)`,
      target: "processManagement", sla: "all", alert: false,
    },
    {
      key: "obligations-due", icon: CalendarClock, label: "Obrigações próximas",
      value: String(obligations.length),
      support: obrigacoesVencidas
        ? `${obrigacoesVencidas} já vencida(s)`
        : "Nenhuma vencida até agora",
      target: "processes", sla: "all", alert: obrigacoesVencidas > 0,
    },
    {
      key: "integrations-failing", icon: Cable, label: "Integrações com erro",
      value: String(integrationsFailing),
      /* Sem sincronização registrada o certo é dizer isso, e não uma data de
         mentira nem um traço que parece dado que faltou carregar. */
      support: `${integracoesConectadas} conectada(s) · última sincronização ${ultimaSincronizacao ?? "Nunca"}`,
      target: "integrations", sla: "all", alert: integrationsFailing > 0,
    },
    {
      key: "sla-on-time", icon: Timer, label: "SLA no prazo",
      /* Sem demanda no recorte não há percentual: o número mais tranquilizador
         da tela não pode aparecer justamente quando não há evidência nenhuma
         para tranquilizar ninguém. */
      value: stats.onTime === null ? "—" : `${stats.onTime}%`,
      /* O percentual mede as demandas EM ABERTO que não estouraram o prazo, e
         não as concluídas — populações diferentes. A frase de apoio abre o
         número em atraso e vencimento de hoje, que é o que faz alguém agir. */
      support: stats.onTime === null
        ? "Sem demandas em aberto neste recorte"
        : `das demandas em aberto · ${atrasadas} atrasada(s) · ${venceHoje} vencendo hoje`,
      target: "board", sla: "overdue", alert: hojeExigeAcao,
      bar: stats.onTime,
    },
  ];

  return <div className="overview-layout">

    {/* A ordem desta tela é a §93: “a Visão Geral deve parecer uma central de
       operação; evitar dashboard genérico de cards”.

       Medido antes de mexer, com 15 demandas reais no banco: a página tinha
       2738px e o indicador "Demandas em aberto" ficava em y=1610 — quase duas
       telas abaixo do topo. Para saber quantas demandas estavam abertas era
       preciso rolar duas vezes. Os 1610px anteriores eram a competência, três
       blocos que quase sempre estão vazios e 480px de cartões de módulo que
       repetem, um a um, o menu que já está na barra lateral.

       A correção é de ordem, não de estética. Uma sala de controle abre com o
       estado da operação; o menu não é o estado da operação. A sequência agora
       responde, de cima para baixo: quanto há, o que está travado, em que mês
       estamos, o que está correndo e o que vence, como andam os sistemas, e só
       então consulta e navegação. */}

    {/* Faixa de indicadores (§14).
        Cada número que tem onde ser resolvido virou botão: ler "3 integrações
        com erro" e não ter caminho para elas é o indicador cobrando uma ação
        que ele mesmo não deixa tomar. Os que não têm destino próprio seguem
        como texto — link que leva ao lugar errado é pior que nenhum.

        "SLA no prazo" não entra aqui: ele tem a faixa logo abaixo, inteira,
        com barra e contagem. Repeti-lo como sexto cartão seria o mesmo número
        duas vezes na mesma dobra. */}
    {/* Cinco indicadores, como a maquete pede.
        O recorte vigente fica escrito ao lado do título: um número sem o
        conjunto que ele mede é um número sobre nada, e a Visão geral tem dois
        filtros no topo que mudam os cinco de uma vez.

        `data-metric` é o ponto de ancoragem do ensaio de navegador. Ele mirava
        `.overview-metrics article strong` e `.first()`; quando os indicadores
        viraram botão, `.first()` passou a devolver "Documentos pendentes" — que
        é 0 tanto no grupo quanto numa filial vazia, então a conferência do
        recorte por empresa comparava 0 com 0 e reprovava. Ancorar no que o
        indicador *é* faz a mudança de elemento, de grupo ou de ordem não
        quebrar o ensaio — foi o que permitiu esta reorganização.

        Cada indicador é botão porque cada um tem onde ser resolvido: ler "3
        integrações com erro" e não ter caminho para elas é o indicador cobrando
        uma ação que ele mesmo não deixa tomar. */}
    <section className="overview-kpis" aria-label={`Indicadores da operação — ${scopeLabel}`}>
      {kpis.map((kpi) => {
        const KpiIcon = kpi.icon;
        return <button type="button" key={kpi.key} data-metric={kpi.key}
          className={`overview-kpi${kpi.alert ? " requires-attention" : ""}`}
          onClick={() => onFocus(kpi.target, kpi.sla)}>
          <span className="overview-kpi-top">
            <span className="overview-kpi-label">{kpi.label}</span>
            <i aria-hidden="true"><KpiIcon /></i>
          </span>
          <strong className="overview-kpi-value">{kpi.value}</strong>
          {/* Barra sem número para representar não deve ser desenhada. */}
          {typeof kpi.bar === "number" && <span className="overview-kpi-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, kpi.bar))}%` }} />
          </span>}
          <small className="overview-kpi-support">{kpi.support}</small>
        </button>;
      })}
    </section>


    {/* Fluxos em andamento (§15) e próximos vencimentos (§16).
        As duas perguntas que o quadro não responde: ele mostra demandas soltas
        por coluna, não o processo que as gerou nem a data legal que não espera
        ninguém.

        Os dois viraram tabela, como a maquete pede. Cartão e tabela servem a
        leituras diferentes: o cartão é bom para ler um, a tabela é boa para
        comparar seis. Quem abre a Visão geral está escolhendo o que abrir, e
        para isso compara — a coluna alinhada deixa "etapa" embaixo de "etapa" e
        "responsável" embaixo de "responsável", que é o que o cartão não fazia.

        Empilhados em largura inteira, e não lado a lado como eram enquanto
        eram cartões: cinco colunas num painel de meia largura cortavam a
        última — a tela mostrou "SITU…" no lugar de "SITUAÇÃO", que é a coluna
        que diz se a demanda está atrasada. O invólucro rolava, mas rolagem
        lateral escondida dentro de um painel é informação que ninguém acha. */}
    <section className="overview-panel flows-panel" aria-labelledby="overview-flows-title">
      <header>
        <div><span>EM EXECUÇÃO</span><h2 id="overview-flows-title">Fluxos em andamento</h2></div>
        <button type="button" onClick={() => onFocus("processManagement", "all")}>Ver processos <ArrowRight aria-hidden="true" /></button>
      </header>
      <div className="overview-flow-list">
        {flows.length === 0 && <div className="overview-empty">
          <GitBranch aria-hidden="true" />
          <strong>Nenhum processo em execução.</strong>
          {/* O vazio diz qual dos dois casos é: não há demanda instanciada, ou
              o recorte escolhido é que não alcança nenhuma. */}
          <p>{periodLabel === "Todo o período"
            ? "Demandas criadas a partir de um processo publicado aparecem aqui com a etapa atual."
            : `Nenhuma demanda de processo com prazo em ${periodLabel.toLowerCase()}.`}</p>
        </div>}
        {flows.length > 0 && <div className="overview-table-scroll">
          <table className="overview-table overview-flow-table">
            <thead><tr>
              <th scope="col">Processo</th>
              <th scope="col">Etapa atual</th>
              <th scope="col">Progresso</th>
              <th scope="col">Responsável</th>
              <th scope="col">Situação</th>
            </tr></thead>
            <tbody>
              {flows.slice(0, 6).map((flow) => <tr key={flow.cardId} className={`sla-${flow.slaStatus}`}>
                <td>
                  {/* A linha inteira não vira clicável: `<tr onClick>` não
                      recebe foco nem é anunciado como destino. O caminho para
                      a demanda é este botão, que é um elemento de verdade. */}
                  <button type="button" className="overview-table-link" onClick={() => onOpenCard(flow.cardId)}>
                    <strong>{flow.definitionName}</strong>
                    <small>{flow.cardTitle}</small>
                  </button>
                  {flow.versionNumber && <em className="overview-version-tag"
                    title={`Versão instanciada nesta demanda: ${flow.versionNumber}`}>v{flow.versionNumber}</em>}
                </td>
                <td>{flow.stepLabel || "Não iniciada"}</td>
                {/* A barra e o "7 de 18" dizem a mesma coisa de duas formas
                    porque percentual sozinho não diz o tamanho do processo:
                    50% de duas tarefas e 50% de quarenta pedem decisões
                    diferentes. */}
                <td className="overview-progress-cell">
                  {/* Barra sem número para representar não é desenhada: com
                      `tasksTotal` em zero ela ficava vazia na tela, e barra
                      vazia se lê como "0% concluído" — que é afirmar um
                      progresso onde não há nem denominador. */}
                  {flow.tasksTotal > 0 && <span className="overview-flow-progress" role="img"
                    aria-label={`${flow.progress}% concluído, ${flow.tasksDone} de ${flow.tasksTotal} tarefas`}>
                    <i style={{ width: `${Math.max(0, Math.min(100, flow.progress))}%` }} />
                  </span>}
                  <small>{flow.tasksTotal ? `${flow.tasksDone} de ${flow.tasksTotal} tarefas · ${flow.progress}%` : "Sem tarefas instanciadas"}</small>
                </td>
                <td>{flow.responsibleName || "Sem responsável"}</td>
                {/* Cor sozinha não carrega o dado: o estado do prazo continua
                    escrito, com as mesmas palavras do cartão do quadro. */}
                <td><span className={`overview-sla-tag sla-${flow.slaStatus}`}>{compactSlaLabel(flow.slaStatus, flow.dueAt)}</span></td>
              </tr>)}
            </tbody>
          </table>
        </div>}
      </div>
    </section>

    <section className="overview-panel obligations-panel" aria-labelledby="overview-obligations-title">
      <header>
        <div><span>PRAZOS LEGAIS</span><h2 id="overview-obligations-title">Próximos vencimentos</h2></div>
        <button type="button" onClick={() => onFocus("processes", "all")}>Ver calendário <ArrowRight aria-hidden="true" /></button>
      </header>
      <div className="overview-obligation-list">
        {obligations.length === 0 && <div className="overview-empty">
          <CheckCircle2 aria-hidden="true" />
          <strong>Nenhuma obrigação em aberto.</strong>
          <p>{periodLabel === "Todo o período"
            ? "eSocial, FGTS Digital, DCTFWeb e demais obrigações aparecem aqui conforme o vencimento."
            : `Nenhum vencimento em ${periodLabel.toLowerCase()}.`}</p>
        </div>}
        {obligations.length > 0 && <div className="overview-table-scroll">
          <table className="overview-table overview-obligation-table">
            <thead><tr>
              <th scope="col">Obrigação</th>
              <th scope="col">Empresa</th>
              <th scope="col">Competência</th>
              <th scope="col">Vencimento</th>
              <th scope="col">Situação</th>
            </tr></thead>
            <tbody>
              {groupObligations(obligations).slice(0, 6).map((item) => <tr key={item.id}
                className={`overview-obligation ${item.daysRemaining < 0 ? "overdue" : item.daysRemaining <= 3 ? "warning" : "safe"}`}>
                <td><strong>{item.title}</strong></td>
                {/* A consulta devolve uma linha por empresa; doze filiais com o
                    mesmo eSocial ocupariam as seis vagas com o mesmo prazo. */}
                <td>{item.companies > 1 ? `${item.companies} empresas` : item.company || "Sem empresa"}</td>
                <td>{item.competence || "—"}</td>
                <td>{formatDate(item.dueDate)}</td>
                {/* "Vence em -2 dias" é o tipo de frase que só um sistema
                    escreve. O atraso é dito como atraso. */}
                <td><span className="overview-obligation-due">{item.daysRemaining < 0
                  ? `${Math.abs(item.daysRemaining)} dia(s) em atraso`
                  : item.daysRemaining === 0 ? "Vence hoje" : `Em ${item.daysRemaining} dia(s)`}</span></td>
              </tr>)}
            </tbody>
          </table>
        </div>}
      </div>
    </section>

    <div className="overview-grid">
      <section className="overview-panel attention-panel"><header><div><span>ATENÇÃO HOJE</span><h2>O que exige ação</h2></div><button onClick={onOpenBoard}>Ver quadro <ArrowRight aria-hidden="true" /></button></header><div className="overview-attention-list">
        {attention.length === 0 && <div className="overview-empty"><CheckCircle2 aria-hidden="true" /><strong>Nenhuma demanda crítica agora.</strong><p>Os prazos em aberto estão dentro da política definida.</p></div>}
        {attention.slice(0, 4).map((card) => <button className={`overview-attention-card ${card.slaStatus}`} key={card.id} onClick={() => onOpen(card)}><i /><span><strong>{card.title}</strong><small>{card.company || "Sem empresa"} • {card.assigneeName || "Sem responsável"}</small></span><em>{compactSlaLabel(card.slaStatus, card.dueAt)}</em></button>)}
      </div></section>

      {/* Demandas por status: uma aba por coluna, tabela embaixo.
          O bloco era um gráfico de barras — respondia "quantas em cada coluna" e
          parava aí. A pergunta seguinte, "quais são", exigia sair da tela. As
          abas guardam a primeira resposta (a contagem está no próprio rótulo) e
          destravam a segunda sem trocar de página.

          As colunas são as do quadro deste grupo, não uma lista escrita aqui:
          quem renomeia "Em execução" para "Na fila" lê "Na fila" nesta aba. */}
      <section className="overview-panel status-panel" aria-labelledby="overview-status-title">
        <header>
          <div><span>VOLUME POR STATUS</span><h2 id="overview-status-title">Demandas na operação</h2></div>
          <button onClick={onOpenBoard}>Abrir demandas <ArrowRight aria-hidden="true" /></button>
        </header>
        {lists.length === 0
          ? <div className="overview-empty">
              <ClipboardList aria-hidden="true" />
              <strong>Nenhuma coluna configurada.</strong>
              <p>As colunas do quadro definem os status que aparecem aqui.</p>
            </div>
          : <>
              <div className="overview-status-tabs" role="tablist" aria-label="Status das demandas">
                {lists.map((list) => <button type="button" key={list.id} role="tab"
                  id={`overview-status-tab-${list.id}`}
                  aria-selected={statusList?.id === list.id}
                  aria-controls={statusList?.id === list.id ? `overview-status-panel-${list.id}` : undefined}
                  onClick={() => setStatusTab(list.id)}>
                  {list.name}<b>{list.cards.length}</b>
                </button>)}
              </div>
              {statusList && <div className="overview-status-body" role="tabpanel"
                id={`overview-status-panel-${statusList.id}`}
                aria-labelledby={`overview-status-tab-${statusList.id}`}>
                {statusList.cards.length === 0
                  ? <p className="overview-status-vazio">Nenhuma demanda em {statusList.name} neste recorte.</p>
                  : <div className="overview-table-scroll">
                      <table className="overview-table overview-status-table">
                        <thead><tr>
                          <th scope="col">Demanda</th>
                          <th scope="col">Empresa</th>
                          <th scope="col">Responsável</th>
                          <th scope="col">Prazo</th>
                        </tr></thead>
                        <tbody>
                          {statusList.cards.slice(0, 6).map((card) => <tr key={card.id} className={`sla-${card.slaStatus}`}>
                            <td>
                              <button type="button" className="overview-table-link" onClick={() => onOpen(card)}>
                                <strong>{card.title}</strong>
                                <small>{card.processType}</small>
                              </button>
                            </td>
                            <td>{card.company || "Sem empresa"}</td>
                            <td>{card.assigneeName || "Sem responsável"}</td>
                            <td><span className={`overview-sla-tag sla-${card.slaStatus}`}>{compactSlaLabel(card.slaStatus, card.dueAt)}</span></td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div>}
                {/* A tabela mostra seis. Dizer o total impede que a aba pareça a
                    lista inteira — uma janela sem aviso vira "o sistema perdeu
                    minhas demandas". */}
                {statusList.cards.length > 6 && <p className="overview-status-vazio">
                  Mostrando 6 de {statusList.cards.length} em {statusList.name}.
                </p>}
              </div>}
            </>}
      </section>
    </div>


    <CompetenceFlow cycles={cycles} scopeLabel={scopeLabel} active={stats.active}
      onNew={canEdit ? onNew : undefined} onNavigate={onNavigate} />

    {/* Lado a lado, como o Modelo 2 põe: o que precisa de você e o que está
        ligado. Antes a central de ação abria a tela sozinha, em largura
        inteira, para dizer quase sempre "nenhuma pendência" — o estado mais
        comum ocupando o lugar mais nobre. */}
    <div className="overview-pair">
      <ActionCenter onNavigate={onNavigate} companyId={companyId} />
      <ConnectionMap integrations={integrations} onNavigate={onNavigate} />
    </div>

    {/* Consulta, não operação: a prévia repete o quadro e o histórico conta o
        que já passou. Por isso fecham a tela, depois do que exige ação. */}
    <section className="overview-panel board-preview"><header><div><span>PRÉVIA DO QUADRO</span><h2>Próximas demandas</h2></div><button onClick={onOpenBoard}>Ver todas <ArrowRight aria-hidden="true" /></button></header><div className="board-preview-columns">
      {visibleColumns.map((list) => <section key={list.id}><header><strong>{list.name}</strong><b>{list.cards.length}</b></header>{list.cards.slice(0, 2).map((card) => { const company = card.companyId ? companyById.get(card.companyId) : undefined; return <button className={`mini-demand-card sla-${card.slaStatus}`} onClick={() => onOpen(card)} key={card.id}><span>{card.processType}</span><strong>{card.title}</strong><small>{card.company || "Sem empresa"}{company?.taxId ? ` • ${company.taxId}` : ""}</small><em>{compactSlaLabel(card.slaStatus, card.dueAt)}</em></button>; })}{list.cards.length === 0 && <p className="mini-column-empty">Nenhuma demanda</p>}</section>)}
    </div></section>

    {/* Últimas movimentações (§19), em largura inteira.
        O botão entrou junto com a tela de histórico. Ele tinha ficado de fora
        de propósito enquanto não havia destino: link que leva ao lugar errado é
        pior que nenhum, e o teste que guardava isso cobrava as duas metades —
        que o botão não existisse sem a tela, e que entrasse quando ela entrasse.

        A lista de avatares virou tabela, como a maquete pede. O que ela ganha é
        a coluna "Relacionado a": antes o evento dizia "moveu a demanda de
        coluna" sem dizer QUAL demanda, e descobrir exigia abrir o histórico
        inteiro. Cinco colunas não cabem na coluna estreita da grade, então o
        bloco passa a ocupar a largura toda. */}
    <section className="overview-panel activity-panel"><header><div><span>ATIVIDADES RECENTES</span><h2>Histórico da operação</h2></div><button type="button" onClick={() => onFocus("history", "all")}>Ver histórico completo <ArrowRight aria-hidden="true" /></button></header><div className="recent-activity-list">
      {activities.length === 0 && <div className="overview-empty"><Clock3 aria-hidden="true" /><strong>O histórico aparecerá aqui.</strong><p>As movimentações de demandas e documentos serão registradas automaticamente.</p></div>}
      {activities.length > 0 && <div className="overview-table-scroll">
        <table className="overview-table overview-activity-table">
          <thead><tr>
            <th scope="col">Data e hora</th>
            <th scope="col">Evento</th>
            <th scope="col">Relacionado a</th>
            <th scope="col">Responsável</th>
            <th scope="col">Empresa</th>
          </tr></thead>
          <tbody>
            {activities.slice(0, 6).map((activity) => {
              const demanda = activity.cardId ? cardById.get(activity.cardId) : undefined;
              const detalhe = activityDetails(activity)[0];
              return <tr key={activity.id}>
                <td className="overview-quando">{formatMoment(activity.createdAt)}</td>
                <td>
                  <strong>{activityLabel(activity)}</strong>
                  {detalhe && <small>{detalhe}</small>}
                </td>
                {/* Sem a demanda carregada no recorte, a célula diz que não
                    sabe — o título de outra demanda seria pior que o traço. */}
                <td>{demanda
                  ? <button type="button" className="overview-table-link" onClick={() => onOpen(demanda)}>
                      <strong>{demanda.title}</strong>
                    </button>
                  : <span className="overview-ausente">—</span>}</td>
                <td>{activity.actorName || "Equipe DP"}</td>
                <td>{demanda?.company || <span className="overview-ausente">—</span>}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
    </div></section>

    {/* Retomar de onde parou (§67).
        Fica acima de "Meus processos" de propósito: quem abre a home no meio
        do expediente quase sempre está voltando a algo, não escolhendo um
        processo do zero. E não aparece no primeiro dia de uso, quando ainda
        não há nada a retomar — uma faixa vazia prometendo atalhos é pior que
        faixa nenhuma. */}
    {shortcuts.length > 0 && (
      <section className="workspace-shortcuts" aria-labelledby="workspace-shortcuts-title">
        <header>
          <div>
            <span>ATALHOS</span>
            <h2 id="workspace-shortcuts-title">Continue de onde parou</h2>
          </div>
        </header>
        <StaggerContainer className="workspace-shortcut-row">
          {shortcuts.map((item, index) => {
            const ItemIcon = item.icon;
            return <StaggerItem key={`${item.fixed ? "fav" : "recent"}-${item.id}`} index={index}>
              <button type="button" className="workspace-shortcut" data-fixed={item.fixed ? "true" : "false"}
                onClick={() => onOpenProcess(item.id)}>
                <span aria-hidden="true"><ItemIcon /></span>
                <strong>{item.label}</strong>
                <small>{item.fixed ? "Fixado" : "Recente"}</small>
              </button>
            </StaggerItem>;
          })}
        </StaggerContainer>
      </section>
    )}

    {/* "Meus processos" (§29).
        A §28 lista quatro perguntas que a home precisa responder, e esta é a
        terceira: quais processos eu posso acessar. Antes não havia resposta —
        para descobrir o que existia, a pessoa percorria o menu item a item.

        A lista vem recortada de `visibleProcessGroups`, o mesmo caminho do
        menu, então processo sem tela alcançável não aparece aqui tampouco
        (§30). Nenhum número inventado: o rodapé de cada cartão conta os
        módulos que a pessoa realmente abre, e nada além disso. */}

    {processes.length > 0 && <section className="workspace-processes" aria-labelledby="workspace-processes-title">
      <header>
        <div>
          <span>MEUS PROCESSOS</span>
          <h2 id="workspace-processes-title">Onde a operação acontece</h2>
        </div>
        <p>{plural(processes.length, "processo disponível para o seu acesso", "processos disponíveis para o seu acesso")}</p>
      </header>
      <StaggerContainer className="workspace-process-grid">
        {processes.map((group, index) => {
          const GroupIcon = processGroupIcons[group.id] ?? Blocks;
          const pending = group.views.reduce((total, id) => total + (processBadges[id] ?? 0), 0);
          return <StaggerItem key={group.id} index={index}>
            <MotionCard
              icon={GroupIcon}
              title={group.label}
              description={group.description}
              onClick={() => onOpenProcess(group.views[0])}
              meta={<>
                <span>{plural(group.views.length, "módulo", "módulos")}</span>
                {pending ? <b className="workspace-process-pending">{pending} na triagem</b> : null}
              </>}
            />
          </StaggerItem>;
        })}
      </StaggerContainer>
    </section>}

  </div>;
}

function MemberCompanyAccess({ member, companies, busy, onSave }: { member: WorkspaceSnapshot["members"][number]; companies: WorkspaceSnapshot["companies"]; busy: boolean; onSave: (userId: string, companyIds: string[]) => Promise<void> }) {
  const [selectedIds, setSelectedIds] = useState<string[]>(member.companyIds);
  if (member.role === "admin") return <span className="member-company-summary">Todas as empresas</span>;
  return <details className="member-company-access"><summary>{selectedIds.length ? `${selectedIds.length} empresa(s) liberada(s)` : "Nenhuma empresa liberada"}</summary><div>{companies.map((company) => <label key={company.id}><input type="checkbox" checked={selectedIds.includes(company.id)} disabled={busy} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, company.id] : current.filter((id) => id !== company.id))} />{company.isPrincipal ? "★ " : "↳ "}{company.tradeName || company.legalName}</label>)}</div><button type="button" disabled={busy} onClick={() => void onSave(member.userId, selectedIds)}>Salvar empresas</button></details>;
}

function ProcessTablesView({ cards, lists, areas, onOpen }: { cards: Card[]; lists: WorkspaceSnapshot["lists"]; areas: WorkspaceSnapshot["areas"]; onOpen: (card: Card) => void }) {
  const grouped = cards.reduce<Record<string, Card[]>>((accumulator, card) => {
    (accumulator[card.processType] ??= []).push(card);
    return accumulator;
  }, {});
  const processNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
  return <div className="process-tables-view">{processNames.length === 0 && <div className="empty-view"><span>▤</span><strong>Nenhuma demanda encontrada</strong><p>Crie uma demanda para iniciar uma tabela de processo.</p></div>}{processNames.map((process) => <section key={process}><header><div><span>FLUXO ESPECÍFICO</span><strong>{process}</strong></div><b>{grouped[process].length} demanda(s)</b></header><DemandTableView cards={grouped[process]} lists={lists} areas={areas} onOpen={onOpen} /></section>)}</div>;
}

function CompanySettings({ companies, members, busy, onCreateCompany, onUpdateCompany, onDeleteCompany, onOpenAccess }: { companies: WorkspaceSnapshot["companies"]; members: WorkspaceSnapshot["members"]; busy: boolean; onCreateCompany: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onUpdateCompany: (id: string, payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onDeleteCompany: (id: string, name: string) => void; onOpenAccess: () => void }) {
  /* `null` = formulário fechado, `""` = cadastrando, um id = editando aquela
     empresa. Um estado só, porque cadastrar e editar são o mesmo formulário:
     manter dois formulários lado a lado é como o cadastro de campos acaba
     divergindo do de edição sem ninguém perceber. */
  const [editing, setEditing] = useState<string | null>(null);
  const companyName = new Map(companies.map((company) => [company.id, company.tradeName || company.legalName]));
  const principalCompanies = companies.filter((company) => company.isPrincipal);
  const orderedCompanies = [...companies].sort((a, b) => Number(b.isPrincipal) - Number(a.isPrincipal) || (companyName.get(a.parentCompanyId ?? "") ?? "").localeCompare(companyName.get(b.parentCompanyId ?? "") ?? "") || (a.tradeName || a.legalName).localeCompare(b.tradeName || b.legalName));
  const current = editing ? companies.find((company) => company.id === editing) ?? null : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      legalName: data.get("legalName"), tradeName: data.get("tradeName"), taxId: data.get("taxId"),
      externalCode: data.get("externalCode"), email: data.get("email"), phone: data.get("phone"),
      companyType: data.get("companyType"), parentCompanyId: data.get("parentCompanyId"),
    };
    const result = current
      // Ao editar, a situação também é editável: desativar um CNPJ é o caminho
      // de quem não pode excluí-lo por causa do histórico.
      ? await onUpdateCompany(current.id, { ...payload, status: data.get("status") })
      : await onCreateCompany(payload);
    if (result) { form.reset(); setEditing(null); }
  }

  return <div className="company-settings-view">
    <section className="company-settings-intro">
      <span><Building2 aria-hidden="true" /></span><div><strong>Empresas do grupo</strong><p>Cadastre a empresa principal e os CNPJs vinculados. Esses cadastros ficam disponíveis para demandas, folha, permissões e integrações.</p></div><b>{companies.length} empresa(s)</b>
    </section>
    <section className="company-settings-access"><div><strong>Controle de acesso por empresa</strong><p>Após cadastrar um CNPJ, escolha quais usuários poderão consultar ou operar demandas daquela empresa.</p></div><button className="secondary-button" onClick={onOpenAccess}><Users aria-hidden="true" /> Gerenciar usuários e acessos</button></section>
    <section className="company-settings-catalog">
      <header><div><strong>Cadastros do grupo</strong><span>CNPJ, estrutura societária, contato e código externo para Sankhya.</span></div><button className="primary-button" disabled={busy} onClick={() => setEditing((value) => value === null ? "" : null)}><Plus aria-hidden="true" /> {editing === null ? "Cadastrar empresa" : "Fechar formulário"}</button></header>
      {editing !== null && <form className="company-settings-form" key={editing || "new"} onSubmit={submit}>
        <label>Tipo<select name="companyType" defaultValue={current ? (current.isPrincipal ? "principal" : "subsidiary") : companies.some((company) => company.isPrincipal) ? "subsidiary" : "principal"} disabled={busy}><option value="principal">Empresa principal do grupo</option><option value="subsidiary">Empresa / CNPJ do grupo</option></select></label>
        <label>Empresa principal<select name="parentCompanyId" defaultValue={current?.parentCompanyId ?? ""} disabled={busy}><option value="">Vincular à principal automaticamente</option>{principalCompanies.filter((company) => company.id !== current?.id).map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
        <label>Razão social<input name="legalName" defaultValue={current?.legalName ?? ""} placeholder="Empresa Exemplo Ltda." maxLength={160} required disabled={busy} /></label>
        <label>Nome fantasia<input name="tradeName" defaultValue={current?.tradeName ?? ""} placeholder="Empresa Exemplo" maxLength={160} disabled={busy} /></label>
        <label>CNPJ<input name="taxId" defaultValue={current?.taxId ?? ""} placeholder="00.000.000/0001-00" maxLength={30} disabled={busy} /></label>
        <label>Código Sankhya<input name="externalCode" defaultValue={current?.externalCode ?? ""} placeholder="COD_EMPRESA" maxLength={80} disabled={busy} /></label>
        <label>E-mail<input type="email" name="email" defaultValue={current?.email ?? ""} maxLength={160} disabled={busy} /></label>
        <label>Telefone<input name="phone" defaultValue={current?.phone ?? ""} maxLength={40} disabled={busy} /></label>
        {current && <label>Situação<select name="status" defaultValue={current.status} disabled={busy}><option value="active">Ativa</option><option value="inactive">Inativa</option></select></label>}
        <div className="company-settings-form-actions">
          {current && <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>Cancelar</button>}
          <button className="primary-button" disabled={busy}>{current ? "Salvar alterações" : "Salvar empresa"}</button>
        </div>
      </form>}
      <div className="company-settings-list">
        {orderedCompanies.length === 0 && <div className="empty-view"><span><Building2 aria-hidden="true" /></span><strong>Nenhuma empresa cadastrada</strong><p>Cadastre a empresa principal para estruturar o grupo e liberar acessos.</p></div>}
        {orderedCompanies.map((company) => {
          const allowedMembers = members.filter((member) => member.role === "admin" || member.companyIds.includes(company.id)).length;
          return <article className={company.isPrincipal ? "principal" : "subsidiary"} key={company.id}><i>{company.isPrincipal ? "P" : "↳"}</i><div><strong>{company.tradeName || company.legalName}{company.isPrincipal && <em>Principal</em>}{company.status === "inactive" && <em className="inactive">Inativa</em>}</strong><small>{company.isPrincipal ? "Empresa raiz do grupo" : `Grupo: ${companyName.get(company.parentCompanyId ?? "") ?? "Principal"}`} · {company.taxId || "CNPJ não informado"}</small></div><span><small>Usuários com acesso</small><b>{allowedMembers}</b></span><span><small>Sankhya</small><b>{company.externalCode || "Não vinculado"}</b></span><button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(editing === company.id ? null : company.id)} aria-label={`Editar ${company.tradeName || company.legalName}`}>{editing === company.id ? "Editando" : "Editar"}</button><button className="danger-link" type="button" disabled={busy} onClick={() => onDeleteCompany(company.id, company.legalName)}>Excluir</button></article>;
        })}
      </div>
    </section>
  </div>;
}

function PayrollView({ companies, metrics, busy, canEdit, onSaveMetric, onImportPayroll }: { companies: WorkspaceSnapshot["companies"]; metrics: WorkspaceSnapshot["hrMetrics"]; busy: boolean; canEdit: boolean; onSaveMetric: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onImportPayroll: (body: FormData) => Promise<WorkspaceSnapshot | null> }) {
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const [selectedPeriod, setSelectedPeriod] = useState(currentPeriod);
  const [importOpen, setImportOpen] = useState(false);
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
    <section className="payroll-toolbar"><div><span>COMPETÊNCIA</span><h2>Painel consolidado da folha</h2><p>Os indicadores são recalculados automaticamente a cada lançamento, importação ou sincronização.</p></div><div className="payroll-toolbar-actions">{canEdit && <button className="secondary-button" onClick={() => setImportOpen(true)}><Upload aria-hidden="true" /> Importar extrato PDF</button>}<label>Período<select value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}>{periods.map((period) => <option key={period}>{period}</option>)}</select></label></div></section>
    <section className="payroll-kpi-grid"><article><WalletCards aria-hidden="true" /><span>Custo total da folha</span><strong>{money(totalCost)}</strong><small>{selectedMetrics.length} empresa(s) com competência</small></article><article><Users aria-hidden="true" /><span>Headcount médio</span><strong>{totalHeadcount}</strong><small>{totalAdmissions} admissões · {totalTerminations} desligamentos</small></article><article><BarChart3 aria-hidden="true" /><span>Turnover</span><strong>{turnover.toFixed(2)}%</strong><small>Movimentação ÷ headcount médio</small></article><article><Building2 aria-hidden="true" /><span>Custo por colaborador</span><strong>{money(costPerEmployee)}</strong><small>Baseado no headcount médio</small></article></section>
    <div className="payroll-layout">
      <section className="payroll-composition"><header><div><strong>Composição do custo</strong><span>Distribuição da competência selecionada</span></div><b>{money(totalCost)}</b></header><div className="payroll-bars">{componentTotals.map((item) => <div key={item.label}><span><strong>{item.label}</strong><small>{money(item.value)}</small></span><i><b style={{ width: `${totalCost ? Math.min(100, (item.value / totalCost) * 100) : 0}%`, backgroundColor: item.color }} /></i></div>)}</div></section>
      <section className="payroll-company-breakdown"><header><div><strong>Folha por empresa</strong><span>{selectedMetrics.length} lançamento(s) em {selectedPeriod}</span></div></header>{selectedMetrics.length === 0 && <div className="empty-view"><span><WalletCards aria-hidden="true" /></span><strong>Sem lançamentos nesta competência</strong><p>Registre os dados da folha para gerar os indicadores automaticamente.</p></div>}{selectedMetrics.map((metric) => <article key={metric.id}><div><strong>{companyName.get(metric.companyId) ?? "Empresa removida"}</strong><small>{metric.headcount} colaboradores · {metric.admissions} admissões · {metric.terminations} desligamentos · líquido {money(metric.netPay)}</small></div><span>{money(metric.payrollCost)}</span><b>{metric.source === "sankhya" ? "Sankhya" : metric.source === "pdf_import" ? "PDF" : "Manual"}</b></article>)}</section>
    </div>
    {importOpen && <PayrollImportDialog companies={companies} importing={busy} onClose={() => setImportOpen(false)} onImport={onImportPayroll} onImported={(period) => { setImportOpen(false); setSelectedPeriod(period); }} />}
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

function DemandTableView({ cards, lists, areas, onOpen }: { cards: Card[]; lists: WorkspaceSnapshot["lists"]; areas: WorkspaceSnapshot["areas"]; onOpen: (card: Card) => void }) {
  const listNames = new Map(lists.map((list) => [list.id, list.name]));
  return (
    <section className="demand-table-view">
      <header><div><strong>Visão gerencial</strong><span>{cards.length} demanda(s) nos filtros atuais</span></div><span>Selecione uma linha para abrir os detalhes.</span></header>
      <div className="demand-table-scroll">
        <table>
          <thead><tr><th>Demanda</th><th>Fluxo entre áreas</th><th>Processo</th><th>Status</th><th>Responsáveis</th><th>Prazo / SLA</th><th>Checklist</th></tr></thead>
          <tbody>{cards.map((card) => {
            const complete = card.checklist.filter((item) => item.completed).length;
            return <tr key={card.id} tabIndex={0} onClick={() => onOpen(card)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpen(card); }}><td><strong>{card.title}</strong><small>{card.company || "Sem empresa"}</small></td><td><DemandAreaFlow card={card} areas={areas} /></td><td><span className={`table-process ${processColors[card.processType] ?? "gray"}`}>{card.processType}</span></td><td>{listNames.get(card.listId) ?? "—"}</td><td>{card.assignees.map((item) => item.name).join(", ") || card.assigneeName || "Não atribuído"}</td><td><em className={card.slaStatus}>{slaLabel(card)}</em></td><td>{complete}/{card.checklist.length}</td></tr>;
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

/**
 * A faixa de indicadores da Administração (maquete 3).
 *
 * Os cinco números que dizem o tamanho do que está sendo administrado, antes
 * dos formulários que o alteram. Todos saem do snapshot que a modal já tem em
 * mãos — nenhuma consulta nova, e nenhum valor escrito no código.
 *
 * A maquete traz também "Plano e utilização" com barras de consumo. Ele não
 * entra: a tela de plano foi tirada do painel de propósito (§44), e há teste
 * guardando essa retirada. Ressuscitá-la de lado, como faixa de progresso sem
 * a tela por trás, seria mostrar consumo sem lugar nenhum para agir sobre ele.
 */
function AdminIndicators({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const ativas = snapshot.companies.filter((company) => company.status === "active").length;
  const comErro = snapshot.integrations.filter((item) => item.status === "error").length;
  const conectadas = snapshot.integrations.filter((item) => item.status === "connected").length;
  const semAtivar = snapshot.members.filter((member) => !member.isActivated).length;
  const etapas = snapshot.boards.reduce((total, board) => total + board.stages.length, 0);

  const indicadores = [
    {
      key: "members", icon: Users, label: "Usuários com acesso",
      value: String(snapshot.members.length),
      support: semAtivar ? `${semAtivar} ainda sem ativar o acesso` : "Todos com acesso ativado",
      alert: semAtivar > 0,
    },
    {
      key: "companies", icon: Building2, label: "Empresas do grupo",
      value: String(snapshot.companies.length),
      support: `${ativas} em operação`,
      alert: false,
    },
    {
      key: "workspaces", icon: LayoutDashboard, label: "Workspaces acessíveis",
      value: String(snapshot.availableWorkspaces.length),
      support: snapshot.workspace.companyScope === "restricted"
        ? "Seu acesso é restrito a algumas empresas"
        : "Seu acesso alcança todas as empresas",
      alert: false,
    },
    {
      key: "boards", icon: ClipboardList, label: "Quadros da operação",
      value: String(snapshot.boards.length),
      support: plural(etapas, "etapa configurada", "etapas configuradas"),
      alert: false,
    },
    {
      key: "integrations", icon: Cable, label: "Integrações com erro",
      value: String(comErro),
      support: `${conectadas} conectada(s) de ${snapshot.integrations.length} configurada(s)`,
      alert: comErro > 0,
    },
  ];

  return <section className="admin-indicators" aria-label={`Indicadores da administração — ${snapshot.workspace.name}`}>
    {indicadores.map((item) => {
      const ItemIcon = item.icon;
      return <article key={item.key} className={`admin-indicator${item.alert ? " requires-attention" : ""}`}>
        <span className="admin-indicator-top">
          <span>{item.label}</span>
          <i aria-hidden="true"><ItemIcon /></i>
        </span>
        <strong>{item.value}</strong>
        <small>{item.support}</small>
      </article>;
    })}
  </section>;
}

/**
 * A matriz de permissões (maquete 3).
 *
 * O modelo já existia inteiro e nunca chegou a uma tela: `capabilitiesForRole`
 * nasceu com o comentário "a tela de usuários precisa mostrar o que cada papel
 * concede — sem isso o administrador escolhe 'Membro' ou 'Observador' no
 * escuro", e nenhum componente jamais o chamou. O seletor de papel logo acima
 * desta matriz é exatamente essa escolha no escuro.
 *
 * As linhas são as capacidades reais, agrupadas pelas áreas do catálogo e
 * escritas na linguagem dele — `competences.transition` não diz nada a quem
 * administra; "Avançar a competência entre as etapas do fechamento" diz.
 *
 * A maquete desenha três estados por célula: concedido, parcial e negado. O
 * "parcial" não existe no modelo — uma capacidade é do papel ou não é — então
 * ele não é desenhado. Inventar um meio-termo numa matriz de permissão é o
 * tipo de enfeite que faz alguém conceder acesso achando que concedeu menos.
 */
function PermissionMatrix() {
  const [aberta, setAberta] = useState<CapabilityArea | "">("");
  const papeis = workspaceRoles;
  const concedidas = new Map(papeis.map((papel) => [papel, new Set<string>(capabilitiesForRole(papel))]));

  return <section className="permission-matrix" aria-labelledby="permission-matrix-title">
    <header>
      <div>
        <strong id="permission-matrix-title">O que cada papel permite</strong>
        <span>Lista completa, direto do modelo de autorização — não é um resumo escrito à mão.</span>
      </div>
    </header>
    {capabilityAreas.map((area) => {
      const itens = capabilitiesOfArea(area.key);
      if (itens.length === 0) return null;
      const expandida = aberta === area.key;
      return <div className="permission-area" key={area.key}>
        <button type="button" aria-expanded={expandida}
          onClick={() => setAberta(expandida ? "" : area.key)}>
          <span>{area.label}</span>
          <b>{plural(itens.length, "permissão", "permissões")}</b>
          <ChevronDown aria-hidden="true" data-open={expandida ? "true" : "false"} />
        </button>
        {expandida && <div className="overview-table-scroll">
          <table className="overview-table permission-table">
            <thead><tr>
              <th scope="col">Permissão</th>
              {papeis.map((papel) => <th scope="col" key={papel}>{roleLabels[papel]}</th>)}
            </tr></thead>
            <tbody>
              {itens.map((capability) => <tr key={capability}>
                <th scope="row">{capabilityCatalog[capability].label}</th>
                {papeis.map((papel) => {
                  const tem = concedidas.get(papel)?.has(capability) ?? false;
                  /* O símbolo sozinho não basta: quem usa leitor de tela ouve
                     "check" sem saber de quê, e quem não distingue verde de
                     cinza vê duas marcas parecidas. O texto acessível diz o
                     par inteiro — papel e permissão. */
                  return <td key={papel} className={tem ? "concedida" : "negada"}>
                    <span aria-hidden="true">{tem ? "\u2713" : "\u2014"}</span>
                    <span className="sr-only">
                      {roleLabels[papel]}: {tem ? "permitido" : "não permitido"}
                    </span>
                  </td>;
                })}
              </tr>)}
            </tbody>
          </table>
        </div>}
      </div>;
    })}
  </section>;
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
  type ActionType = "moveTo" | "slaStatus" | "labelId" | "notify";
  /* Rótulos e gatilhos vêm de `lib/automation-rules` (§27): a tela que
     oferecesse um gatilho a mais entregaria uma regra que o servidor recusa, e
     um a menos esconderia automação que o motor executa. */
  const triggerLabels = RULE_TRIGGER_LABELS as Record<string, string>;
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
    if (typeof action.notify === "string") return `notificar o responsável: “${action.notify}”`;
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
    else if (typeof action.notify === "string") { setActionType("notify"); setActionValue(action.notify); }
    else { const nextAction = defaultActionFor(nextTrigger); setActionType(nextAction.type); setActionValue(nextAction.value); }
    setEditorError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    if (!actionValue) { setEditorError("Escolha a ação que a automação deverá executar."); return; }
    const fixedCondition = trigger === "assignee.added" ? { assignee: "present" } : trigger === "checklist.completed" ? { allItems: true } : trigger === "sla.tick" ? { dueAt: "past" } : {};
    const condition = conditionType === "processType" ? { processType: conditionValue } : conditionType === "priority" ? { priority: conditionValue } : conditionType === "toList" ? { listKind: conditionValue } : fixedCondition;
    const action = actionType === "moveTo" ? { moveTo: actionValue } : actionType === "slaStatus" ? { slaStatus: actionValue } : actionType === "notify" ? { notify: actionValue } : { labelId: actionValue };
    const result = await onCatalog({ resource: "rule", operation: editingId ? "update" : "create", id: editingId ?? "", name, trigger, condition, action, enabled: true }, editingId ? "Automação atualizada." : "Automação criada.");
    if (result) setEditorOpen(false);
  }
  const showConditionSelector = trigger === "card.created" || trigger === "card.moved";
  const fixedConditionText = trigger === "assignee.added" ? "Só continua se houver um responsável atribuído." : trigger === "checklist.completed" ? "Só continua quando todas as etapas estiverem concluídas." : trigger === "sla.tick" ? "Só continua quando o prazo estiver vencido." : "Sem condição adicional.";

  return <div className="settings-stack"><section className="catalog-section rules-editor"><header><div><strong>Editor No-Code</strong><span>Regras ativas que executam tarefas automaticamente no fluxo do DP.</span></div>{isAdmin && <button className="secondary-button" onClick={() => edit()}><Plus aria-hidden="true" /> Nova regra</button>}</header><div className="rule-catalog no-code-rule-catalog">{snapshot.rules.length === 0 && <div className="empty-view"><span><ListChecks aria-hidden="true" /></span><strong>Nenhuma automação criada</strong><p>Crie uma regra para padronizar o fluxo da sua operação.</p></div>}{snapshot.rules.map((rule) => <article key={rule.id}><div><strong>{rule.name}</strong><div className="rule-flow"><span>Quando {triggerLabels[rule.trigger] ?? rule.trigger}</span><ArrowRight aria-hidden="true" /><span>Se {conditionLabel(rule.condition)}</span><ArrowRight aria-hidden="true" /><span>Então {actionLabel(rule.action)}</span></div></div>{isAdmin && <><button onClick={() => edit(rule)}>Editar</button><button className="danger" disabled={busy} onClick={() => onConfirm({ title: "Excluir automação?", description: `A regra “${rule.name}” deixará de ser executada na operação.`, confirmLabel: "Excluir automação", action: () => onCatalog({ resource: "rule", operation: "delete", id: rule.id }, "Automação excluída.") })}>Excluir</button></>}</article>)}</div></section>{isAdmin && editorOpen && <form className="catalog-section rule-editor-form no-code-editor" onSubmit={save}><header><div><strong>{editingId ? "Editar automação" : "Nova automação"}</strong><span>Escolha o evento, a condição e o resultado desejado. O sistema traduz isso para uma regra auditável.</span></div><button type="button" className="danger-link" onClick={() => setEditorOpen(false)}>Cancelar</button></header><div className="no-code-editor-body"><label className="wide">Nome da automação<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Ao concluir checklist, finalizar demanda" required /></label><section><span>1. Quando</span><label>Gatilho<select value={trigger} onChange={(event) => changeTrigger(event.target.value)}>{RULE_TRIGGERS.map((item) => <option key={item} value={item}>Quando {RULE_TRIGGER_LABELS[item]}</option>)}</select></label></section><ArrowRight className="flow-arrow" aria-hidden="true" /><section><span>2. Se</span>{showConditionSelector ? <><label>Condição<select value={conditionType} onChange={(event) => { setConditionType(event.target.value as ConditionType); setConditionValue(""); }}><option value="always">Sem condição adicional</option>{trigger === "card.created" && <><option value="processType">O processo for</option><option value="priority">A prioridade for</option></>}{trigger === "card.moved" && <option value="toList">A coluna de destino for</option>}</select></label>{conditionType === "processType" && <label>Processo<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option>{["ADMISSÃO", "FÉRIAS", "RESCISÃO", "BENEFÍCIOS", "FOLHA", "CADASTRO", "OUTROS"].map((item) => <option key={item}>{item}</option>)}</select></label>}{conditionType === "priority" && <label>Prioridade<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option>{["low", "normal", "high", "urgent"].map((nivel) => <option key={nivel} value={nivel}>{PRIORITY_LABELS[nivel]}</option>)}</select></label>}{conditionType === "toList" && <label>Coluna<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.lists.map((list) => <option value={list.kind} key={list.id}>{list.name}</option>)}</select></label>}</> : <div className="fixed-rule-condition"><CheckCircle2 aria-hidden="true" />{fixedConditionText}</div>}</section><ArrowRight className="flow-arrow" aria-hidden="true" /><section><span>3. Então</span><label>Ação<select value={actionType} onChange={(event) => { setActionType(event.target.value as ActionType); setActionValue(""); }}><option value="moveTo">Mover a demanda</option><option value="slaStatus">Atualizar o SLA</option><option value="labelId">Aplicar uma etiqueta</option><option value="notify">Notificar o responsável</option></select></label>{actionType === "moveTo" && <label>Coluna de destino<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.lists.map((list) => <option value={list.kind} key={list.id}>{list.name}</option>)}</select></label>}{actionType === "slaStatus" && <label>Novo status<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option><option value="safe">Dentro do prazo</option><option value="overdue">Atrasado</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label>}{actionType === "labelId" && <label>Etiqueta<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.labels.map((label) => <option value={label.id} key={label.id}>{label.name}</option>)}</select></label>}{actionType === "notify" && <label>Aviso<input value={actionValue} onChange={(event) => setActionValue(event.target.value)} maxLength={160} placeholder="Ex.: Documentação vencida — conferir a demanda" required /></label>}</section></div>{editorError && <p className="no-code-editor-error" role="alert"><CircleAlert aria-hidden="true" />{editorError}</p>}<footer><span>Prévia: Quando {triggerLabels[trigger] ?? trigger}, se {conditionType === "always" ? fixedConditionText.toLowerCase() : "a condição selecionada for atendida"}, então {actionType === "moveTo" ? "a demanda será movida" : actionType === "slaStatus" ? "o SLA será atualizado" : actionType === "notify" ? "quem responde pela demanda será avisado" : "uma etiqueta será aplicada"}.</span><button className="primary-button" disabled={busy}>Salvar automação</button></footer></form>}</div>;
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
  type ReportHrMetrics = {
    admissions: number; terminations: number; averageHeadcount: number;
    payrollCostTotal: number; turnoverRate: number; payrollByCompany: Record<string, number>;
  };
  type ReportSummary = {
    from: string; to: string; total: number; completed: number; completionRate: number;
    averageCompletionHours: number; activityCount: number; byProcess: Record<string, number>;
    hrMetrics?: ReportHrMetrics;
  };
  const [report, setReport] = useState<ReportSummary | null>(null);
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
