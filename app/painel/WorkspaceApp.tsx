"use client";

import dynamic from "next/dynamic";
import { ModuleLoading } from "./features/shared/ModuleLoading";
import Image from "next/image";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  defaultPanelLocation, panelPath, parsePanelPath,
  type PanelLocation, type PanelSettingsSection, type PanelView,
} from "@/lib/panel-routes";
import { LayoutGrid, Settings,
  ArrowLeft,
  
  BarChart3,
  Bell,
  Blocks,
  Bot,
  Briefcase,
  CalendarCheck2,
  Building2,
  Cable,
  HandCoins,
  HardHat,
  History,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  
  ChevronRight,
  CircleAlert,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  Download,
  GitBranch,
  Inbox,
  LayoutDashboard,
  ListChecks,

  Paperclip,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Siren,
  AlertTriangle,
  Smartphone,
  Stethoscope,

  Timer,
  
  
  Users,
  WalletCards,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";
import { activityDetails, activityLabel, compactSlaLabel, formatDate, formatMoment, plural } from "./features/overview/formatting";
import { OverviewView } from "./features/overview/OverviewView";
import { DemandTableView, InboxView, PayrollView, PlannerView } from "./features/workspace-views/WorkspaceViews";
import { DemandAreaFlow, formatDue, processColors, slaLabel } from "./features/shared/demand-display";
import { AdminIndicators, CompanySettings, FieldsSettings, ListsSettings, MemberCompanyAccess, MemberEmployeeLink, PermissionMatrix, RulesSettings, TemplatesSettings } from "./features/settings/SettingsPanels";
import { roleLabels, type CatalogHandler, type ConfirmationRequest } from "./features/settings/settings.types";
import type { Card, CardAttachment, InboxItem, ProcessFlowSummary, WorkspaceMember, WorkspaceRole, WorkspaceSnapshot } from "@/lib/fila-dp-types";
import type { ActionTarget } from "@/lib/action-center";
import { hasSubNavigation, isContractorOnly, visibleProcessGroups } from "@/lib/process-navigation";
import { ModuleLauncher, type LauncherModule } from "./features/shared/ModuleLauncher";
import { CompanyPicker } from "./features/shared/CompanyPicker";
import { AccountMenu } from "./features/shared/AccountMenu";
import { initialsOf } from "@/lib/initials";
import { PRIORITY_LABELS } from "@/lib/work-items";
import {
  THEME_COOKIE, THEME_COOKIE_MAX_AGE, THEME_SYSTEM_COOKIE,
  type ResolvedTheme, type ThemePreference,
} from "@/lib/theme";
import { DENSITY_KEY, parseDensity, type Density } from "@/lib/density";
import { chooseRegistrationFormAttachment } from "@/lib/registration-form-file";
import { capabilitiesForRole, hasCapability } from "@/lib/authorization";
import { roleSummaries } from "@/lib/capability-catalog";
import { formatWorkingMinutes } from "@/lib/fila-dp-sla";
import { overviewPeriodLabel, overviewPeriods, periodWindowEnd, periodWindowStart, withinPeriod, type OverviewPeriod } from "@/lib/overview-period";
import { AnimatedDrawer, AnimatedTabs, CenterToast, competenceLabel, ProcessTabsProvider, ViewPaneActiveContext, MemberModules, PageTransition } from "./features/shared";
import { RequestError, requestErrorFrom, supportReference } from "./request-error";
import { contractorSections, isContractorSection, type ContractorSectionId } from "./features/payments/contractor-sections";
import { DemandDeadlineView } from "./features/work/DemandViews";
import {
  BoardIndicators, BoardToolbar, BulkBar, KanbanBoard, QueueBoard, TeamBoard,
  activeFilterCount, applyMoveOptimistically, canRespondForDemands, demandIndicators, filterDemands, operationalAlerts,
  applyAssigneeOptimistically, boardViewModes, parseSavedViews, readBoardFilters,
  responsibleColumns, slaReading, toggleIndicator, writeBoardFilters,
  SAVED_VIEWS_LIMIT,
  type BoardAlert, type BoardContext, type BulkAction, type DemandFilters, type DemandSort,
  type IndicatorId, type KanbanDrop, type SavedBoardView,
} from "./features/board";
import { contagem } from "./features/shared/plural";

/* Cada módulo do painel é carregado quando é aberto (§ desempenho).
   Antes, as vinte telas vinham no mesmo pacote: quem usava só EPI baixava
   Pagamento PJ, Folha e Processos para abrir o painel. */
const HistoryView = dynamic(() => import("./features/history/HistoryView").then((module) => module.HistoryView), { loading: ModuleLoading });
const PortfolioView = dynamic(() => import("./features/portfolio/PortfolioView").then((module) => module.PortfolioView), { loading: ModuleLoading });
const DpOperationsView = dynamic(() => import("./features/dp/DpOperationsView").then((module) => module.DpOperationsView), { loading: ModuleLoading });
const RegistrationSheetPanel = dynamic(() => import("./features/admission/RegistrationSheetPanel").then((module) => module.RegistrationSheetPanel), { loading: ModuleLoading });
const AssistantPanel = dynamic(() => import("./features/assistant/AssistantPanel").then((module) => module.AssistantPanel), { loading: ModuleLoading });
const RegistrationsView = dynamic(() => import("./features/registrations/RegistrationsView").then((module) => module.RegistrationsView), { loading: ModuleLoading });
const OperationsView = dynamic(() => import("./features/operations/OperationsView").then((module) => module.OperationsView), { loading: ModuleLoading });
const ProcessManagementView = dynamic(() => import("./features/processes/ProcessManagementView").then((module) => module.ProcessManagementView), { loading: ModuleLoading });
const AuxiliaryModulesView = dynamic(() => import("./features/auxiliary/AuxiliaryModulesView").then((module) => module.AuxiliaryModulesView), { loading: ModuleLoading });
const IntegrationsView = dynamic(() => import("./features/integrations/IntegrationsView").then((module) => module.IntegrationsView), { loading: ModuleLoading });
const TimeTrackingView = dynamic(() => import("./features/time/TimeTrackingView").then((module) => module.TimeTrackingView), { loading: ModuleLoading });
const EpiControlView = dynamic(() => import("./features/epi/EpiControlView").then((module) => module.EpiControlView), { loading: ModuleLoading });
const LedgerView = dynamic(() => import("./features/ledger/LedgerView").then((module) => module.LedgerView), { loading: ModuleLoading });
const ErpDpView = dynamic(() => import("./features/erp-dp/ErpDpView").then((module) => module.ErpDpView), { loading: ModuleLoading });
const WorkAccidentDashboardView = dynamic(() => import("./features/safety/WorkAccidentDashboardView").then((module) => module.WorkAccidentDashboardView), { loading: ModuleLoading });
const AgentsView = dynamic(() => import("./features/work/AgentsView").then((module) => module.AgentsView), { loading: ModuleLoading });
const CardProcessPanel = dynamic(() => import("./features/work/CardProcessPanel").then((module) => module.CardProcessPanel), { loading: ModuleLoading });
const TriageView = dynamic(() => import("./features/work/TriageView").then((module) => module.TriageView), { loading: ModuleLoading });
const WorkCenterView = dynamic(() => import("./features/work/WorkCenterView").then((module) => module.WorkCenterView), { loading: ModuleLoading });
const TrelloImportPanel = dynamic(() => import("./features/boards/TrelloImportPanel").then((module) => module.TrelloImportPanel), { loading: ModuleLoading });
const PaymentsView = dynamic(() => import("./features/payments/PaymentsView").then((module) => module.PaymentsView), { loading: ModuleLoading });

/* Os oito destinos do Pagamento PJ (§74) estão escritos aqui um a um, e não
   como `ContractorSectionId`: esta união é a lista de telas do painel, e é ela
   que se lê para conferir que toda tela tem porta no menu. Um apelido de tipo
   esconderia oito telas de quem confere. */
type View = "overview" | "work" | "board" | "inbox" | "planner" | "processManagement" | "processes" | "auxiliary" | "psychologistPayments" | "contractorPayments" | "contractorProviders" | "contractorCycles" | "contractorClosings" | "contractorInvoices" | "contractorAdjustments" | "contractorLimits" | "contractorCaju" | "contractorArchive" | "payrollLedger" | "timeTracking" | "epi" | "safety" | "integrations" | "agents" | "triage" | "registrations" | "portfolio" | "dpOperations" | "payroll" | "indicators" | "history";
/* Os eixos do quadro. `team` e `queue` chegaram com a Operação DP: o primeiro
   é o quadro por responsável — o modo principal —, o segundo é a fila de uma
   pessoa separada por urgência. Os quatro antigos continuam porque cada um
   responde uma pergunta que os novos não respondem. */
type BoardMode = "team" | "queue" | "kanban" | "table" | "calendar" | "process";
type BoardDensity = "comfortable" | "compact";
type BoardGroupBy = "none" | "company" | "assignee";
/* A ordem do quadro. "Mais recentes" e "mais antigas" chegaram com a Operação
   DP: quem confere a fila do dia lê pela chegada, e ordenar por prazo esconde
   a solicitação que entrou há dez minutos no meio de um mês de demandas.
   O tipo é o do modelo do quadro para que os dois não divirjam. */
type BoardSort = DemandSort;

/** Destinos que a faixa de indicadores alcança (§14). Subconjunto de `View`. */

type CardTab = "details" | "process" | "checklist" | "attachments" | "sheet" | "activity";
type SettingsSection = "general" | "companies" | "columns" | "team" | "matrix" | "security" | "fields" | "templates" | "sla" | "automations";

/**
 * Cada seção de configuração precisa de um cabeçalho próprio.
 *
 * Antes o cabeçalho tinha só dois textos escritos à mão — um para "security" e
 * outro para todo o resto — o que fazia sete telas anunciarem "Usuários e
 * acessos" no título. Com o mapa, acrescentar uma seção sem lhe dar um nome
 * passa a ser um erro de tipo, e não uma tela mal rotulada em produção.
 */
/** Preferência local do modo do painel (Vinculato, ERP DP ou Sistema PJ) — ver `appMode`. */
const APP_MODE_KEY = "vinculato.app-mode";
const SHELL_TABS_KEY = "vinculato-abas";
const MAX_SHELL_TABS = 8;

const settingsSectionMeta: Record<SettingsSection, { group: string; title: string; description: string }> = {
  security: { group: "Conta", title: "Perfil e segurança", description: "Revise apenas as sessões da identidade atual." },
  general: { group: "Workspace", title: "Geral", description: "Nome do workspace, quadros disponíveis e a conta com que você está entrando." },
  companies: { group: "Workspace", title: "Empresas", description: "Cadastre, edite e organize os CNPJs do grupo." },
  team: { group: "Pessoas e acesso", title: "Usuários e acessos", description: "Defina o departamento e os módulos disponíveis para cada usuário." },
  matrix: { group: "Pessoas e acesso", title: "Papéis e permissões", description: "O que cada papel pode fazer no grupo." },
  columns: { group: "Operação", title: "Colunas", description: "Nome, ordem e efeito de cada coluna sobre o SLA." },
  fields: { group: "Operação", title: "Campos e etiquetas", description: "Etiquetas e campos personalizados que aparecem nas demandas." },
  /* "Modelos", e não "Templates": a tela vizinha chama a mesma coisa de modelo
     de processo, e duas palavras para um conceito só é o tipo de divergência
     que faz alguém procurar a configuração no lugar errado. */
  templates: { group: "Operação", title: "Modelos", description: "Checklists e SLA prontos para abrir uma demanda sem esquecer etapas." },
  sla: { group: "Operação", title: "SLA e calendário", description: "Expediente, feriados e metas de prazo por processo." },
  automations: { group: "Operação", title: "Automações", description: "Regras que reagem automaticamente aos eventos das demandas." },
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
  { label: "Workspace", sections: [
    { section: "general", icon: LayoutDashboard, hint: "Nome, workspaces e quadros", adminOnly: false },
    { section: "companies", icon: Building2, hint: "CNPJs do grupo", adminOnly: true },
  ] },
  { label: "Pessoas e acesso", sections: [
    { section: "team", icon: Users, hint: "Departamento e módulos", adminOnly: true },
    { section: "matrix", icon: ShieldCheck, hint: "O que cada papel pode fazer", adminOnly: true },
  ] },
  { label: "Operação", sections: [
    { section: "columns", icon: ListChecks, hint: "Etapas e SLA", adminOnly: true },
    { section: "fields", icon: Blocks, hint: "Etiquetas e campos", adminOnly: true },
    { section: "templates", icon: ClipboardCheck, hint: "Checklists prontos", adminOnly: true },
    { section: "sla", icon: CalendarClock, hint: "Expediente e feriados", adminOnly: true },
    { section: "automations", icon: Workflow, hint: "Regras automáticas", adminOnly: true },
  ] },
  { label: "Conta", sections: [
    { section: "security", icon: Smartphone, hint: "Dispositivos e sessões", adminOnly: false },
  ] },
];
type RealtimeStatus = "syncing" | "current" | "delayed";
type User = { displayName: string; email: string; fullName: string | null };
type SearchResult = { id: string; title: string; company: string; processType: string; priority: string; slaStatus: string; dueAt: string | null; assigneeName: string; archived: boolean; listId: string };
type SearchRecord = { kind: string; id: string; title: string; subtitle: string; badge: string; target: ActionTarget | "registrations" };
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
  /** A próxima ação, em uma frase. Vazio é estado legítimo (§14). */
  nextStep: string;
  /** Data que o pedido mira (início, saída de férias, decisão): a regra de corte compara com ela. */
  requestedFor: string;
};

const emptyCardForm: CardForm = {
  nextStep: "",
  requestedFor: "",
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
    eyebrow: "Pagamento PJ", title: section.label, description: section.description,
  };
}

const viewCatalog: Record<View, ViewEntry> = {
  overview: {
    label: "Visão geral", icon: LayoutDashboard,
    eyebrow: "Visão geral", title: "Visão geral",
    description: "Acompanhe o que exige ação e mantenha a operação sob controle.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  work: {
    label: "Meu trabalho", icon: ClipboardList,
    eyebrow: "Central de trabalho", title: "Meu trabalho",
    description: "Demandas, aprovações, movimentações, entregas, pendências, triagem e falhas que exigem ação — em uma lista só.",
    ownHeader: true,
  },
  board: {
    label: "Demandas", icon: ListChecks,
    /* O título é o mesmo nome do item de menu, de propósito. O menu dizia
       "Demandas", a trilha dizia "Quadro de demandas" e o título repetia a
       trilha: três nomes para uma tela só, e a palavra "quadro" ainda por cima
       colidindo com o seletor de quadro que mora dentro dela. */
    eyebrow: "Demandas", title: "Demandas",
    description: "Acompanhe as execuções do seu departamento.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  inbox: {
    label: "Inbox", icon: Inbox, module: "inbox",
    eyebrow: "Triagem multicanal", title: "Caixa de entrada",
    description: "Transforme solicitações recebidas em demandas rastreáveis.",
    primaryAction: { label: "Nova solicitação", kind: "inbox" },
  },
  planner: {
    label: "Planner", icon: CalendarDays, module: "planner",
    eyebrow: "Agenda do analista", title: "Meu planner",
    description: "Organize sua execução a partir dos prazos da operação.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  processManagement: {
    label: "Processos", icon: Workflow, module: "processes", hiddenFor: ["guest"], ownHeader: true,
    eyebrow: "Gestão e modelagem", title: "Processos",
    description: "Desenhe, documente, versione e publique processos BPMN ligados às áreas, empresas e responsabilidades do grupo.",
  },
  processes: {
    /* "Fechamento", e não "Operação DP": a aba mora dentro do processo
       Operação DP, ao lado de "DP Operacional" — três nomes quase iguais na
       mesma faixa. O título da tela já dizia o que ela é. */
    label: "Fechamento", icon: ClipboardCheck, module: "processes",
    eyebrow: "Operação do DP", title: "Cockpit de fechamento",
    description: "Coordene competências, gates, aprovações e obrigações. A admissão digital permanece integralmente na Sólides.",
    primaryAction: { label: "Nova demanda", kind: "card" },
  },
  payrollLedger: {
    label: "Adiantamentos e Descontos", icon: HandCoins, module: "payrollLedger",
    hiddenFor: ["guest"], ownHeader: true,
    eyebrow: "Operação do DP", title: "Adiantamentos e Descontos",
    description: "Adiantamentos, empréstimos, multas, franquias e descontos do SESMT — com parcelas, saldos e conferência por competência. O produto organiza o desconto; quem calcula o salário continua sendo a folha.",
  },
  auxiliary: {
    label: "Módulos auxiliares", icon: Blocks, module: "auxiliary", hiddenFor: ["guest"],
    eyebrow: "Serviços da competência", title: "Módulos auxiliares",
    description: "Controle entradas, aprovações, saídas e fechamento de Benefícios, Psicologia e Prestadores PJ.",
  },
  agents: {
    label: "Agentes", icon: Bot, module: "agents", hiddenFor: ["guest", "observer"], ownHeader: true,
    eyebrow: "Central de agentes", title: "Agentes",
    description: "Estado, cadência, execução e histórico dos agentes que leem os sistemas de origem.",
  },
  triage: {
    label: "Triagem", icon: ShieldQuestion, module: "agents", hiddenFor: ["guest"], ownHeader: true,
    eyebrow: "Central de triagem", title: "O que o sistema não teve certeza",
    description: "Entradas que a automação não conseguiu classificar sozinha e aguardam decisão humana.",
  },
  portfolio: {
    label: "Carteira", icon: Briefcase, module: "portfolio", hiddenFor: ["guest"],
    eyebrow: "Operação do DP", title: "Carteira",
    description: "Quem responde por cada empresa: titular, backup, ausências da equipe e demandas sem responsável.",
  },
  dpOperations: {
    label: "DP Operacional", icon: CalendarCheck2, module: "dpOperations", hiddenFor: ["guest"],
    eyebrow: "Operação do DP", title: "DP Operacional",
    description: "Minha semana, calendário do mês, ocorrências fora do prazo de corte, alertas do Sankhya e o painel da gestão.",
  },
  registrations: {
    label: "Cadastros", icon: Users, module: "registrations", hiddenFor: ["guest"],
    eyebrow: "Base operacional", title: "Cadastros",
    description: "Administre empresas, colaboradores e estruturas auxiliares em um só lugar.",
  },
  timeTracking: {
    label: "Ponto", icon: Timer, module: "timeTracking", hiddenFor: ["guest"],
    eyebrow: "Conferência operacional", title: "Ponto",
    description: "Confira marcações, trate inconsistências e envie os eventos de hora para a folha com a rubrica configurada.",
  },
  epi: {
    label: "Controle de EPI", icon: HardHat, module: "epi", hiddenFor: ["guest"],
    eyebrow: "Segurança do trabalho", title: "Controle de EPI",
    description: "Cadastro, entrega, devolução, troca, descarte e análise de desconto de equipamentos de proteção.",
  },
  safety: {
    label: "Acidentes de Trabalho", icon: Siren, module: "safety", hiddenFor: ["guest"], ownHeader: true,
    eyebrow: "Segurança do trabalho", title: "Dashboard de Acidente de Trabalho",
    description: "Acidentes, dias afastados e despesas por período, tipo, parte do corpo, setor e turno.",
  },
  payroll: {
    label: "Folha", icon: WalletCards, module: "payroll",
    eyebrow: "Folha e indicadores", title: "Folha de pagamento",
    description: "Registre a competência e acompanhe custos, headcount e turnover automaticamente.",
  },
  psychologistPayments: {
    label: "Pagamento de Psicólogos", icon: Stethoscope,
    module: "psychologistPayments", hiddenFor: ["guest", "observer"], ownHeader: true,
    eyebrow: "Controle financeiro", title: "Pagamento de Psicólogos",
    description: "Apure as consultas válidas da competência e controle quanto pagar a cada psicólogo. O módulo é exclusivamente administrativo e financeiro.",
  },
  /* Os nove destinos do Pagamento PJ (§74). Escritos um a um pelo mesmo motivo
     que a união acima: quem confere que toda tela tem porta no menu lê este
     catálogo. O rótulo e a descrição vêm do catálogo do módulo — repetir a
     frase aqui seria criar a segunda cópia que diverge da primeira. Todos
     carregam a permissão do módulo inteiro: dividir a leitura não divide o
     acesso. */
  contractorPayments: { ...contractorEntry("contractorPayments") },
  contractorProviders: { ...contractorEntry("contractorProviders") },
  contractorCycles: { ...contractorEntry("contractorCycles") },
  contractorClosings: { ...contractorEntry("contractorClosings") },
  contractorInvoices: { ...contractorEntry("contractorInvoices") },
  contractorAdjustments: { ...contractorEntry("contractorAdjustments") },
  contractorLimits: { ...contractorEntry("contractorLimits") },
  contractorCaju: { ...contractorEntry("contractorCaju") },
  contractorArchive: { ...contractorEntry("contractorArchive") },
  indicators: {
    label: "Relatórios", icon: BarChart3, module: "indicators",
    eyebrow: "Relatórios", title: "Relatórios da operação",
    description: "Monitore SLAs, volume, produtividade e regras ativas do workspace.",
  },
  history: {
    label: "Histórico", icon: History,
    eyebrow: "Histórico da operação",
    title: "Tudo o que aconteceu",
    description: "A trilha completa de movimentações: quem fez, o quê, em qual demanda e quando.",
    ownHeader: true,
  },
  integrations: {
    label: "Estado das integrações", icon: Cable, module: "integrations", hiddenFor: ["guest"],
    eyebrow: "Infraestrutura operacional", title: "Estado das integrações",
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
      boardAccess: member.boardAccess !== false,
      employeeId: member.employeeId ?? null,
      employeeName: member.employeeName ?? "",
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
  return initialsOf(value, "DP");
}

function dueInputValue(value: string, defaultTime: string) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T${defaultTime}`;
  return value.slice(0, 16);
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

/** Prazo como número ordenável. Sem prazo vai para o fim, nunca para o topo. */
function dueValue(card: Card) {
  if (!card.dueAt) return Number.POSITIVE_INFINITY;
  const at = new Date(card.dueAt).getTime();
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/** Ordem de urgência, do mais para o menos. */
const priorityRank: Record<Card["priority"], number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A ficha entre os anexos da demanda — decide se a aba existe e para onde o botão aponta. */
function registrationFormAttachment(card: Card) {
  return chooseRegistrationFormAttachment(card.attachments);
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
    <div><span>Sólides</span><strong>{content.title}</strong><p>{content.description}</p></div>
    {showButton && canAuthorize && <button type="button" disabled={busy} onClick={onAuthorize}>
      {sync.state === "FAILED" ? "Autorizar novamente" : "Autorizar anexos da Sólides"}
    </button>}
  </section>;
}

function canPreviewAttachment(attachment: CardAttachment) {
  return attachment.contentType === "application/pdf" || attachment.contentType.startsWith("image/");
}

export function WorkspaceApp({
  user, signOutPath, initialLocation = defaultPanelLocation,
  initialThemePreference = "system", initialTheme = "light", initialViewTab = "",
  initialModuleLauncher = false,
}: {
  user: User;
  signOutPath: string;
  /**
   * Onde o endereço mandou abrir (§43).
   *
   * Vem resolvido do servidor, e não de um efeito depois da hidratação: com
   * efeito, quem abre o link de uma demanda vê a visão geral piscar antes dela.
   */
  initialLocation?: PanelLocation;
  /** A escolha guardada em cookie: claro, escuro ou o que o sistema disser. */
  initialThemePreference?: ThemePreference;
  /** A escala que o servidor já resolveu — pelo mesmo motivo de `initialLocation`. */
  initialTheme?: ResolvedTheme;
  /**
   * `?aba=` de uma visão com abas próprias (DP Operacional). O painel reescreve
   * o endereço ao montar, então a visão não pode lê-lo depois.
   */
  initialViewTab?: string;
  /** Abre a janela de módulos — é assim que o painel recebe quem acabou de
   *  entrar (`/painel?modulos=1`). */
  initialModuleLauncher?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  /* Janela de módulos. Na entrada depois do login ela é o primeiro passo e
     não fecha sem escolha; aberta pelo botão do topo, fecha e devolve à tela
     onde a pessoa estava. */
  const [moduleLauncher, setModuleLauncher] = useState<"entry" | "switch" | null>(initialModuleLauncher ? "entry" : null);
  const [view, setViewState] = useState<View>(initialLocation.view as View);
  const [contractorPaymentFocus, setContractorPaymentFocus] = useState<{
    companyId: string; competence: string; closingId: string;
  } | null>(null);
  /* O quadro abre por responsável. É a pergunta que o DP faz às oito da manhã
     — quem está com o quê, e o que não tem dono —, e abrir por etapa fazia
     essa resposta custar um clique todos os dias. */
  const [boardMode, setBoardMode] = useState<BoardMode>("team");
  /* Como o quadro é lido, e não o que ele mostra.
     Densidade, agrupamento e ordenação são preferências de leitura: não mudam
     o recorte (isso é filtro) nem o formato (isso é `boardMode`), mudam o
     arranjo. Ficam no navegador de quem escolheu, porque a escolha é de quem
     lê: numa equipe, um confere por empresa e outro por responsável, e gravar
     isso no servidor faria um impor o arranjo ao outro. */
  const [boardDensity, setBoardDensity] = useState<BoardDensity>("comfortable");
  const [boardGroupBy, setBoardGroupBy] = useState<BoardGroupBy>("none");
  const [boardSort, setBoardSort] = useState<BoardSort>("position");
  const boardPreferencesLoaded = useRef(false);
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
  /* "Desfazer" do aviso: mover e atribuir são as ações mais repetidas do
     quadro, e um arrasto errado não deveria custar reabrir a demanda. */
  const [undo, setUndo] = useState<{ message: string; run: () => void } | null>(null);
  /* Só vale para o aviso de que ele nasceu: outro aviso logo depois não herda o botão. */
  const undoAtual = undo && undo.message === toast ? undo : null;
  const [cardModalOpen, setCardModalOpen] = useState(false);
  /* Os processos publicados que podem originar uma demanda (§10).
     Carregados quando a modal de criação abre, e não no snapshot de abertura:
     o catálogo cresce com a operação e quase toda visita ao painel não abre
     esta modal — é o mesmo motivo pelo qual o histórico carrega sob demanda. */
  const [startableProcesses, setStartableProcesses] = useState<StartableProcess[] | null>(null);
  const [employeeStartOptions, setEmployeeStartOptions] = useState<EmployeeStartOption[] | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [cardForm, setCardForm] = useState<CardForm>(emptyCardForm);
  /* Rascunho da demanda nova (sessão do navegador). Fechar a gaveta por
     engano — Esc, clique fora, troca de tela — apagava tudo o que foi digitado. */
  const [draftRestored, setDraftRestored] = useState(false);
  const draftKey = snapshot ? `vinculato:rascunho-demanda:${snapshot.workspace.id}:${snapshot.board.id}` : "";
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [newComment, setNewComment] = useState("");
  const [commentAttachment, setCommentAttachment] = useState<File | null>(null);
  const [inboxModalOpen, setInboxModalOpen] = useState(false);
  /* A Administração está aberta. Deixou de ser `workspaceModalOpen` porque
     deixou de ser janela: hoje ela substitui o conteúdo da área principal, e o
     nome do estado precisa dizer isso para o próximo que ler. */
  const [administrationOpen, setAdministrationOpen] = useState(Boolean(initialLocation.settings));

  /* Trocar de tela fecha a Administração.
     Ela ocupa a área principal, a mesma das outras telas — sem isto, clicar em
     "Demandas" com a Administração aberta continuaria mostrando a
     Administração, porque a condição de renderização vence a do `view`.
     Envolver o `setView` resolve nos trinta e poucos lugares que o chamam, em
     vez de exigir que cada um lembre de fechar. */
  const setView = useCallback((next: View) => {
    setAdministrationOpen(false);
    setViewState(next);
    /* Sair do quadro desfaz a seleção. Voltar meia hora depois e encontrar doze
       demandas ainda marcadas é o caminho mais curto para uma ação em massa
       aplicada no conjunto errado. */
    setBoardSelection((atual) => (atual.size === 0 ? atual : new Set()));
  }, []);
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
  /* Os três recortes que faltavam para o quadro responder sozinho: a etapa
     ("situação"), a prioridade e a competência. Eram filtráveis só de cabeça —
     quem queria "as admissões urgentes da competência que fecha sexta"
     percorria o quadro com o olho. */
  const [listFilter, setListFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [competenceFilter, setCompetenceFilter] = useState("");
  /* Etiqueta e "parada há": os dois recortes que o Trello tem e o quadro não
     tinha (§10 de docs/engenharia-reversa-trello.md). */
  const [labelFilter, setLabelFilter] = useState("all");
  const [staleFilter, setStaleFilter] = useState("all");
  /* Seleção em massa, modo foco e visualizações salvas.
     A seleção mora aqui, e não dentro do quadro, porque a barra de ações que
     ela liga é irmã do quadro e não filha dele — e porque trocar de eixo
     (equipe → situação) não pode perder o que já estava selecionado. */
  const [boardSelection, setBoardSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [focusMode, setFocusMode] = useState(false);
  const [savedViews, setSavedViews] = useState<readonly SavedBoardView[]>([]);
  /* O relógio do quadro. "Vence em 40 minutos" e "SLA crítico" são leituras
     contra o instante atual; sem atualizar, o quadro aberto desde as oito da
     manhã continua dizendo o que era verdade às oito. Um minuto é a menor
     unidade que a tela exibe, então é a cadência certa — e não há nenhuma
     chamada de rede envolvida. */
  const [boardNow, setBoardNow] = useState(() => new Date());
  /**
   * Busca dentro do quadro, separada da busca global (⌘K).
   *
   * As duas respondem a perguntas diferentes e por isso convivem. A global
   * procura em todo o workspace e *abre* o que achou — demanda, empresa,
   * colaborador, prestador — mesmo que esteja arquivado ou em outro módulo. Esta
   * aqui não abre nada: ela encolhe o quadro que já está na tela, mantendo as
   * colunas e o resto dos filtros. Quem está no meio do dia procurando "Maria"
   * entre trinta cartões quer a segunda, e estava sendo obrigado a usar a
   * primeira, que tira a pessoa da tela para devolver um resultado só.
   */
  const [boardQuery, setBoardQuery] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  /* Usuários e acessos: busca, filtros e os dois painéis laterais (editar e
     criar). A lista vira tabela; cada linha abre o próprio painel. */
  const [memberQuery, setMemberQuery] = useState("");
  const [memberRoleFilter, setMemberRoleFilter] = useState<WorkspaceRole | "">("");
  const [memberStatusFilter, setMemberStatusFilter] = useState<"" | "active" | "pending" | "no-department">("");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
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
  const realtimeCursorRef = useRef("");

  /**
   * Tema (§7).
   *
   * Duas escalas, e a escolha é de quem usa. A clara é a da maquete aprovada; a
   * escura sempre esteve declarada em `dashboard-modern.css` e volta a ser
   * alcançável. "Sistema" segue `prefers-color-scheme`.
   *
   * Os dois estados chegam prontos do servidor, lidos de cookie, e é por isso
   * que não há lampejo: a classe já vai no HTML da primeira resposta. O efeito
   * abaixo cuida só do que o servidor não tem como saber.
   */
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialThemePreference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(initialTheme);
  const theme: ResolvedTheme = themePreference === "system" ? systemTheme : themePreference;
  /* Densidade (lib/density.ts): o "cozy/compact" do Fiori. Lida depois da
     montagem, como o modo, para o HTML do servidor e o do navegador baterem. */
  const [density, setDensity] = useState<Density>("comfortable");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try { setDensity(parseDensity(window.localStorage.getItem(DENSITY_KEY))); } catch { /* conveniência */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const escolherDensidade = useCallback((escolha: Density) => {
    setDensity(escolha);
    try { window.localStorage.setItem(DENSITY_KEY, escolha); } catch { /* vale para esta sessão */ }
  }, []);

  /* Modo ERP DP (docs/engenharia-reversa-sap-hcm.md): o mesmo Vinculato lido
     com a gramática do SAP HCM. A escolha é de cada pessoa neste navegador —
     conveniência, não dado: se o armazenamento falhar, o painel abre no modo
     Vinculato, que é o padrão. Lido depois da montagem para o HTML do
     servidor e o do navegador coincidirem. */
  /* O Sistema PJ ("pj") é o mesmo painel recortado ao Pagamento PJ: o menu
     mostra só os destinos do módulo, organizados pela etapa do mês. Para quem
     só tem o PJ ele não é escolha — ver `contractorOnly`. */
  const [appMode, setAppMode] = useState<"vinculato" | "erp" | "pj">("vinculato");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const stored = window.localStorage.getItem(APP_MODE_KEY);
        if (stored === "erp" || stored === "pj") setAppMode(stored);
      } catch { /* sem armazenamento: fica o padrão */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const changeAppMode = useCallback((next: "vinculato" | "erp" | "pj") => {
    setAppMode(next);
    try { window.localStorage.setItem(APP_MODE_KEY, next); } catch { /* conveniência; o modo vale para esta sessão */ }
  }, []);

  /* Quem está olhando, pelo nome com que as demandas o registram. Fica aqui em
     cima porque o recorte do quadro já depende dele: "minha fila" é um filtro
     por esse nome. */
  const currentMemberName = snapshot?.members.find((member) => member.email.toLowerCase() === user.email.toLowerCase())?.name ?? user.displayName;

  /**
   * O recorte do quadro, inteiro, em um objeto (§47).
   *
   * Os nove campos continuam morando em `useState` separados porque metade
   * deles é lida por outras telas — a Visão geral usa a empresa, os Indicadores
   * usam o período. O que muda é que o quadro passa a enxergá-los como uma
   * coisa só: é isso que permite escrever o recorte na URL, salvá-lo em "Meus
   * filtros" e limpá-lo sem esquecer um campo pelo caminho, que era o defeito
   * de `Limpar` antes — ele zerava cinco dos sete filtros existentes.
   */
  const boardFilters = useMemo<DemandFilters>(() => ({
    query: boardQuery,
    companyId: companyFilter,
    processType: processFilter,
    listId: listFilter,
    assignee: assigneeFilter,
    priority: priorityFilter,
    due: dueFilter,
    sla: slaFilter,
    competence: competenceFilter,
    label: labelFilter,
    stale: staleFilter,
  }), [assigneeFilter, boardQuery, companyFilter, competenceFilter, dueFilter, labelFilter, listFilter, priorityFilter, processFilter, slaFilter, staleFilter]);

  const applyBoardFilters = useCallback((next: DemandFilters) => {
    setBoardQuery(next.query);
    setCompanyFilter(next.companyId);
    setProcessFilter(next.processType);
    setListFilter(next.listId);
    setAssigneeFilter(next.assignee);
    setPriorityFilter(next.priority);
    setDueFilter(next.due);
    setSlaFilter(next.sla);
    setCompetenceFilter(next.competence);
    setLabelFilter(next.label);
    setStaleFilter(next.stale);
  }, []);

  /* O que o recorte sozinho não sabe: o nome das áreas (a busca procura
     "Departamento Pessoal", não o id), quais colunas significam "aguardando
     terceiros" e quem está olhando. */
  const boardContext = useMemo<BoardContext>(() => ({
    areaNames: new Map((snapshot?.areas ?? []).map((area) => [area.id, area.name])),
    waitingListIds: new Set((snapshot?.lists ?? []).filter((list) => list.slaBehavior === "paused").map((list) => list.id)),
    currentMemberName,
  }), [snapshot?.areas, snapshot?.lists, currentMemberName]);

  /* O que o navegador responde de `prefers-color-scheme`, e o que ele responde
     quando a pessoa muda no sistema operacional com o painel aberto.

     O valor é gravado em cookie mesmo quando a preferência não é "sistema":
     ele não decide nada agora, mas é o que permite ao servidor acertar de
     saída se a pessoa voltar a escolher "sistema" depois. */
  useEffect(() => {
    const consulta = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!consulta) return;
    const aplicar = (escuro: boolean) => {
      const resolvido: ResolvedTheme = escuro ? "dark" : "light";
      setSystemTheme(resolvido);
      document.cookie = `${THEME_SYSTEM_COOKIE}=${resolvido}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
    };
    aplicar(consulta.matches);
    const ouvir = (evento: MediaQueryListEvent) => aplicar(evento.matches);
    consulta.addEventListener("change", ouvir);
    return () => consulta.removeEventListener("change", ouvir);
  }, []);

  /* `color-scheme` é o que o CSS não resolve: sem ele, o que o navegador
     desenha sozinho — a lista aberta de um `select`, a barra de rolagem, o
     seletor de data — fica no tema errado dentro da tela. É o tipo de detalhe
     que ninguém sabe nomear e todo mundo nota. */
  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  /* A escolha vai para cookie, não para `localStorage`, porque é o servidor
     quem precisa dela na próxima resposta. */
  const escolherTema = useCallback((escolha: ThemePreference) => {
    setThemePreference(escolha);
    document.cookie = `${THEME_COOKIE}=${escolha}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
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

  /* As três preferências de leitura do quadro, num registro só.
     Uma chave por preferência daria três leituras e três gravações para um
     estado que sempre muda junto; e um valor gravado que o código não reconheça
     mais (uma opção removida) precisa ser descartado, não aplicado. */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const bruto = window.localStorage.getItem("vinculato-quadro-leitura");
        if (bruto) {
          const guardado = JSON.parse(bruto) as Partial<Record<string, string>>;
          if (guardado.density === "compact" || guardado.density === "comfortable") setBoardDensity(guardado.density);
          if (guardado.groupBy === "company" || guardado.groupBy === "assignee" || guardado.groupBy === "none") setBoardGroupBy(guardado.groupBy);
          if (guardado.sort === "due" || guardado.sort === "priority" || guardado.sort === "position") setBoardSort(guardado.sort);
        }
      } catch {
        /* JSON corrompido no navegador de alguém não pode derrubar o painel:
           a preferência volta ao padrão e o quadro abre. */
      }
      boardPreferencesLoaded.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!boardPreferencesLoaded.current) return;
    window.localStorage.setItem("vinculato-quadro-leitura",
      JSON.stringify({ density: boardDensity, groupBy: boardGroupBy, sort: boardSort }));
  }, [boardDensity, boardGroupBy, boardSort]);

  /**
   * O que o endereço pediu do quadro, aplicado uma vez na abertura (§47).
   *
   * O caminho (`/painel/demandas/…`) já vinha resolvido do servidor; a consulta
   * (`?situacao=atrasada&empresa=4`) não vinha, e não pode vir: ela depende de
   * estado que só existe depois da hidratação. Aplicar num quadro adiado evita
   * o piscar do quadro sem recorte, e o `ref` garante que isto aconteça só na
   * abertura — reaplicar a cada render desfaria todo filtro que a pessoa
   * mexesse.
   */
  const boardLocationApplied = useRef(false);
  /* A consulta como chegou, guardada antes de qualquer efeito. O efeito que
     sincroniza o endereço (mais abaixo) roda no mesmo ciclo e reescreve a URL
     com o recorte ainda vazio; lida dentro do quadro adiado, a consulta já
     tinha sumido, e todo link com filtro ou `?modo=` abria o quadro inteiro. */
  const [initialBoardSearch] = useState(() => (typeof window === "undefined" ? "" : window.location.search));
  useEffect(() => {
    if (boardLocationApplied.current) return;
    const frame = window.requestAnimationFrame(() => {
      /* Marcado só quando aplica: no modo estrito do React o efeito roda,
         é desfeito e roda de novo, e marcar antes cancelaria a única vez. */
      boardLocationApplied.current = true;
      const busca = initialBoardSearch;
      if (!busca) return;
      applyBoardFilters(readBoardFilters(busca));
      const modo = new URLSearchParams(busca).get("modo");
      if (boardViewModes.includes(modo as BoardMode)) setBoardMode(modo as BoardMode);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [applyBoardFilters, initialBoardSearch]);

  /**
   * "Meus filtros": as visualizações que a pessoa salvou.
   *
   * Ficam no navegador, e por grupo. É a mesma decisão da densidade e da
   * ordenação logo acima: o recorte salvo é de quem lê, não do grupo. Numa
   * equipe de seis, quatro salvariam "minha fila" e a lista viraria seis
   * versões do mesmo recorte para todo mundo.
   */
  useEffect(() => {
    const workspaceId = snapshot?.workspace.id;
    if (!workspaceId) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        setSavedViews(parseSavedViews(window.localStorage.getItem(`vinculato-quadro-recortes:${workspaceId}`)));
      } catch {
        /* Armazenamento bloqueado (janela anônima, política corporativa) não
           pode impedir o quadro de abrir: sem visualização salva, tudo o mais
           continua funcionando. */
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot?.workspace.id]);

  /* O relógio do quadro. "Vence em 40 minutos" e "SLA crítico" são leituras
     contra o instante atual, e um quadro aberto desde as oito da manhã
     continuaria dizendo o que era verdade às oito. Um minuto é a menor unidade
     que a tela exibe, e nada aqui vai à rede. */
  useEffect(() => {
    if (view !== "board") return;
    const timer = window.setInterval(() => setBoardNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [view]);

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
  const currentPath = useMemo(() => {
    const base = panelPath({
      view: view as PanelView,
      recordId: cardModalOpen && selectedCardId ? selectedCardId : "",
      settings: administrationOpen ? settingsSection as PanelSettingsSection : null,
      companyId: companyFilter === "all" ? "" : companyFilter,
    });
    /* O recorte do quadro também é endereço (§47).
       "Manda o link dessas atrasadas da Horizonte" é a segunda frase mais dita
       do dia, depois de "manda o link dessa demanda" — e até aqui o link
       mandava para o quadro inteiro, com o recorte desfeito. Só o quadro
       escreve esses parâmetros: pendurá-los em Ponto ou EPI seria prometer um
       recorte que aquelas telas não aplicam. */
    if (view !== "board") return base;
    const [caminho, consulta = ""] = base.split("?");
    const parametros = writeBoardFilters(boardFilters, new URLSearchParams(consulta));
    if (boardMode !== "team") parametros.set("modo", boardMode); else parametros.delete("modo");
    const query = parametros.toString();
    return query ? `${caminho}?${query}` : caminho;
  }, [view, cardModalOpen, selectedCardId, administrationOpen, settingsSection, companyFilter, boardFilters, boardMode]);

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
      /* Voltar precisa desfazer o recorte junto com a tela. Sem isto, o botão
         voltar levava de "atrasadas da Horizonte" para "atrasadas da
         Horizonte" — mudava o endereço e não mudava nada na tela. */
      if (next.view === "board") {
        applyBoardFilters(readBoardFilters(window.location.search));
        const modo = new URLSearchParams(window.location.search).get("modo");
        setBoardMode(boardViewModes.includes(modo as BoardMode) ? modo as BoardMode : "team");
      }
      setAdministrationOpen(Boolean(next.settings));
      if (next.settings) setSettingsSection(next.settings as SettingsSection);
      if (!next.recordId) {
        setCardModalOpen(false);
        setSelectedCardId(null);
      }
    }
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
    /* `setView` é estável (`useCallback` com lista vazia) e o efeito precisa
       assinar o `popstate` uma vez só: incluí-lo na lista não muda quando ele
       roda, mas reassinar o ouvinte a cada render é trabalho por nada. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /* O primeiro Tab da página começa no "Pular para o conteúdo".
     Medido no Chrome: a tela "Preparando sua operação…" e partes da faixa do
     topo são trocadas depois da carga, e o navegador guarda a posição do nó
     removido como ponto de partida do Tab — o primeiro Tab caía na aba do
     módulo, pulando o atalho. Com nada focado (foco no `<body>`), o Tab vai
     direto para o atalho; depois disso a ordem é a natural. */
  useEffect(() => {
    if (loading) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.shiftKey || event.defaultPrevented) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      const skip = document.querySelector<HTMLAnchorElement>(".skip-link");
      if (!skip) return;
      event.preventDefault();
      skip.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loading]);

  // Guarda o rascunho enquanto a demanda nova está sendo escrita.
  useEffect(() => {
    if (!cardModalOpen || selectedCardId || !draftKey) return;
    const temConteudo = Boolean(cardForm.title.trim() || cardForm.description.trim() || cardForm.nextStep.trim());
    try {
      if (temConteudo) window.sessionStorage.setItem(draftKey, JSON.stringify(cardForm));
    } catch { /* navegador sem armazenamento: o formulário segue funcionando */ }
  }, [cardForm, cardModalOpen, selectedCardId, draftKey]);

  useEffect(() => {
    if (!toast) return;
    // Com "Desfazer", o aviso fica o dobro do tempo: dá para ler e decidir.
    const timeout = window.setTimeout(() => setToast(""), undoAtual ? 7000 : 3500);
    return () => window.clearTimeout(timeout);
  }, [toast, undoAtual]);

  useEffect(() => {
    if (!cardModalOpen && !inboxModalOpen && !searchOpen && !notificationsOpen && !archiveOpen && !confirmation && !attachmentPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCardModalOpen(false);
        setInboxModalOpen(false);
        setAdministrationOpen(false);
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
  }, [cardModalOpen, inboxModalOpen, searchOpen, notificationsOpen, archiveOpen, confirmation, attachmentPreview]);

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
  /* O ciclo da competência saiu da Visão geral com o bloco que o mostrava: a
     maquete refez a tela com quatro blocos, e nenhum deles é a competência. Ela
     continua em Operação DP, onde é recortada pelo seletor de empresa próprio
     daquela tela — o recorte não se perdeu, mudou de controle. */

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
  /* O snapshot traz só as arquivadas mais recentes; o total vem à parte. */
  const archivedTotal = snapshot?.history?.archived?.total ?? snapshot?.archivedCards.length ?? 0;
  const filteredActiveCards = useMemo(
    () => filterDemands(activeCards, boardFilters, boardContext, boardNow),
    [activeCards, boardFilters, boardContext, boardNow],
  );

  /**
   * A base dos indicadores: a empresa escolhida, e nada além disso.
   *
   * Contar sobre `filteredActiveCards` faria o número desaparecer no instante
   * em que ele fosse usado — clicar em "atrasadas" recortaria o quadro, e o
   * indicador passaria a dizer que só há atrasadas. Contar sobre tudo ignoraria
   * o seletor de empresa, que é a primeira coisa que um grupo com oito
   * empresas ajusta pela manhã. A empresa recorta; os demais filtros, não.
   */
  const boardBaseCards = useMemo(
    () => activeCards.filter((card) => companyFilter === "all" || card.companyId === companyFilter),
    [activeCards, companyFilter],
  );
  const boardIndicators = useMemo(() => demandIndicators(boardBaseCards, boardNow), [boardBaseCards, boardNow]);
  const boardAlerts = useMemo(() => operationalAlerts(boardBaseCards, boardNow), [boardBaseCards, boardNow]);
  /* As competências que existem no quadro. O campo é uma escolha, e não um
     texto livre, porque competência inventada não casa com demanda nenhuma e o
     resultado vazio parece defeito. */
  const boardCompetences = useMemo(
    () => Array.from(new Set(activeCards.map((card) => card.competence).filter(Boolean))).sort().reverse(),
    [activeCards],
  );
  /**
   * Quanto cada pessoa já carrega — a informação que falta na hora de atribuir.
   *
   * Sai do mesmo cálculo que desenha as colunas do quadro, e não de uma segunda
   * contagem: dois números para a mesma pergunta divergem no dia em que um dos
   * dois deixar de considerar as concluídas, e aí a gaveta e o quadro passam a
   * discordar sobre quem está sobrecarregado.
   */
  const assigneeLoad = useMemo(
    () => new Map(responsibleColumns(activeCards, snapshot?.members ?? [])
      .map((column) => [column.key, { open: column.open, overdue: column.overdue }])),
    [activeCards, snapshot?.members],
  );

  const stageNames = useMemo(
    () => new Map((snapshot?.lists ?? []).map((list) => [list.id, list.name])),
    [snapshot?.lists],
  );

  /* O quadro montado: raias, e dentro delas as colunas já ordenadas.
     Montar isto uma vez aqui, e não dentro do JSX, tem uma razão prática: sem
     agrupamento são N colunas filtrando a mesma lista N vezes; com agrupamento
     seriam N×M. O custo passa a ser uma varredura só, e o JSX fica lendo dados
     em vez de calculá-los.
     Quando não há agrupamento existe uma raia só, sem rótulo — assim o desenho
     tem um caminho só, e não dois que precisam concordar entre si. */
  const boardLanes = useMemo(() => {
    const listas = snapshot?.lists ?? [];
    const ordenar = (cards: Card[]) => {
      if (boardSort === "position") return cards;
      const copia = [...cards];
      /* Desempate por prazo nos dois modos: duas demandas da mesma prioridade
         não têm ordem definida entre si, e sem critério estável elas trocam de
         lugar a cada atualização do snapshot. */
      if (boardSort === "priority") copia.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || dueValue(a) - dueValue(b));
      else copia.sort((a, b) => dueValue(a) - dueValue(b));
      return copia;
    };
    const porColuna = (cards: Card[]) => new Map(listas.map((list) =>
      [list.id, ordenar(cards.filter((card) => card.listId === list.id))]));

    if (boardGroupBy === "none") {
      return [{ key: "todas", label: "", total: filteredActiveCards.length, cardsByList: porColuna(filteredActiveCards) }];
    }
    const rotulo = (card: Card) => boardGroupBy === "company"
      ? (card.company || "Sem empresa")
      : (card.assignees[0]?.name || card.assigneeName || "Sem responsável");
    const grupos = new Map<string, Card[]>();
    for (const card of filteredActiveCards) {
      const chave = rotulo(card);
      const atual = grupos.get(chave);
      if (atual) atual.push(card); else grupos.set(chave, [card]);
    }
    return [...grupos.entries()]
      /* "Sem empresa" e "Sem responsável" por último: eles são a ausência do
         critério de agrupamento, e ordená-los pelo "S" os jogaria no meio da
         lista como se fossem mais um grupo. */
      .sort(([a], [b]) => {
        const aSem = a.startsWith("Sem "), bSem = b.startsWith("Sem ");
        if (aSem !== bSem) return aSem ? 1 : -1;
        return a.localeCompare(b, "pt-BR");
      })
      .map(([label, cards]) => ({ key: label, label, total: cards.length, cardsByList: porColuna(cards) }));
  }, [boardGroupBy, boardSort, filteredActiveCards, snapshot?.lists]);
  const selectedCard = useMemo(() => allCards.find((card) => card.id === selectedCardId) ?? null, [allCards, selectedCardId]);
  const processTypes = useMemo(() => Array.from(new Set(activeCards.map((card) => card.processType).filter(Boolean))).sort(), [activeCards]);
  /** O valor do campo: o que está sendo digitado, ou o nome vigente do grupo. */
  const workspaceName = workspaceNameEdit ?? snapshot?.workspace.name ?? "";
  const userInitials = initials(user.displayName);
  const canEdit = snapshot ? ["admin", "member"].includes(snapshot.workspace.role) : false;
  /* Ler a ficha transcrita não vem junto de ver os anexos: a aba só aparece
     para quem tem a permissão própria, e o servidor cobra a mesma coisa. */
  const canReadAdmissionSheet = snapshot
    ? capabilitiesForRole(snapshot.workspace.role).includes("admission.sheet.read")
    : false;
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
  /* O ERP DP é módulo em construção (migration 0121): abre para o
     administrador e para quem ele liberar nominalmente, e para mais ninguém.
     Antes bastava ler cadastro, e não havia como tirar o acesso de alguém. */
  const canUseErp = snapshot
    ? (enabledModules.size ? enabledModules.has("erpDp") : hasCapability(snapshot.workspace.role, "erp.access"))
    : false;

  /**
   * Quantos recortes estão ligados.
   *
   * Conta pela mesma definição que o quadro aplica, e não por uma lista escrita
   * à mão: a versão anterior enumerava cinco dos filtros e por isso ignorava os
   * que chegaram depois — o número dizia "2" com quatro recortes ligados, e o
   * estado vazio do quadro continuava dizendo "não há demandas" quando o certo
   * era "o recorte esconde".
   */
  const activeBoardFilters = useMemo(() => activeFilterCount(boardFilters), [boardFilters]);

  // Quais telas esta pessoa vê, uma vez só. Antes a mesma pergunta estava
  // escrita em treze botões — `hasModule("x") && role !== "guest" &&` — e as
  // sete cópias da regra de papel eram sete chances de divergirem.
  const role = snapshot?.workspace.role;
  const visibleViews = useMemo(() => navOrder.filter((id) => {
    const entry = viewCatalog[id];
    if (entry.module && !hasModule(entry.module)) return false;
    return !(role && entry.hiddenFor?.includes(role));
  }), [hasModule, role]);

  /* Sistema PJ. Quem só opera o Pagamento PJ entra direto nele, sem a
     operação do DP em volta; quem tem outros módulos alterna pelo botão do
     topo, como faz com o ERP DP. Os dois modos não se sobrepõem. */
  const hasContractorModule = visibleViews.includes("contractorPayments");
  const contractorOnly = useMemo(
    () => isContractorOnly(visibleViews.filter((id) => viewCatalog[id].module)),
    [visibleViews],
  );
  const pjMode = hasContractorModule && (contractorOnly || appMode === "pj");
  const erpMode = appMode === "erp" && canUseErp && !contractorOnly;
  /* No Sistema PJ toda tela é do PJ. Ajustado durante a renderização, e não
     num efeito, para a tela de fora nunca chegar a piscar. */
  if (pjMode && !isContractorSection(view)) setViewState("contractorPayments");

  const navBadges = useMemo<Partial<Record<View, number>>>(() => ({
    inbox: snapshot?.inbox.filter((item) => item.status === "new").length || undefined,
  }), [snapshot]);

  /* Os processos que esta pessoa alcança, e em qual deles ela está.
     `visibleProcessGroups` recebe o recorte já pronto — plano e papel — e é o
     único caminho para o menu, para a subnavegação e para os cartões da home.
     Um processo cujas telas estejam todas fora do alcance não aparece em lugar
     nenhum, que é o que a §30 exige. */
  const navGroups = useMemo(() => visibleProcessGroups(visibleViews), [visibleViews]);

  /* Os cartões da janela de módulos: os mesmos processos do menu, já
     recortados por plano e papel, mais o ERP DP para quem lê cadastro. O
     Pagamento PJ abre o Sistema PJ; os demais abrem o Vinculato na primeira
     tela do processo. */
  const launcherModules = useMemo<LauncherModule[]>(() => {
    /* O número vivo de cada tile (§7.2 da engenharia reversa Centi/SAP) sai do
       snapshot que o painel já carregou: nenhuma ida a mais ao banco só para
       desenhar a janela. Módulo sem número honesto fica sem número. */
    const plural = (count: number, one: string, other: string) => (count === 1 ? one : other);
    const openDemands = (snapshot?.lists ?? [])
      .filter((list) => list.slaBehavior !== "completed")
      .reduce((total, list) => total + list.cards.length, 0);
    const openCycles = (snapshot?.payrollCycles ?? []).filter((cycle) => cycle.status !== "closed").length;
    const overdueObligations = (snapshot?.upcomingObligations ?? []).filter((item) => item.daysRemaining < 0).length;
    const metrics: Partial<Record<string, LauncherModule["metric"]>> = {
      demandas: { value: openDemands, label: plural(openDemands, "demanda aberta", "demandas abertas") },
      pagamentos: { value: openCycles, label: plural(openCycles, "competência em andamento", "competências em andamento") },
    };
    const modules: LauncherModule[] = navGroups.map((group) => ({
      id: group.id, label: group.label, description: group.description,
      icon: viewCatalog[group.views[0] as View].icon,
      section: group.kind,
      metric: metrics[group.id],
    }));
    if (canUseErp && !contractorOnly) {
      modules.push({
        id: "erp-dp", label: "ERP DP", icon: Building2, section: "system",
        description: "Cadastro, movimentações, folha, férias e obrigações na gramática do ERP de departamento pessoal.",
        metric: { value: overdueObligations, label: plural(overdueObligations, "obrigação vencida", "obrigações vencidas"), tone: "attention" },
      });
    }
    /* A Administração é porta da navegação, não só item do menu da conta:
       quem procura configurar o grupo procura entre os módulos (§46). */
    if (isAdmin) {
      modules.push({
        id: "admin", label: "Administração", icon: Settings, section: "support",
        description: "Empresas, usuários e acessos, colunas, campos, modelos, SLA e automações do grupo.",
      });
    }
    return modules;
  }, [navGroups, canUseErp, contractorOnly, snapshot, isAdmin]);
  const openLauncherModule = useCallback((id: string) => {
    setModuleLauncher(null);
    if (id === "admin") {
      setSettingsSection("general");
      openWorkspaceSettings();
      return;
    }
    if (id === "erp-dp") {
      changeAppMode("erp");
      return;
    }
    const group = navGroups.find((entry) => entry.id === id);
    if (!group) return;
    changeAppMode(id === "pagamento-pj" ? "pj" : "vinculato");
    setView(group.views[0] as View);
  }, [changeAppMode, navGroups, setView]);
  const activeGroup = useMemo(
    () => navGroups.find((group) => group.views.includes(view)) ?? null,
    [navGroups, view],
  );

  /* Abas de módulos (sistematização de janelas).
     Cada módulo aberto vira uma aba no topo, como num ERP de mesa. A aba guarda
     a última tela do módulo, e a tela continua montada enquanto a aba existir:
     trocar de aba não perde filtro, rolagem nem o que estava preenchido. O
     teto existe porque cada aba aberta é uma tela viva consumindo memória. */
  /* A aba do sistema operacional que está por trás da Administração. A
     Administração não é aba: é uma área à parte, com faixa própria, e "Voltar
     ao sistema" devolve a pessoa exatamente aqui. */
  const operationalTabId = erpMode ? "erp-dp"
    : pjMode ? "pagamento-pj"
    : view === "overview" ? "inicio"
    : activeGroup?.id ?? "inicio";
  const activeTabId = administrationOpen ? "admin" : operationalTabId;
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [tabViews, setTabViews] = useState<Record<string, View>>({});
  /* Ajustes feitos durante a renderização, e não em efeito, pelo mesmo motivo
     do modo PJ acima: a aba nova aparece no mesmo quadro em que a tela abre. */
  const [tabsLoadedFor, setTabsLoadedFor] = useState<string | null>(null);
  if (snapshot && tabsLoadedFor !== snapshot.workspace.id) {
    setTabsLoadedFor(snapshot.workspace.id);
    let stored: { tabs?: unknown; views?: unknown } | null = null;
    try { stored = JSON.parse(window.localStorage.getItem(`${SHELL_TABS_KEY}:${snapshot.workspace.id}`) ?? "null"); } catch { /* sem armazenamento */ }
    setOpenTabs(Array.isArray(stored?.tabs) ? stored.tabs.filter((id): id is string => typeof id === "string" && id !== "admin").slice(0, MAX_SHELL_TABS) : []);
    setTabViews(stored?.views && typeof stored.views === "object" ? stored.views as Record<string, View> : {});
  }
  if (tabsLoadedFor && activeTabId !== "admin" && !openTabs.includes(activeTabId)) {
    const next = [...openTabs, activeTabId];
    setOpenTabs(next.length > MAX_SHELL_TABS ? next.slice(next.length - MAX_SHELL_TABS) : next);
  }
  if (activeTabId !== "admin" && activeTabId !== "erp-dp" && tabViews[activeTabId] !== view) {
    setTabViews({ ...tabViews, [activeTabId]: view });
  }
  useEffect(() => {
    if (!snapshot || tabsLoadedFor !== snapshot.workspace.id) return;
    try {
      window.localStorage.setItem(`${SHELL_TABS_KEY}:${snapshot.workspace.id}`, JSON.stringify({ tabs: openTabs, views: tabViews }));
    } catch { /* conveniência por navegador */ }
  }, [openTabs, tabViews, snapshot, tabsLoadedFor]);
  /* Telas vivas: a atual e a última de cada aba aberta. */
  const aliveViews = useMemo(() => {
    const alive = new Set<View>([view]);
    for (const id of openTabs) {
      const remembered = tabViews[id];
      if (remembered && id !== "pagamento-pj") alive.add(remembered);
    }
    return alive;
  }, [view, openTabs, tabViews]);
  const [erpOpened, setErpOpened] = useState(false);
  if (erpMode && !erpOpened) setErpOpened(true);
  const erpAlive = erpMode || (erpOpened && openTabs.includes("erp-dp"));
  const tabLabel = (id: string) => id === "inicio" ? "Início"
    : id === "admin" ? "Administração"
    : id === "erp-dp" ? "ERP DP"
    : navGroups.find((group) => group.id === id)?.label ?? id;
  const openShellTab = (id: string) => {
    if (id === "admin") { openWorkspaceSettings(); return; }
    if (id === "erp-dp") { setAdministrationOpen(false); changeAppMode("erp"); return; }
    if (id === "inicio") { changeAppMode("vinculato"); setView("overview"); return; }
    const group = navGroups.find((entry) => entry.id === id);
    if (!group) return;
    changeAppMode(id === "pagamento-pj" ? "pj" : "vinculato");
    const remembered = tabViews[id];
    setView(remembered && group.views.includes(remembered) ? remembered : group.views[0] as View);
  };
  const closeShellTab = (id: string) => {
    const remaining = openTabs.filter((tab) => tab !== id);
    setOpenTabs(remaining);
    setTabViews((current) => { const next = { ...current }; delete next[id]; return next; });
    if (id !== activeTabId) return;
    /* Fechar a aba em que se está leva à vizinha; sem nenhuma, à janela de módulos. */
    const index = openTabs.indexOf(id);
    const neighbor = remaining[Math.min(index, remaining.length - 1)];
    if (neighbor) openShellTab(neighbor);
    else { openShellTab("inicio"); setModuleLauncher("switch"); }
  };
  /* A aba ativa sempre à vista: com várias abertas, a recém-aberta nascia
     escondida atrás do seletor de empresa. */
  useEffect(() => {
    document.querySelector(".shell-tab[data-active]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, openTabs.length]);
  const keepAlive = (target: View, node: ReactNode) => aliveViews.has(target)
    ? <div className="view-pane view-transition" hidden={target !== view}>
      <ViewPaneActiveContext.Provider value={target === view && !erpMode}>{node}</ViewPaneActiveContext.Provider>
    </div>
    : null;

  const stats = useMemo(() => {
    const active = scopedCards.filter((card) => card.slaStatus !== "completed");
    const waitingListIds = new Set(snapshot?.lists.filter((list) => list.slaBehavior === "paused").map((list) => list.id) ?? []);
    const completed = scopedCards.filter((card) => card.slaStatus === "completed").length;
    return {
      active: active.length,
      attention: active.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length,
      /* Atrasado e "vence hoje" são dois números, não um.
         `attention` soma os dois e continua servindo à Visão geral, que trata o
         conjunto como uma coisa só ("exigem atenção"). No quadro eles precisam
         estar separados: quem abre a tela decide o dia por essa diferença — o
         atrasado já custou prazo, o de hoje ainda dá para salvar, e um número
         somado não deixa ninguém escolher entre os dois. */
      overdue: active.filter((card) => card.slaStatus === "overdue").length,
      dueToday: active.filter((card) => card.slaStatus === "warning").length,
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

  function readDraft(): CardForm | null {
    if (!draftKey) return null;
    try {
      const raw = window.sessionStorage.getItem(draftKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CardForm>;
      return { ...emptyCardForm, ...parsed, boardId: snapshot?.board.id ?? "" };
    } catch { return null; }
  }

  function clearDraft() {
    setDraftRestored(false);
    if (!draftKey) return;
    try { window.sessionStorage.removeItem(draftKey); } catch { /* sem armazenamento: nada a apagar */ }
  }

  function discardDraft() {
    clearDraft();
    setCardForm({ ...emptyCardForm, boardId: snapshot?.board.id ?? "" });
  }

  function openNewCard() {
    if (!canEdit) return;
    setSelectedCardId(null);
    const draft = readDraft();
    setDraftRestored(Boolean(draft));
    setCardForm(draft ?? { ...emptyCardForm, boardId: snapshot?.board.id ?? "" });
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
      nextStep: card.nextStep,
      requestedFor: card.requestedFor ?? "",
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
          clearDraft();
          setCardModalOpen(false);
        } catch (causa) {
          setError(causa instanceof Error ? causa.message : "Não foi possível iniciar o processo.");
        } finally {
          setBusy(false);
        }
        return;
      }
      const next = await mutate("/api/cards", { method: "POST", body: JSON.stringify(cardForm) }, "Demanda criada com checklist padrão.");
      if (next) { clearDraft(); setCardModalOpen(false); }
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

  /**
   * Atribuir por arrasto, com a tela indo na frente (§10, §37).
   *
   * O quadro aplica a mudança antes de perguntar ao servidor. A alternativa —
   * esperar a resposta — faz o cartão voltar para a coluna de origem por meio
   * segundo, e é esse meio segundo que leva alguém a arrastar de novo; a
   * segunda atribuição é a que gera a linha duplicada no histórico.
   *
   * Se o servidor recusar, o retrato anterior volta inteiro. Não é um desfazer
   * campo a campo: entre o arrasto e a recusa, outra pessoa pode ter mexido na
   * mesma demanda, e reverter só o responsável deixaria o resto do quadro
   * descrito por um retrato que nunca existiu.
   */
  async function assignCard(cardId: string, userId: string, name: string) {
    if (!canEdit || !snapshot) return;
    const card = allCards.find((item) => item.id === cardId);
    if (!card) return;
    const anterior = snapshot;
    const atual = card.assignees[0]?.name ?? card.assigneeName ?? "";
    if ((userId ? name : "") === atual) return;

    const membro = userId ? snapshot.members.find((member) => member.userId === userId) : undefined;
    setSnapshot(applyAssigneeOptimistically(snapshot, cardId,
      membro ? { userId: membro.userId, name: membro.name, email: membro.email } : null));
    setBusy(true);
    setError("");
    try {
      const next = await requestSnapshot(`/api/cards/${cardId}/assignee`, {
        method: "POST",
        body: JSON.stringify({ assigneeIds: userId ? [userId] : [] }),
      });
      const mensagem = name ? `Demanda atribuída a ${name}.` : "Demanda devolvida para a fila comum.";
      applySnapshot(next, mensagem);
      // Todos os responsáveis de antes, não só o primeiro: a demanda pode ter vários.
      const anteriores = card.assignees.map((assignee) => assignee.userId).filter(Boolean);
      // Mesmo motivo do desfazer de mover: direto no servidor, sem o retrato antigo.
      setUndo({
        message: mensagem,
        run: () => void mutate(`/api/cards/${cardId}/assignee`, { method: "POST", body: JSON.stringify({ assigneeIds: anteriores }) }, "Atribuição desfeita."),
      });
    } catch (cause) {
      setSnapshot(anterior);
      setError(cause instanceof Error
        ? `Não foi possível atualizar o responsável. ${cause.message}`
        : "Não foi possível atualizar o responsável.");
    } finally {
      setBusy(false);
    }
  }

  /** Uma ação sobre a seleção inteira. O servidor recusa tudo ou aplica tudo. */
  async function runBulkAction(action: BulkAction) {
    const cardIds = [...boardSelection];
    if (cardIds.length === 0) return;
    const next = await mutate("/api/cards/bulk", {
      method: "POST",
      body: JSON.stringify({ cardIds, ...action }),
    }, `${cardIds.length} ${cardIds.length === 1 ? "demanda atualizada" : "demandas atualizadas"}.`);
    if (next) setBoardSelection(new Set());
  }

  function toggleCardSelection(cardId: string, selected: boolean) {
    setBoardSelection((atual) => {
      const proximo = new Set(atual);
      if (selected) proximo.add(cardId); else proximo.delete(cardId);
      return proximo;
    });
  }

  /** Guarda o recorte atual em "Meus filtros", no navegador de quem salvou. */
  function saveCurrentBoardView() {
    const workspaceId = snapshot?.workspace.id;
    if (!workspaceId) return;
    if (savedViews.length >= SAVED_VIEWS_LIMIT) {
      setError(`Você já tem ${SAVED_VIEWS_LIMIT} recortes salvos. Remova um antes de salvar outro.`);
      return;
    }
    const nome = window.prompt("Nome do recorte (ex.: Admissões atrasadas)")?.trim().slice(0, 40);
    if (!nome) return;
    const proximas = [...savedViews, { id: crypto.randomUUID(), name: nome, mode: boardMode, filters: boardFilters }];
    persistBoardViews(workspaceId, proximas);
    setToast(`Recorte "${nome}" salvo em Meus filtros.`);
  }

  function removeBoardView(id: string) {
    const workspaceId = snapshot?.workspace.id;
    if (!workspaceId) return;
    persistBoardViews(workspaceId, savedViews.filter((view) => view.id !== id));
  }

  function persistBoardViews(workspaceId: string, views: readonly SavedBoardView[]) {
    setSavedViews(views);
    try {
      window.localStorage.setItem(`vinculato-quadro-recortes:${workspaceId}`, JSON.stringify(views));
    } catch {
      /* Sem armazenamento, o recorte vale para esta sessão. Recusar a ação
         seria pior: a pessoa perderia o recorte que acabou de montar. */
    }
  }

  /** O que um indicador ou um alerta faz quando é clicado. */
  function focusIndicator(indicator: IndicatorId) {
    applyBoardFilters(toggleIndicator(boardFilters, indicator));
    setBoardSelection(new Set());
  }

  function focusAlert(alert: BoardAlert) {
    if (!alert.filters) return;
    applyBoardFilters({ ...boardFilters, ...alert.filters });
  }

  async function moveCard(cardId: string, toListId: string) {
    const card = allCards.find((item) => item.id === cardId);
    if (!card || card.listId === toListId) return;
    const origem = card.listId;
    const mensagem = "Demanda movida. Regras de SLA recalculadas.";
    const next = await mutate(`/api/cards/${cardId}/move`, { method: "POST", body: JSON.stringify({ toListId }) }, mensagem);
    /* O desfazer chama o servidor direto. Passar por `moveCard` de novo usaria
       o retrato do quadro guardado neste fechamento — com a demanda ainda na
       coluna de origem — e a função concluiria que não há nada a mover. */
    if (next) setUndo({
      message: mensagem,
      run: () => void mutate(`/api/cards/${cardId}/move`, { method: "POST", body: JSON.stringify({ toListId: origem }) }, "Movimentação desfeita."),
    });
  }

  /**
   * Arrastar no quadro: a demanda cai na tela na hora (como no Trello) e o
   * servidor confirma depois. Se a gravação falhar, o quadro volta ao que era.
   */
  async function moveCardTo(drop: KanbanDrop) {
    if (!canEdit || !snapshot) return;
    const card = allCards.find((item) => item.id === drop.cardId);
    if (!card) return;
    const anterior = snapshot;
    const mudouDeColuna = card.listId !== drop.toListId;
    setSnapshot(applyMoveOptimistically(snapshot, drop.cardId, drop.toListId, drop));
    setError("");
    try {
      const next = await requestSnapshot(`/api/cards/${drop.cardId}/move`, {
        method: "POST",
        body: JSON.stringify({ toListId: drop.toListId, beforeCardId: drop.beforeCardId ?? "", afterCardId: drop.afterCardId ?? "" }),
      });
      if (!mudouDeColuna) { applySnapshot(next); return; }
      const mensagem = "Demanda movida. Regras de SLA recalculadas.";
      applySnapshot(next, mensagem);
      /* Desfazer devolve à coluna e ao lugar de antes, entre os mesmos
         vizinhos — direto no servidor, pelo mesmo motivo do `moveCard`. */
      const origem = anterior.lists.find((list) => list.id === card.listId)?.cards ?? [];
      const indice = origem.findIndex((item) => item.id === card.id);
      const volta = { toListId: card.listId, beforeCardId: origem[indice - 1]?.id ?? "", afterCardId: origem[indice + 1]?.id ?? "" };
      setUndo({
        message: mensagem,
        run: () => void mutate(`/api/cards/${card.id}/move`, { method: "POST", body: JSON.stringify(volta) }, "Movimentação desfeita."),
      });
    } catch (cause) {
      setSnapshot(anterior);
      setError(cause instanceof Error ? `Não foi possível mover a demanda. ${cause.message}` : "Não foi possível mover a demanda.");
    }
  }

  /** O "Adicionar demanda" da coluna: título e processo, criada ali mesmo. */
  async function quickCreateCard(input: { listId: string; title: string; processType: string }) {
    if (!canEdit || !snapshot) return false;
    const next = await mutate("/api/cards", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        processType: input.processType,
        listId: input.listId,
        boardId: snapshot.board.id,
        companyId: companyFilter === "all" ? "" : companyFilter,
      }),
    }, "Demanda criada.");
    return next !== null;
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
      const payload = await response.json() as WorkspaceSnapshot & { error?: string; createdCommentId?: string; mentionWarning?: string };
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
      setToast(payload.mentionWarning || (commentAttachment ? "Comentário e anexo publicados." : "Comentário publicado."));
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
    setAdministrationOpen(true);
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
        // Recarga completa de propósito: a sessão acabou e nenhum estado do painel pode sobreviver.
        window.location.assign(new URL("/login", window.location.origin).href);
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
    if (next) setAdministrationOpen(false);
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
      setInviteOpen(false);
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

  async function updateMemberEmployeeLink(userId: string, employeeId: string) {
    await mutate(`/api/members/${userId}`, { method: "PATCH", body: JSON.stringify({ employeeId }) },
      employeeId ? "Conta vinculada ao colaborador." : "Vínculo com colaborador removido.");
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
      setAdministrationOpen(false);
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
      return;
    }
    /* Arquivada antiga: o snapshot traz só as mais recentes, então ela não
       está na tela. Antes o clique não fazia nada; agora oferece restaurar. */
    if (result.archived) {
      setSearchOpen(false);
      requestConfirmation({
        title: "Restaurar demanda arquivada?",
        description: `“${result.title}” está no arquivo. Restaurar devolve a demanda ao quadro, onde ela pode ser aberta.`,
        confirmLabel: "Restaurar para o quadro",
        action: () => restoreCard(result.id),
      });
      return;
    }
    setToast("Esta demanda não está no quadro aberto. Troque de quadro para abri-la.");
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
  const todayShort = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
  /* O departamento por onde a pessoa responde, e a competência em curso.
     A competência sai dos ciclos de folha quando existe um aberto — é o que o
     DP chama de "o mês que está rodando" — e cai no mês corrente quando não
     existe nenhum. Inventar sempre o mês corrente diria "set/2026" no dia 2 de
     outubro para quem ainda está fechando setembro. */
  const currentMemberDepartment = snapshot?.members.find((member) => member.email.toLowerCase() === user.email.toLowerCase())?.departmentName ?? "";
  const currentCompetence = snapshot?.payrollCycles.find((cycle) => cycle.status !== "closed")?.competence
    ?? new Date().toISOString().slice(0, 7);
  const companyScopeLabel = snapshot.workspace.companyScope === "restricted" ? "Empresas autorizadas" : "Todas do grupo";
  const erpScopeLabel = companyFilter === "all" ? companyScopeLabel
    : (snapshot.companies.find((item) => item.id === companyFilter)?.tradeName || snapshot.companies.find((item) => item.id === companyFilter)?.legalName || "Empresa selecionada");

  /* A Administração, desenhada como página.
   *
   * O conteúdo é o mesmo das nove seções; o que mudou foi a moldura. O
   * cabeçalho deixa de ser o de uma janela — sem "×" para fechar, porque não
   * há nada por baixo para voltar — e passa a ser o cabeçalho da tela, com o
   * caminho que diz onde a pessoa está.
   */
  const administrationPage = snapshot ? <>
    {/* Só o título da seção: a aba já diz "Administração", e caminho, grupo,
        descrição e data repetiam o que está na tela. */}
    <div className="dashboard-heading admin-page-heading">
      <div><h1 id="admin-page-title">{settingsSectionMeta[settingsSection].title}</h1></div>
    </div>
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
                  <span>{settingsSectionMeta[item.section].title}</span>
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
                {isAdmin && <TrelloImportPanel busy={busy} processTypes={processTypeOptions} onImport={(body) => mutate("/api/boards/import/trello", { method: "POST", body }, "Quadro importado do Trello.")} />}
              </section>
            </>}
            {settingsSection === "columns" && <ListsSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onMutate={mutate} onConfirm={requestConfirmation} />}
            {settingsSection === "companies" && isAdmin && <CompanySettings companies={snapshot.companies} members={snapshot.members} busy={busy} onCreateCompany={createCompany} onUpdateCompany={updateCompany} onDeleteCompany={deleteCompany} onOpenAccess={() => setSettingsSection("team")} />}
            {settingsSection === "team" && (() => {
              const term = memberQuery.trim().toLocaleLowerCase("pt-BR");
              const members = snapshot.members.filter((member) =>
                (!term || `${member.name} ${member.email}`.toLocaleLowerCase("pt-BR").includes(term))
                && (!memberRoleFilter || member.role === memberRoleFilter)
                && (memberStatusFilter === "" ? true
                  : memberStatusFilter === "active" ? member.isActivated
                  : memberStatusFilter === "pending" ? !member.isActivated
                  : !member.isOwner && !member.departmentId));
              const total = snapshot.members.length;
              const ativos = snapshot.members.filter((member) => member.isActivated).length;
              const pendentes = total - ativos;
              const semDepartamento = snapshot.members.filter((member) => !member.isOwner && !member.departmentId).length;
              const admins = snapshot.members.filter((member) => member.role === "admin").length;
              const editing = snapshot.members.find((member) => member.userId === editingMemberId) ?? null;
              const companyCount = (member: WorkspaceMember) => member.role === "admin" || member.isOwner ? "Todas"
                : member.companyIds.length === 0 ? "Nenhuma" : String(member.companyIds.length);
              return <>
                {/* Barra de ações da tela: o que se faz aqui primeiro é liberar
                    alguém, então o botão fica no topo, e não no pé da página. */}
                {isAdmin && <div className="admin-toolbar">
                  <div className="admin-counters" role="group" aria-label="Resumo dos usuários">
                    <button type="button" aria-pressed={memberStatusFilter === "" && !memberRoleFilter} onClick={() => { setMemberStatusFilter(""); setMemberRoleFilter(""); }}><span>Usuários</span><b>{total}</b></button>
                    <button type="button" aria-pressed={memberStatusFilter === "active"} onClick={() => setMemberStatusFilter(memberStatusFilter === "active" ? "" : "active")}><span>Ativos</span><b>{ativos}</b></button>
                    <button type="button" data-tone={pendentes ? "warning" : undefined} aria-pressed={memberStatusFilter === "pending"} onClick={() => setMemberStatusFilter(memberStatusFilter === "pending" ? "" : "pending")}><span>Ativação pendente</span><b>{pendentes}</b></button>
                    <button type="button" data-tone={semDepartamento ? "warning" : undefined} aria-pressed={memberStatusFilter === "no-department"} onClick={() => setMemberStatusFilter(memberStatusFilter === "no-department" ? "" : "no-department")}><span>Sem departamento</span><b>{semDepartamento}</b></button>
                    <button type="button" aria-pressed={memberRoleFilter === "admin"} onClick={() => setMemberRoleFilter(memberRoleFilter === "admin" ? "" : "admin")}><span>Administradores</span><b>{admins}</b></button>
                  </div>
                  <button type="button" className="primary-button" onClick={() => setInviteOpen(true)}><Plus aria-hidden="true" />Novo usuário</button>
                </div>}

                <section className="admin-users" aria-labelledby="admin-users-title">
                  <header>
                    <strong id="admin-users-title">Usuários do grupo</strong>
                    <label className="admin-search"><Search aria-hidden="true" /><span className="sr-only">Buscar usuário</span>
                      <input type="search" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="Nome ou e-mail" /></label>
                    <label className="admin-filter"><span className="sr-only">Papel</span>
                      <select value={memberRoleFilter} onChange={(event) => setMemberRoleFilter(event.target.value as WorkspaceRole | "")}>
                        <option value="">Todos os papéis</option>
                        <option value="admin">Administrador</option><option value="member">Membro</option><option value="observer">Observador</option><option value="guest">Convidado</option>
                      </select></label>
                  </header>
                  <div className="overview-table-scroll">
                    <table className="overview-table admin-table admin-users-table">
                      <thead><tr>
                        <th scope="col">Usuário</th>
                        <th scope="col">Papel</th>
                        <th scope="col">Departamento</th>
                        <th scope="col">Empresas</th>
                        <th scope="col">Situação</th>
                        <th scope="col"><span className="sr-only">Ações</span></th>
                      </tr></thead>
                      <tbody>
                        {members.map((member) => <tr key={member.userId}>
                          <td>
                            <div className="admin-user-cell">
                              <i aria-hidden="true">{initials(member.name)}</i>
                              <span><strong>{member.name}</strong><small>{member.email}</small></span>
                            </div>
                          </td>
                          <td>{roleLabels[member.role]}{member.isOwner && <em className="admin-owner-tag">Principal</em>}</td>
                          <td>{member.departmentName || (member.isOwner ? "—" : <span className="admin-missing">Sem departamento</span>)}</td>
                          <td className="numeric">{companyCount(member)}</td>
                          <td><span className={`admin-status ${member.isActivated ? "active" : "pending"}`}>{member.isActivated ? "Ativo" : "Ativação pendente"}</span></td>
                          <td className="admin-row-actions">
                            {isAdmin && !member.isOwner
                              ? <button type="button" className="secondary-button" onClick={() => setEditingMemberId(member.userId)} aria-label={`Editar ${member.name}`}>Editar</button>
                              : null}
                          </td>
                        </tr>)}
                        {members.length === 0 && <tr><td colSpan={6} className="admin-empty">Nenhum usuário com esses filtros.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <footer className="admin-hint">
                    O papel define as ações; o departamento dá os módulos padrão; a exceção individual vence o departamento; a empresa limita os CNPJs.{" "}
                    <button type="button" className="link-button" onClick={() => setSettingsSection("matrix")}>Ver o que cada papel permite</button>
                  </footer>
                </section>

                {/* Editar usuário: tudo o que se ajusta numa pessoa, num lugar
                    só e em ordem — papel, lotação, alcance e acesso. Antes eram
                    seis controles soltos em cada linha da lista. */}
                <AnimatedDrawer open={Boolean(editing)} onClose={() => setEditingMemberId(null)} label={editing ? `Editar ${editing.name}` : "Editar usuário"} width={720} className="admin-drawer">
                  {editing && <>
                    <header className="admin-drawer-head">
                      <div><span>Editar usuário</span><h2>{editing.name}</h2><small>{editing.email}</small></div>
                      <button type="button" className="admin-drawer-close" aria-label="Fechar" onClick={() => setEditingMemberId(null)}><X aria-hidden="true" /></button>
                    </header>
                    <div className="admin-drawer-body">
                      <section>
                        <h3>Papel</h3>
                        <select aria-label={`Papel de ${editing.name}`} value={editing.role} disabled={busy} onChange={(event) => void updateMemberRole(editing.userId, event.target.value as WorkspaceRole)}>
                          <option value="admin">Administrador</option><option value="member">Membro</option><option value="observer">Observador</option><option value="guest">Convidado</option>
                        </select>
                        <p>{roleSummaries[editing.role]}</p>
                      </section>
                      <section>
                        <h3>Departamento</h3>
                        <select className="member-department-select" aria-label={`Departamento de ${editing.name}`} value={editing.departmentId ?? ""} disabled={busy}
                          onChange={(event) => updateMemberDepartment(editing.userId, editing.name, event.target.value)}>
                          {!editing.departmentId && <option value="">Selecione o departamento</option>}
                          {activeDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}
                        </select>
                        <p>O departamento define os módulos padrão desta pessoa.</p>
                      </section>
                      <section>
                        <h3>Empresas</h3>
                        <MemberCompanyAccess key={`${editing.userId}:${editing.companyIds.join(",")}`} member={editing} companies={snapshot.companies} busy={busy} onSave={updateMemberCompanies} />
                      </section>
                      <section>
                        <h3>Módulos</h3>
                        <MemberModules memberId={editing.userId} key={`${editing.userId}:${editing.departmentId ?? "none"}`} memberName={editing.name} canManage={isAdmin} />
                      </section>
                      <section>
                        <h3>Colaborador vinculado</h3>
                        <MemberEmployeeLink key={`${editing.userId}:${editing.employeeId ?? "none"}`} member={editing} busy={busy} onSave={updateMemberEmployeeLink} />
                      </section>
                      <section className="admin-drawer-access">
                        <h3>Acesso</h3>
                        <p>{editing.isActivated ? "Conta ativa. Um link novo serve para redefinir a senha." : "A pessoa ainda não ativou a conta."}</p>
                        <div>
                          <button type="button" className="secondary-button member-recovery-button" disabled={busy} onClick={() => void generateRecoveryLink(editing.userId, editing.name)}>{editing.isActivated ? "Gerar link de nova senha" : "Gerar link de ativação"}</button>
                          <button type="button" className="danger-button" disabled={busy} onClick={() => { const id = editing.userId; const name = editing.name; setEditingMemberId(null); void removeMember(id, name); }}>Remover do grupo</button>
                        </div>
                      </section>
                    </div>
                  </>}
                </AnimatedDrawer>

                {isAdmin && <AnimatedDrawer open={inviteOpen} onClose={() => setInviteOpen(false)} label="Novo usuário" width={560} className="admin-drawer">
                  <form className="admin-invite-form" onSubmit={addMember}>
                    <header className="admin-drawer-head">
                      <div><span>Novo usuário</span><h2>Criar e liberar acesso</h2><small>Identidade, departamento, módulos e empresas. O link de ativação sai no fim.</small></div>
                      <button type="button" className="admin-drawer-close" aria-label="Fechar" onClick={() => setInviteOpen(false)}><X aria-hidden="true" /></button>
                    </header>
                    <div className="admin-drawer-body">
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
                  <fieldset className="invite-company-scope" disabled={busy || memberRole === "admin"}><legend>{memberRole === "admin" ? "Administrador acessa todas as empresas" : "Empresas autorizadas"}</legend><div>{snapshot.companies.map((company) => <label key={company.id}><input type="checkbox" checked={memberCompanyIds.includes(company.id)} onChange={(event) => setMemberCompanyIds((current) => event.target.checked ? [...current, company.id] : current.filter((id) => id !== company.id))} />{company.tradeName || company.legalName}{company.isPrincipal && <em>Matriz</em>}</label>)}</div></fieldset>
                    </div>
                    <footer className="admin-drawer-foot">
                      <button type="button" className="secondary-button" onClick={() => setInviteOpen(false)}>Cancelar</button>
                      <button className="primary-button" disabled={busy || !memberEmail.trim() || !memberDepartmentId || memberModuleKeys.length === 0}>Criar usuário e gerar link</button>
                    </footer>
                  </form>
                </AnimatedDrawer>}
              </>;
            })()}
            {settingsSection === "matrix" && <>
              {/* Os quatro papéis lado a lado, com quantas pessoas estão em
                  cada um: é a pergunta que vem antes de abrir a matriz. */}
              <div className="admin-role-cards">
                {(["admin", "member", "observer", "guest"] as const).map((papel) => {
                  const quantos = snapshot.members.filter((member) => member.role === papel).length;
                  return <article key={papel}>
                    <header><strong>{roleLabels[papel]}</strong><span>{plural(quantos, "pessoa", "pessoas")}</span></header>
                    <p>{roleSummaries[papel]}</p>
                  </article>;
                })}
              </div>
              <PermissionMatrix />
            </>}
            {settingsSection === "team" && recoveryLink && <section className="access-recovery-link"><header><div><span>Link único de recuperação</span><strong>{recoveryLink.name}</strong><small>Válido até {new Date(recoveryLink.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. O link deixa de funcionar após o primeiro uso.</small></div><button onClick={() => { void navigator.clipboard.writeText(recoveryLink.url).then(() => setToast("Link de recuperação copiado.")); }}>Copiar link</button></header><input value={recoveryLink.url} readOnly aria-label="Link de recuperação" /></section>}
            {settingsSection === "security" && <section className="security-sessions">
              <header><div><strong>Dispositivos conectados</strong><span>Revise os acessos ativos da sua conta. Endereços IP e identificadores completos do navegador não são armazenados.</span></div><button className="secondary-button" disabled={busy || sessionsLoading || authSessions.length < 2} onClick={() => void revokeAuthSessions("/api/auth/sessions?scope=others")}>Sair dos outros</button></header>
              {sessionsLoading && <p>Carregando sessões...</p>}
              {!sessionsLoading && authSessions.length === 0 && <p>Nenhuma sessão gerenciável foi encontrada para este tipo de acesso.</p>}
              <div>{authSessions.map((session) => <article key={session.id}><i><Smartphone aria-hidden="true" /></i><span><strong>{session.deviceLabel}{session.current && <em>Atual</em>}</strong><small>Último uso: {new Date(session.lastSeenAt).toLocaleString("pt-BR")} · Criada em {new Date(session.createdAt).toLocaleDateString("pt-BR")}</small><small>Expira em {new Date(session.expiresAt).toLocaleString("pt-BR")}</small></span><button className="secondary-button" disabled={busy} onClick={() => void revokeAuthSessions(`/api/auth/sessions/${session.id}`)}>{session.current ? "Sair deste dispositivo" : "Revogar"}</button></article>)}</div>
              <footer><span>Se você não reconhecer um dispositivo, encerre todas as sessões e entre novamente.</span><button className="danger-button" disabled={busy || sessionsLoading || authSessions.length === 0} onClick={() => void revokeAuthSessions("/api/auth/sessions?scope=all")}>Sair de todos</button></footer>
            </section>}
            {settingsSection === "fields" && <FieldsSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} onConfirm={requestConfirmation} />}
            {settingsSection === "templates" && <TemplatesSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} onConfirm={requestConfirmation} onUseTemplate={(id) => { setAdministrationOpen(false); openFromTemplate(id); }} />}
            {settingsSection === "sla" && <SlaSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} />}
            {settingsSection === "automations" && <RulesSettings snapshot={snapshot} busy={busy} isAdmin={isAdmin} onCatalog={updateCatalog} onConfirm={requestConfirmation} />}
          </div>
        </div>
  </> : null;

  /* O que o cartão do quadro mostra além do básico: a etapa do processo com o
     progresso, e o fluxo entre áreas. Os dois dependem de dados do painel
     (`flowByCard`, o catálogo de áreas), por isso são desenhados aqui e
     entregues ao `KanbanBoard`. Sem fluxo carregado, a etapa não aparece —
     demanda fora do teto de fluxos não ganha etapa inventada. */
  const renderCardDetail = (card: Card) => {
    const flow = flowByCard.get(card.id);
    const areaFlow = card.requesterAreaId || card.responsibleAreaId;
    if (!flow && !areaFlow) return null;
    return <>
      {flow ? <CardProcessLine flow={flow} /> : null}
      <DemandAreaFlow card={card} areas={snapshot.areas} />
    </>;
  };

  const renderKanban = (cardsByList: ReadonlyMap<string, Card[]>, laneKey: string, grouped: boolean) => <KanbanBoard
    lists={snapshot.lists}
    cardsByList={cardsByList}
    laneKey={laneKey}
    canEdit={canEdit}
    reorderable={boardSort === "position" && !grouped}
    composer={!grouped}
    density={boardDensity}
    filtered={activeBoardFilters > 0 || Boolean(boardQuery.trim())}
    now={boardNow}
    processTypes={processTypeOptions}
    archiveDays={snapshot.settings.completedArchiveDays ?? 7}
    archivedTotal={archivedTotal}
    onOpen={openCard}
    onMove={(drop) => void moveCardTo(drop)}
    onQuickCreate={quickCreateCard}
    onOpenFullForm={({ listId, title, processType }) => {
      setCardForm({ ...emptyCardForm, boardId: snapshot.board.id, listId, title, processType });
      setSelectedCardId(null);
      setCardTab("details");
      setCardModalOpen(true);
    }}
    onOpenArchive={() => setArchiveOpen(true)}
    onManageColumns={isAdmin ? () => { setSettingsSection("columns"); openWorkspaceSettings(); } : undefined}
    renderCardDetail={renderCardDetail}
  />;

  /* Casca clara, barra escura.
     O painel rodava em `theme-dark` desde a direção "central de comando", e a
     maquete aprovada do Vinculato pede o contrário: conteúdo em papel claro,
     com a navegação num bloco navy que separa "onde eu estou" de "o que estou
     lendo". Não é troca de gosto — o quadro de demandas é uma tela de leitura
     longa (título, empresa, prazo, responsável, linha após linha), e é ali que
     o fundo claro rende. A barra continua escura porque ela é moldura, não
     conteúdo.
     O tema escuro não foi removido: `.theme-dark` continua definido e medido em
     `dashboard-modern.css`; ele só deixou de ser o tema que o produto entrega. */
  return (
    /* `data-focus` no invólucro, e não no quadro: o que o modo foco esconde —
       barra lateral, contexto do topo — está fora do quadro, e é justamente
       isso que devolve a largura para as colunas. */
    <main className={`dashboard-shell operational-ui${theme === "dark" ? " theme-dark" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}${erpMode ? " erp-mode" : ""}${pjMode ? " pj-mode" : ""}${administrationOpen ? " admin-mode" : ""}`} data-view={view} data-theme={theme} data-density={density} data-focus={focusMode && view === "board" ? "on" : undefined}>
      <a className="skip-link" href="#conteudo-painel">Pular para o conteúdo</a>
      <section className="dashboard-main">
        {/* Faixa única do sistema: marca, janela de módulos, as abas abertas e,
            à direita, contexto e conta. A barra lateral saiu — com a janela de
            módulos e as abas ela repetia a mesma navegação pela terceira vez. */}
        <header className="shell-bar">
          <button type="button" className="shell-brand" onClick={() => openShellTab("inicio")} aria-label="Vinculato — início">
            <VinculatoLogo size={22} compact tone={theme === "dark" ? "light" : "color"} />
          </button>
          {/* Na Administração a faixa troca de função: em vez das abas dos
              módulos, diz em que área a pessoa está e oferece a volta. É a
              separação entre configurar o grupo e operar o dia a dia. */}
          {administrationOpen && <div className="shell-admin-context">
            <span className="shell-admin-badge"><Settings aria-hidden="true" />Administração</span>
            <span className="shell-admin-workspace" title={snapshot.workspace.name}>{snapshot.workspace.name}</span>
            <button type="button" className="shell-admin-back" onClick={() => {
              if (operationalTabId === "erp-dp") setAdministrationOpen(false); else openShellTab(operationalTabId);
            }}><ArrowLeft aria-hidden="true" />Voltar ao sistema</button>
          </div>}
          {!administrationOpen && launcherModules.length > 1 && <button type="button" className="shell-modules" onClick={() => setModuleLauncher("switch")}
            aria-label="Abrir janela de módulos" title="Módulos">
            <LayoutGrid aria-hidden="true" /><span>Módulos</span>
          </button>}
          {!administrationOpen && <nav className="shell-tabs" aria-label="Módulos abertos">
            <ul>
              {openTabs.map((id) => <li key={id} className="shell-tab" data-active={id === activeTabId ? "" : undefined}>
                <button type="button" onClick={() => openShellTab(id)} aria-current={id === activeTabId ? "page" : undefined}
                  title={tabLabel(id)}>{tabLabel(id)}</button>
                {openTabs.length > 1 && <button type="button" className="shell-tab-close" onClick={() => closeShellTab(id)}
                  aria-label={`Fechar ${tabLabel(id)}`}><X aria-hidden="true" /></button>}
              </li>)}
            </ul>
          </nav>}
          <div className="shell-actions">
            {view === "overview" && !erpMode && !administrationOpen && <label className="header-period-select"><CalendarClock aria-hidden="true" /><select aria-label="Selecionar período" value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value as OverviewPeriod)}>{overviewPeriods.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>}
            {/* A Administração vale para o grupo inteiro: o seletor de empresa
                só confundiria, sugerindo um recorte que estas telas não fazem. */}
            {!administrationOpen && <CompanyPicker companies={snapshot.companies} value={companyFilter} allLabel={companyScopeLabel} onChange={setCompanyFilter} />}
            <button className="global-search-trigger" aria-label="Busca global" title="Busca global (⌘K)" onClick={() => setSearchOpen(true)}><Search aria-hidden="true" /><span>Buscar</span><kbd>⌘K</kbd></button>
            <button className="shell-icon" aria-label="Notificações" title="Notificações" onClick={() => setNotificationsOpen(true)}><Bell aria-hidden="true" />{snapshot.notifications.some((item) => !item.readAt) && <i />}</button>
            <button className="shell-icon help-button" aria-label="Abrir o assistente" title="Ajuda" onClick={() => setAssistantSignal((current) => current + 1)}><CircleHelp aria-hidden="true" /></button>
            {!erpMode && canEdit && primaryAction && header.ownHeader && !administrationOpen && <button className="new-demand"
              onClick={primaryAction.kind === "inbox" ? () => setInboxModalOpen(true) : openNewCard}>
              <Plus aria-hidden="true" /><span>{primaryAction.label}</span>
            </button>}
            <AccountMenu name={user.displayName} email={user.email} initials={userInitials}
              theme={themePreference} onTheme={escolherTema} density={density} onDensity={escolherDensidade}
              workspaces={snapshot.availableWorkspaces.map((item) => ({ id: item.id, name: item.name,
                detail: `${roleLabels[item.role]}${item.operational ? "" : ` · ${workspaceStatusLabels[item.status] ?? item.status}`}`,
                disabled: !item.operational }))}
              currentWorkspaceId={snapshot.workspace.id} onSwitchWorkspace={(id) => void switchWorkspace(id)}
              isAdmin={isAdmin} onAdministration={() => { setSettingsSection("general"); openWorkspaceSettings(); }}
              onSecurity={openSecuritySettings} onSignOut={() => void signOut()} busy={busy} />
          </div>
        </header>

        <div className="dashboard-content" id="conteudo-painel" tabIndex={-1}>
          {erpAlive && <div className="view-pane view-transition" hidden={!erpMode}><ViewPaneActiveContext.Provider value={erpMode}><ErpDpView companyId={companyFilter === "all" ? "" : companyFilter} scopeLabel={erpScopeLabel}
            canManageMovements={hasCapability(snapshot.workspace.role, "movements.manage")}
            canManageEmployees={hasCapability(snapshot.workspace.role, "employees.manage")}
            canReadMovements={hasCapability(snapshot.workspace.role, "movements.read")}
            canReadCycles={hasCapability(snapshot.workspace.role, "competences.read")}
            canCheckEsocial={hasCapability(snapshot.workspace.role, "obligations.manage")}
            canReadPayroll={hasCapability(snapshot.workspace.role, "payroll.read")}
            canManagePayroll={hasCapability(snapshot.workspace.role, "payroll.manage")} /></ViewPaneActiveContext.Provider></div>}
          <div className="view-stack" hidden={erpMode}>
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
          {/* Keep module navigation outside the remounted view. Single modules may supply their own tabs. */}
          {/* No Sistema PJ o menu lateral já é a subnavegação do módulo: as
              abas repetiriam os mesmos nove destinos logo acima da tela. */}
          {activeGroup && (
            <section className="process-context process-context-compact" aria-label={`Processo ${activeGroup.label}`}>
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
          {/* A Administração é uma tela, e não uma janela por cima da tela.
              Ela era uma modal: abria sobre o painel, escurecia o resto e
              prendia o foco. Isso serve para uma confirmação de três linhas —
              não para nove seções onde se cadastra empresa, cria usuário,
              define coluna, escreve automação e confere permissão. Quem
              administra fica ali, e ficar não é o que uma modal permite.

              O endereço não muda: `/painel/configuracoes/<seção>` continua
              sendo o link que se manda para alguém, e agora ele abre a tela em
              vez de abrir a janela. */}
          {administrationOpen && <PageTransition transitionKey={`administracao-${settingsSection}`} className="view-transition">
            {administrationPage}
          </PageTransition>}
          <div className="view-stack" hidden={administrationOpen}>
          {/* A tela que desenha o próprio cabeçalho não recebe este (§41). */}
          {!header.ownHeader && <div className="dashboard-heading">
            <div>
              <h1>{header.title}</h1>
              {!["overview", "registrations"].includes(view) && <p>{header.description}</p>}
            </div>
            <div className="dashboard-heading-meta">
              <div className={`dashboard-sync-status ${realtimeStatus}`} aria-live="polite"><RefreshCw aria-hidden="true" /><span>{formatSyncStatus(lastUpdatedAt, realtimeStatus)}</span></div>
              {keepAlive("overview", <div className="dashboard-date"><strong>{today}</strong></div>)}
              {/* Onde a pessoa está operando, e quando (§4).
                  O quadro é lido o dia inteiro, e três coisas mudam a leitura de
                  todo número que está abaixo: o departamento por onde ela
                  responde, a competência em curso e a data de hoje. Nenhuma
                  delas aparecia — quem abria o quadro às sete da manhã de uma
                  segunda de fechamento via os mesmos números de uma
                  quarta-feira qualquer, sem nada dizendo qual era o contexto. */}
              {keepAlive("board", <div className="dashboard-date board-context">
                <span>{currentMemberDepartment || "Operação"}</span>
                <strong>{today}</strong>
                <small>Competência {competenceLabel(currentCompetence)}</small>
              </div>)}
              {canEdit && primaryAction && <button className="new-demand"
                onClick={primaryAction.kind === "inbox" ? () => setInboxModalOpen(true) : openNewCard}>
                <Plus aria-hidden="true" /><span>{primaryAction.label}</span>
              </button>}
            </div>
          </div>}

          {keepAlive("overview", <OverviewView integrations={snapshot.integrations}
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
            onNavigate={(target) => setView(target)} cards={scopedCards} lists={scopedLists} activities={scopedActivities} stats={stats} onOpen={openCard} onOpenBoard={() => setView("board")} scopeLabel={companyFilter === "all" ? companyScopeLabel : (snapshot.companies.find((company) => company.id === companyFilter)?.tradeName || snapshot.companies.find((company) => company.id === companyFilter)?.legalName || "Empresa selecionada")} />)}

          {keepAlive("processManagement", <ProcessManagementView role={snapshot.workspace.role} />)}

          {keepAlive("processes", <OperationsView role={snapshot.workspace.role} />)}

          {keepAlive("auxiliary", <AuxiliaryModulesView role={snapshot.workspace.role} />)}

          {keepAlive("psychologistPayments", <PaymentsView role={snapshot.workspace.role} module="psychology" />)}

          {isContractorSection(view) && <PaymentsView role={snapshot.workspace.role} module="contractors" section={view}
            focus={contractorPaymentFocus} />}

          {keepAlive("timeTracking", <TimeTrackingView role={snapshot.workspace.role} />)}

          {keepAlive("epi", <EpiControlView role={snapshot.workspace.role} />)}

          {keepAlive("portfolio", <PortfolioView canManage={hasCapability(snapshot.workspace.role, "portfolio.manage")} />)}

          {keepAlive("dpOperations", <DpOperationsView canManage={hasCapability(snapshot.workspace.role, "portfolio.manage")}
            initialTab={initialLocation.view === "dpOperations" ? initialViewTab : ""} />)}

          {keepAlive("safety", <WorkAccidentDashboardView />)}
          {keepAlive("payrollLedger", (
            <LedgerView
              members={snapshot.members.map((member) => ({ id: member.userId, name: member.name || member.email, email: member.email }))}
              currentUserId={snapshot.members.find((member) => member.email.toLowerCase() === user.email.toLowerCase())?.userId ?? ""}
            />
          ))}

          {keepAlive("integrations", <IntegrationsView role={snapshot.workspace.role} />)}

          {/* As três centrais operacionais. Elas são camadas de leitura sobre o
              que já existe: nenhuma delas cria objeto de trabalho novo, e cada
              item que mostram é resolvido na tela do módulo dono dele. */}
          {keepAlive("work", <WorkCenterView onOpenCompanyFilter={(companyId) => setCompanyFilter(companyId || "all")}
            onNavigate={(target) => setView(target)} companyId={companyFilter === "all" ? "" : companyFilter} />)}

          {keepAlive("triage", <TriageView initialItemId={initialLocation.view === "triage" ? initialLocation.recordId : ""} />)}

          {keepAlive("agents", <AgentsView />)}

          {keepAlive("registrations", <RegistrationsView role={snapshot.workspace.role}
            initialEmployeeId={initialLocation.view === "registrations" ? initialLocation.recordId : ""}
            initialEmployeeTab={initialLocation.view === "registrations" ? initialLocation.recordTab : ""}
            onOpenContractorPayment={(target) => { setContractorPaymentFocus(target); setView("contractorClosings"); }} />)}

          {keepAlive("board", (
            <div className="board-shell" data-focus={focusMode || undefined}>
              {/* Seis números, e cada um deles é o recorte que ele conta.
                  A tira antiga tinha quatro e nenhum deles era "sem
                  responsável" — que é justamente o primeiro que um gestor de DP
                  procura de manhã, porque é a pilha que só sai do lugar se
                  alguém a distribuir. */}
              <BoardIndicators
                indicators={boardIndicators}
                filters={boardFilters}
                alerts={boardAlerts}
                onToggle={focusIndicator}
                onAlert={focusAlert}
              />

              <BoardToolbar
                filters={boardFilters}
                onFilters={applyBoardFilters}
                mode={boardMode}
                onMode={setBoardMode}
                sort={boardSort}
                onSort={setBoardSort}
                companies={snapshot.companies}
                lists={snapshot.lists}
                labels={snapshot.labels}
                members={snapshot.members}
                processTypes={processTypes}
                competences={boardCompetences}
                currentMemberName={currentMemberName}
                savedViews={savedViews}
                onSaveView={saveCurrentBoardView}
                onApplyView={(view_) => { applyBoardFilters(view_.filters); setBoardMode(view_.mode); }}
                onRemoveView={removeBoardView}
                focusMode={focusMode}
                onFocusMode={setFocusMode}
                density={boardDensity}
                onDensity={setBoardDensity}
                groupBy={boardGroupBy}
                onGroupBy={setBoardGroupBy}
                archivedCount={archivedTotal}
                onOpenArchive={() => setArchiveOpen(true)}
              />

              {/* O painel das abas de modo. `tabIndex={-1}` e não `0`: o quadro
                  tem os próprios alvos de foco — cartões, ações, caixas de
                  seleção —, e uma parada de tabulação no invólucro faria o
                  teclado passar por um contêiner vazio antes de chegar neles.
                  O `-1` mantém o painel alcançável por programa, que é o que a
                  aba precisa para apontar para ele. */}
              <div id="board-view-panel" role="tabpanel" tabIndex={-1} aria-labelledby={`board-mode-${boardMode}`} className="board-view-panel">
              {boardMode === "team" && <TeamBoard
                cards={filteredActiveCards}
                members={snapshot.members}
                stageNames={stageNames}
                sort={boardSort}
                canEdit={canEdit}
                now={boardNow}
                selection={boardSelection}
                filtered={activeBoardFilters > 0}
                onOpen={openCard}
                onToggleSelect={toggleCardSelection}
                onAssign={(cardId, userId, name) => void assignCard(cardId, userId, name)}
                onQuickAssign={(card) => { openCard(card); focusCardField("card-assignees"); }}
                onQuickComment={(card) => { openCard(card); setCardTab("activity"); }}
                onQuickDue={(card) => { openCard(card); focusCardField("card-due-at"); }}
              />}

              {boardMode === "queue" && <QueueBoard
                cards={filteredActiveCards}
                context={boardContext}
                stageNames={stageNames}
                canEdit={canEdit}
                now={boardNow}
                selection={boardSelection}
                onOpen={openCard}
                onToggleSelect={toggleCardSelection}
                onQuickAssign={(card) => { openCard(card); focusCardField("card-assignees"); }}
                onQuickComment={(card) => { openCard(card); setCardTab("activity"); }}
                onQuickDue={(card) => { openCard(card); focusCardField("card-due-at"); }}
              />}

              {/* O quadro por etapa continua sendo o que sempre foi, com o
                  arrasto que move de coluna. Ele não foi substituído: "em que
                  pé está" é uma pergunta legítima, só não é a primeira. */}
              {boardMode === "kanban" && (boardGroupBy === "none"
                ? renderKanban(boardLanes[0]?.cardsByList ?? new Map(), "todas", false)
                : <div className="board-lanes" data-density={boardDensity}>
                    {boardLanes.map((lane) => <details className="board-lane" key={lane.key} open>
                      <summary>
                        <ChevronRight aria-hidden="true" />
                        <strong>{lane.label}</strong>
                        <b>{lane.total}</b>
                      </summary>
                      {renderKanban(lane.cardsByList, lane.key, true)}
                    </details>)}
                    {boardLanes.length === 0 && <p className="dashboard-column-empty board-lanes-empty">Nenhuma demanda no recorte atual.</p>}
                  </div>
              )}
              {boardMode === "table" && <DemandTableView cards={filteredActiveCards} lists={snapshot.lists} areas={snapshot.areas} onOpen={openCard} />}
              {/* O calendário é o do #138: ele substituiu o `DemandCalendarView`
                  que existia aqui, e ressuscitar o antigo seria desfazer
                  trabalho que já está na main sem nada a ganhar. */}
              {boardMode === "calendar" && <DemandDeadlineView cards={filteredActiveCards} lists={snapshot.lists} onOpen={openCard} />}
              {boardMode === "process" && <ProcessTablesView cards={filteredActiveCards} lists={snapshot.lists} areas={snapshot.areas} onOpen={openCard} />}

              </div>

              {boardSelection.size > 0 && canEdit && <BulkBar
                count={boardSelection.size}
                members={snapshot.members}
                lists={snapshot.lists}
                busy={busy}
                onRun={(action) => void runBulkAction(action)}
                onClear={() => setBoardSelection(new Set())}
              />}
            </div>
          ))}

          {keepAlive("inbox", <InboxView items={snapshot.inbox} busy={busy} canEdit={canEdit} onConvert={convertInbox} onNew={() => setInboxModalOpen(true)} />)}
          {keepAlive("planner", <PlannerView cards={activeCards} blocks={snapshot.plannerBlocks} connections={snapshot.calendarConnections} onOpen={openCard} onCreateBlock={(payload) => mutate("/api/planner/blocks", { method: "POST", body: JSON.stringify(payload) }, "Bloco adicionado ao planner.")} onDeleteBlock={(id) => mutate(`/api/planner/blocks/${id}`, { method: "DELETE" }, "Bloco removido do planner.")} onSaveConnection={(payload) => mutate("/api/calendar/connections", { method: "POST", body: JSON.stringify(payload) }, "Calendário externo configurado. A sincronização será ativada após a conexão OAuth.")} />)}
          {keepAlive("payroll", <PayrollView companies={snapshot.companies} metrics={snapshot.hrMetrics} busy={busy} canEdit={canEdit} onSaveMetric={saveHrMetric} onImportPayroll={(body) => mutate("/api/hr-metrics/import/pdf", { method: "POST", body }, "Extrato da folha importado e painéis atualizados.")} />)}
          {keepAlive("indicators", <IndicatorsView canExportWorkspace={isAdmin} cards={scopedCards} companyId={companyFilter === "all" ? "" : companyFilter} scopeLabel={companyFilter === "all" ? companyScopeLabel : (snapshot.companies.find((item) => item.id === companyFilter)?.tradeName || snapshot.companies.find((item) => item.id === companyFilter)?.legalName || "Empresa selecionada")} rules={snapshot.rules} busy={busy} canManageRules={isAdmin} onToggleRule={toggleRule} onExport={exportCsv} hrMetrics={snapshot.hrMetrics} companies={snapshot.companies} />)}
          {/* O histórico completo (spec: "Ver histórico completo"). Carrega
              sob demanda, e não junto do snapshot: a trilha cresce sem limite,
              e trazê-la na abertura faria todo mundo pagar por uma tela que
              quase ninguém abre. */}
          {keepAlive("history", <HistoryView onOpenCard={(cardId) => {
            const card = allCards.find((item) => item.id === cardId);
            if (card) openCard(card);
          }} />)}
          </div>
          </>}</ProcessTabsProvider>
          </div>
        </div>
        {/* Barra de status (docs/engenharia-reversa-design-centi-sap.md §3.4).
            O que os ERPs de gestão pública deixam fixo no rodapé de toda tela:
            em que entidade, em que exercício e competência, com que usuário e
            em que data se está operando. Nenhum número acima dela se lê certo
            sem essas cinco coisas, e o topo só tem lugar para uma. */}
        <footer className="dashboard-statusbar" aria-label="Contexto da operação">
          <span><small>Sistema</small><strong>{erpMode ? "ERP DP" : pjMode ? "Sistema PJ" : "Vinculato"}</strong></span>
          <span className="statusbar-shrink"><small>Entidade</small><strong>{snapshot.workspace.name}</strong></span>
          <span className="statusbar-shrink"><small>Empresa</small><strong>{erpScopeLabel}</strong></span>
          <span><small>Exercício</small><strong className="statusbar-data">{currentCompetence.slice(0, 4)}</strong></span>
          <span><small>Competência</small><strong className="statusbar-data">{competenceLabel(currentCompetence)}</strong></span>
          <span className="statusbar-shrink"><small>Usuário</small><strong>{user.displayName} · {roleLabels[snapshot.workspace.role]}</strong></span>
          <span className="statusbar-end"><small>Data</small><strong className="statusbar-data">{todayShort}</strong></span>
          <span className={`statusbar-sync ${realtimeStatus}`} aria-live="off"><i aria-hidden="true" />{formatSyncStatus(lastUpdatedAt, realtimeStatus)}</span>
        </footer>
      </section>

      {/* Avisos no centro da tela, em vidro (CenterToast), iguais em todas as telas. */}
      <CenterToast message={error} tone="error" onClose={() => setError("")} />
      <CenterToast message={toast}
        action={undoAtual ? { label: "Desfazer", onClick: () => { const pendente = undoAtual; setUndo(null); setToast(""); pendente.run(); } } : undefined} />
      {/* O teto de favoritos precisa ser dito: sem o recado, marcar o nono
          simplesmente não faria nada, e a pessoa concluiria que o botão está
          quebrado. */}
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
            <header><div><span>Central de alertas</span><h2 id="notifications-title">Notificações</h2></div><button onClick={() => setNotificationsOpen(false)} aria-label="Fechar">×</button></header>
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
            <header><div><span>Histórico recuperável</span><h2 id="archive-title">Demandas arquivadas</h2></div><button onClick={() => setArchiveOpen(false)} aria-label="Fechar">×</button></header>
            <div className="archive-list">
              {archivedTotal > snapshot.archivedCards.length && <p className="archive-window-note" role="note">Mostrando as {snapshot.archivedCards.length} arquivadas mais recentes de {archivedTotal}. Para achar uma mais antiga, use a busca (⌘K): ela inclui as arquivadas.</p>}
              {snapshot.archivedCards.length === 0 && <div className="empty-view"><span>□</span><strong>Arquivo vazio</strong><p>Demandas arquivadas poderão ser restauradas por aqui.</p></div>}
              {[...snapshot.archivedCards].sort((a, b) => String(b.archivedAt ?? b.updatedAt).localeCompare(String(a.archivedAt ?? a.updatedAt))).map((card) => <article key={card.id}><i className={processColors[card.processType] ?? "gray"} /><div><span>{card.processType}</span><strong>{card.title}</strong><small>{card.company || "Sem empresa"} • arquivada em {formatDate(card.archivedAt ?? card.updatedAt)}</small></div><button disabled={busy || !canEdit} onClick={() => void restoreCard(card.id)}>Restaurar</button>{isAdmin && <button className="danger" disabled={busy} onClick={() => void deleteCardPermanently(card.id, card.title)}>Excluir</button>}</article>)}
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
            <header><div><span>{selectedCard ? `Demanda • ${selectedCard.processType}` : "Nova demanda"}{selectedCard && referenceLabel(selectedCard) && <b className="demand-reference">{referenceLabel(selectedCard)}</b>}{selectedCard?.cancelledAt && <b className="demand-cancelled" title={selectedCard.cancellationReason}>Cancelada</b>}{selectedCard?.withinCutoff === false && <b className="demand-cancelled" title="Chegou fora do prazo de corte: entra no próximo ciclo ou depende de aprovação da gestão.">Fora do corte</b>}</span><h2 id="card-modal-title">{selectedCard ? selectedCard.title : "Nova demanda"}</h2>{selectedCard && <p className="demand-detail-meta">{snapshot.lists.find((list) => list.id === selectedCard.listId)?.name ?? "Sem status"} • {selectedCard.company || "Sem empresa vinculada"} • {snapshot.areas.find((area) => area.id === selectedCard.requesterAreaId)?.name || "Sem área solicitante"} → {snapshot.areas.find((area) => area.id === selectedCard.responsibleAreaId)?.name || "Sem área responsável"}</p>}</div><button onClick={() => setCardModalOpen(false)} aria-label="Fechar">×</button></header>
            {selectedCard && <nav className="card-dialog-tabs" aria-label="Seções da demanda"><button className={cardTab === "details" ? "active" : ""} onClick={() => setCardTab("details")}>Detalhes</button><button className={cardTab === "process" ? "active" : ""} onClick={() => setCardTab("process")}>Processo</button><button className={cardTab === "checklist" ? "active" : ""} onClick={() => setCardTab("checklist")}>Checklist <b>{selectedCard.checklist.filter((item) => item.completed).length}/{selectedCard.checklist.length}</b></button><button className={cardTab === "attachments" ? "active" : ""} onClick={() => setCardTab("attachments")}>Anexos <b>{selectedCard.attachments.length}</b></button>{registrationFormAttachment(selectedCard) && <button className={cardTab === "sheet" ? "active" : ""} onClick={() => setCardTab("sheet")}>Ficha</button>}<button className={cardTab === "activity" ? "active" : ""} onClick={() => setCardTab("activity")}>Atividade <b>{selectedCard.comments.length + selectedCard.activities.length}</b></button></nav>}
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
                      <span>Progresso da demanda</span>
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
                    <div className="demand-document-state"><span>Documentos</span><strong>{feitos} aprovados</strong><small>{contagem(pendentes, "pendente", "pendentes")} • {contagem(selectedCard.attachments.length, "anexo", "anexos")}</small></div>
                  </section>
                </>;
              })()}
              {(!selectedCard || cardTab === "details") &&
              <form className={`card-form ${!canEdit ? "read-only" : ""}`} onSubmit={saveCard}>
                {!selectedCard && draftRestored && <p className="demand-draft-note full" role="status">
                  Rascunho recuperado: é o que estava sendo escrito antes de a janela fechar.
                  <button type="button" className="secondary-button" onClick={discardDraft}>Descartar rascunho</button>
                </p>}
                {/* PRÓXIMO PASSO — o primeiro bloco da gaveta, e não um campo
                    perdido no meio do formulário (§14).
                    A pergunta que alguém faz ao abrir uma demanda é "o que eu
                    faço agora", e ela era respondida lendo a descrição, o fio
                    de comentários e o checklist. Isso custa um minuto por
                    demanda e é feito dezenas de vezes por dia — e o custo dobra
                    quando a demanda é de outra pessoa.
                    O campo fica primeiro porque é o que muda entre uma abertura
                    e a seguinte: título, empresa e processo não mudam. */}
                {/* Na demanda nova o campo desce para depois da descrição: ainda
                    não há "o que mudou desde a última vez", e pedir o próximo
                    passo antes do título invertia a ordem de quem está criando. */}
                {selectedCard && <section className="demand-next-step full">
                  <header><span>Próximo passo</span></header>
                  <textarea
                    id="card-next-step"
                    rows={2}
                    maxLength={280}
                    value={cardForm.nextStep}
                    disabled={!canEdit}
                    placeholder="O que precisa acontecer agora? Ex.: receber o comprovante pendente e conferir o cadastro."
                    aria-label="Próximo passo da demanda"
                    onChange={(event) => setCardForm({ ...cardForm, nextStep: event.target.value })}
                  />
                </section>}
                {/* A leitura de SLA por extenso. O cartão mostra "1d de atraso";
                    aqui ficam a data exata, o que resta e o estado — as três
                    coisas que alguém confere antes de prometer um prazo ao
                    solicitante. */}
                {selectedCard && (() => {
                  const leitura = slaReading(selectedCard, boardNow);
                  return <section className="demand-sla-reading full" data-sla={selectedCard.slaStatus}>
                    <span><small>Prazo interno</small><strong>{leitura.deadline}</strong></span>
                    <span><small>Tempo restante</small><strong>{leitura.remaining}</strong></span>
                    <span><small>SLA</small><strong>{leitura.state}</strong></span>
                  </section>;
                })()}
                <fieldset className="card-form-section full"><legend>Dados da demanda</legend>
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
                      <option value="">Demanda avulsa (sem processo)</option>
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
                {!selectedCard && !cardForm.processVersionId && <label className="full">Começar com um template<select value={cardForm.templateId} onChange={(event) => { const template = snapshot.templates.find((item) => item.id === event.target.value); setCardForm({ ...cardForm, templateId: event.target.value, processType: template?.processType ?? cardForm.processType, description: template?.description ?? cardForm.description }); }}><option value="">Demanda em branco</option>{snapshot.templates.filter((item) => item.active).map((template) => <option value={template.id} key={template.id}>{template.name} • SLA {contagem(template.defaultSlaDays, "dia", "dias")} útil(eis)</option>)}</select></label>}
                {!selectedCard && <label className="full">Processo operacional<select value={cardForm.boardId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, boardId: event.target.value, listId: "" })}>{snapshot.boards.map((board) => <option value={board.id} key={board.id}>{board.boardType === "process" ? `Processo: ${board.name}` : `Quadro geral: ${board.name}`}</option>)}</select><small className="card-process-helper">A demanda será criada e movimentada somente nas colunas deste processo.</small></label>}
                <label className="full">Título da demanda<input autoFocus value={cardForm.title} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, title: event.target.value })} placeholder="Ex.: Conciliar colaborador com o ERP" required /></label>
                <label className="full">Descrição<textarea value={cardForm.description} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, description: event.target.value })} placeholder="Contexto e orientações para execução" rows={4} /></label>
                {!selectedCard && <label className="full">Próximo passo<textarea id="card-next-step" rows={2} maxLength={280} value={cardForm.nextStep} disabled={!canEdit}
                  placeholder="O que precisa acontecer agora? Ex.: receber o comprovante pendente e conferir o cadastro."
                  onChange={(event) => setCardForm({ ...cardForm, nextStep: event.target.value })} /></label>}
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
                </fieldset>
                <fieldset className="card-form-section full"><legend>Vínculos</legend>
                <label>Empresa<select value={cardForm.companyId} disabled={!canEdit} onChange={(event) => { const company = snapshot.companies.find((item) => item.id === event.target.value); setCardForm({ ...cardForm, companyId: event.target.value, company: company ? (company.tradeName || company.legalName) : cardForm.company }); }}><option value="">Sem empresa vinculada</option>{snapshot.companies.filter((company) => company.status === "active" || company.id === cardForm.companyId).map((company) => <option value={company.id} key={company.id}>{company.tradeName || company.legalName}{company.taxId ? ` • ${company.taxId}` : ""}{company.status !== "active" ? " (inativa)" : ""}</option>)}</select></label>
                {!selectedCard && <label>Colaborador<select value={cardForm.employeeId} disabled={!canEdit || employeeStartOptions === null} onChange={(event) => setCardForm({ ...cardForm, employeeId: event.target.value })}><option value="">{employeeStartOptions === null ? "Carregando..." : "Não informado"}</option>{(employeeStartOptions ?? []).filter((employee) => !cardForm.companyId || employee.company_id === cardForm.companyId).map((employee) => <option key={employee.id} value={employee.id}>{employee.social_name || employee.full_name} • {employee.registration_number}</option>)}</select></label>}
                {!selectedCard && <label>Solicitante<select value={cardForm.requesterUserId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, requesterUserId: event.target.value })}><option value="">Usuário atual</option>{snapshot.members.map((member) => <option key={member.userId} value={member.userId}>{member.name} • {member.email}</option>)}</select></label>}
                {!selectedCard && <label>Competência<input type="month" value={cardForm.competence} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, competence: event.target.value })} /></label>}
                </fieldset>
                <fieldset className="card-form-section full"><legend>Prazo e responsáveis</legend>
                <label>Área solicitante<select value={cardForm.requesterAreaId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, requesterAreaId: event.target.value })}><option value="">Não informada</option>{snapshot.areas.filter((area) => area.status === "active" || area.id === cardForm.requesterAreaId).map((area) => <option value={area.id} key={area.id}>{area.name} · {area.code}</option>)}</select></label>
                <label>Área responsável<select value={cardForm.responsibleAreaId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, responsibleAreaId: event.target.value })}><option value="">Não informada</option>{snapshot.areas.filter((area) => area.status === "active" || area.id === cardForm.responsibleAreaId).map((area) => <option value={area.id} key={area.id}>{area.name} · {area.code}</option>)}</select></label>
                {!selectedCard && !cardForm.processVersionId && <label>Data pedida<input id="card-requested-for" type="date" value={cardForm.requestedFor} disabled={!canEdit} title="Início da admissão, saída de férias, data da decisão ou do atestado: a regra de corte compara com ela." onChange={(event) => setCardForm({ ...cardForm, requestedFor: event.target.value })} /></label>}
                {selectedCard?.requestedFor && <p className="card-sla-target full">Data pedida: <strong>{selectedCard.requestedFor.split("-").reverse().join("/")}</strong>{selectedCard.withinCutoff === false ? " · chegou fora do prazo de corte: entra no próximo ciclo ou depende de aprovação da gestão." : selectedCard.withinCutoff ? " · dentro do prazo de corte." : ""}</p>}
                {!cardForm.processVersionId && <label>Prazo<input id="card-due-at" type="datetime-local" value={dueInputValue(cardForm.dueAt, snapshot.settings.dayEnd)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, dueAt: event.target.value })} /></label>}
                {selectedCard?.slaTargetMinutes ? <p className="card-sla-target full">SLA configurado: <strong>{formatWorkingMinutes(selectedCard.slaTargetMinutes)}</strong> de expediente. Pausas justificadas não entram na contagem.</p> : null}
                <label>Prioridade<select value={cardForm.priority} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, priority: event.target.value })}>{["low", "normal", "high", "urgent"].map((nivel) => <option key={nivel} value={nivel}>{PRIORITY_LABELS[nivel]}</option>)}</select></label>
                {!cardForm.processVersionId && <label>Coluna<select value={cardForm.listId} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, listId: event.target.value })}><option value="">Automática pelas regras</option>{snapshot.lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label>}
                <section className="card-choice-section full" id="card-assignees" tabIndex={-1}><header><strong>Responsáveis</strong><span>A carga de cada um aparece junto do nome</span></header><div className="choice-chips">{snapshot.members.filter((member) => canRespondForDemands(member) || (selectedCard?.assignees ?? []).some((assignee) => assignee.userId === member.userId)).map((member) => {
                  /* Quem já está com o quê, na hora de decidir para quem vai.
                     Atribuir às cegas é como a sobrecarga se forma: a pessoa
                     mais rápida recebe mais porque é a que vem à cabeça. O
                     número **não impede** a atribuição — a decisão continua
                     sendo de quem distribui; ele só deixa de ser tomada sem a
                     informação que já existia no quadro. */
                  const carga = assigneeLoad.get(member.name);
                  return <label className={cardForm.assigneeIds.includes(member.userId) ? "selected" : ""} key={member.userId}><input type="checkbox" checked={cardForm.assigneeIds.includes(member.userId)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, assigneeIds: event.target.checked ? [...cardForm.assigneeIds, member.userId] : cardForm.assigneeIds.filter((id) => id !== member.userId) })} /><i>{initials(member.name)}</i><b>{member.name}</b>{carga && <small className="choice-load">{carga.open} {carga.open === 1 ? "aberta" : "abertas"}{carga.overdue > 0 ? ` · ${carga.overdue} ${carga.overdue === 1 ? "atrasada" : "atrasadas"}` : ""}</small>}</label>;
                })}</div></section>
                </fieldset>
                <fieldset className="card-form-section full"><legend>Informações adicionais</legend>
                <section className="card-choice-section full"><header><strong>Etiquetas</strong><span>Classifique sem alterar o processo</span></header><div className="choice-chips label-choices">{snapshot.labels.map((label) => <label className={cardForm.labelIds.includes(label.id) ? "selected" : ""} style={{ borderColor: cardForm.labelIds.includes(label.id) ? label.color : undefined }} key={label.id}><input type="checkbox" checked={cardForm.labelIds.includes(label.id)} disabled={!canEdit} onChange={(event) => setCardForm({ ...cardForm, labelIds: event.target.checked ? [...cardForm.labelIds, label.id] : cardForm.labelIds.filter((id) => id !== label.id) })} /><i style={{ backgroundColor: label.color }} />{label.name}</label>)}</div></section>
                {snapshot.customFields.map((field) => <label key={field.id}>{field.name}{field.name.trim().toLocaleLowerCase("pt-BR") === "competência" && <small className="card-form-hint">Campo personalizado do grupo</small>}{field.fieldType === "select" ? <select value={cardForm.customValues[field.fieldKey] ?? ""} disabled={!canEdit} required={field.required} onChange={(event) => setCardForm({ ...cardForm, customValues: { ...cardForm.customValues, [field.fieldKey]: event.target.value } })}><option value="">Selecione</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select> : <input type={field.fieldType === "date" ? "date" : field.fieldType === "number" ? "number" : "text"} value={cardForm.customValues[field.fieldKey] ?? ""} disabled={!canEdit} required={field.required} onChange={(event) => setCardForm({ ...cardForm, customValues: { ...cardForm.customValues, [field.fieldKey]: event.target.value } })} />}</label>)}
                </fieldset>
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
                  <div><span>Checklist</span><strong>{selectedCard.checklist.filter((item) => item.completed).length}/{selectedCard.checklist.length}</strong></div>
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
                <header><div><span>Documentos</span><h3>Anexos da demanda</h3><p>PDF, imagem, TXT, CSV, DOCX ou XLSX, com até 20 MB.</p></div>{canEdit && !selectedCard.archived && <label className="upload-button">＋ Enviar arquivo<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.docx,.xlsx" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAttachment(file); event.target.value = ""; }} /></label>}</header>
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

              {selectedCard && cardTab === "sheet" && <section className="card-tab-panel">
                <RegistrationSheetPanel
                  key={selectedCard.id}
                  cardId={selectedCard.id}
                  canBuild={canEdit}
                  canRead={canReadAdmissionSheet}
                  archived={selectedCard.archived}
                  pdfUrl={registrationFormAttachment(selectedCard)?.downloadUrl ?? null}
                  /* Os demais documentos da pessoa vão junto, e não na outra aba.
                     A conferência é campo a campo contra o documento que o
                     sustenta: alternar de aba a cada campo é o que faz quem
                     transcreve parar de conferir depois do terceiro. */
                  documents={selectedCard.attachments
                    .filter((attachment) => attachment.id !== registrationFormAttachment(selectedCard)?.id)
                    .map((attachment) => ({
                      id: attachment.id, filename: attachment.filename, downloadUrl: attachment.downloadUrl,
                    }))}
                />
              </section>}
              {selectedCard && cardTab === "activity" && <section className="card-tab-panel activity-panel"><div className="card-collaboration"><header><span>Comentários</span><strong>{selectedCard.comments.length}</strong></header><div className="card-comments">{selectedCard.comments.length === 0 && <p className="card-empty-note">Nenhum comentário ainda.</p>}{selectedCard.comments.map((comment) => <article key={comment.id}><i>{initials(comment.authorName)}</i><div><strong>{comment.authorName}<time>{formatMoment(comment.createdAt)}</time></strong><p>{comment.body}</p>{selectedCard.attachments.filter((attachment) => attachment.commentId === comment.id).map((attachment) => <a key={attachment.id} href={attachment.downloadUrl} className="comment-attachment"><Paperclip aria-hidden="true" />{attachment.filename}</a>)}{(comment.authorEmail === user.email || isAdmin) && !selectedCard.archived && <div className="comment-actions"><button onClick={() => void editComment(comment.id, comment.body)}>Editar</button><button onClick={() => void deleteComment(comment.id)}>Excluir</button></div>}</div></article>)}</div>{canComment && !selectedCard.archived && <form className="comment-form" onSubmit={addComment}><textarea value={newComment} onChange={(event) => setNewComment(event.target.value)} placeholder="Escreva uma atualização para a equipe. Use @nome para mencionar alguém." rows={3} maxLength={2000} /><label className="upload-button">Anexar arquivo<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.docx,.xlsx" disabled={busy} onChange={(event) => setCommentAttachment(event.target.files?.[0] ?? null)} /></label>{commentAttachment ? <small>Arquivo: {commentAttachment.name}</small> : null}<button disabled={!newComment.trim() || busy}>Publicar comentário</button></form>}<header className="activity-heading"><span>Histórico da demanda</span><strong>{plural(selectedCard.activities.length, "evento", "eventos")}</strong></header><ol className="activity-list">{selectedCard.activities.slice(0, 20).map((activity) => { const details = activityDetails(activity); return <li key={activity.id}><i /><div><strong>{activity.actorName}</strong> {activityLabel(activity)}{details.length > 0 && <ul className="activity-change-list">{details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}<time>{formatMoment(activity.createdAt)}</time></div></li>; })}</ol></div></section>}
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
            <header><div><span>Pré-visualização segura</span><h2 id="attachment-preview-title">{attachmentPreview.filename}</h2></div><div className="attachment-preview-actions"><a href={attachmentPreview.downloadUrl}>Baixar</a><button onClick={() => setAttachmentPreview(null)} aria-label="Fechar">×</button></div></header>
            <div className="attachment-preview-content">
              {attachmentPreview.contentType.startsWith("image/") ? <Image src={`${attachmentPreview.downloadUrl}?disposition=inline`} alt={`Pré-visualização de ${attachmentPreview.filename}`} width={1600} height={1000} unoptimized /> : <iframe src={`${attachmentPreview.downloadUrl}?disposition=inline`} title={`Pré-visualização de ${attachmentPreview.filename}`} />}
            </div>
          </section>
        </div>
      )}

      {inboxModalOpen && (
        <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setInboxModalOpen(false); }}>
          <section className="workspace-modal inbox-modal" role="dialog" aria-modal="true" aria-labelledby="inbox-modal-title">
            <header><div><span>Captura manual</span><h2 id="inbox-modal-title">Nova solicitação</h2></div><button onClick={() => setInboxModalOpen(false)} aria-label="Fechar">×</button></header>
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

      {confirmation && (
        <div className="workspace-modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmation(null); }}>
          <section className="workspace-modal confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description">
            <header><div><span>Confirmação necessária</span><h2 id="confirmation-title">{confirmation.title}</h2></div><button onClick={() => setConfirmation(null)} aria-label="Fechar"><X aria-hidden="true" /></button></header>
            <div className="confirmation-body"><CircleAlert aria-hidden="true" /><p id="confirmation-description">{confirmation.description}</p></div>
            <footer><button type="button" className="secondary-button" onClick={() => setConfirmation(null)}>Cancelar</button><button type="button" className="danger-button" disabled={busy} onClick={() => void confirmPendingAction()}>{confirmation.confirmLabel}</button></footer>
          </section>
        </div>
      )}

      {/* Recolhido por padrão: um copiloto que ocupa espaço sem ter sido pedido
          atrapalha justamente quem já sabe o que fazer. */}
      <AssistantPanel screen={viewCatalog[view].label} openSignal={assistantSignal} />

      {moduleLauncher && <ModuleLauncher userName={user.displayName} workspaceName={snapshot.workspace.name}
        modules={launcherModules} theme={theme} onOpen={openLauncherModule}
        onClose={moduleLauncher === "switch" || launcherModules.length === 0 ? () => setModuleLauncher(null) : undefined} />}
    </main>
  );
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
/* PONTO, VARIÁVEIS, ALTERAÇÃO SALARIAL, AFASTAMENTO e ROTINA DP entram com o
   DP Operacional: são os tipos que as regras de corte e as rotinas usam. */
const processTypeOptions = ["CONCILIAÇÃO CADASTRAL", "RESCISÃO", "FÉRIAS", "PONTO", "VARIÁVEIS", "ALTERAÇÃO SALARIAL", "AFASTAMENTO", "BENEFÍCIOS", "FOLHA", "CADASTRO", "ROTINA DP", "OUTROS"];

function ProcessTablesView({ cards, lists, areas, onOpen }: { cards: Card[]; lists: WorkspaceSnapshot["lists"]; areas: WorkspaceSnapshot["areas"]; onOpen: (card: Card) => void }) {
  const grouped = cards.reduce<Record<string, Card[]>>((accumulator, card) => {
    (accumulator[card.processType] ??= []).push(card);
    return accumulator;
  }, {});
  const processNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
  return <div className="process-tables-view">{processNames.length === 0 && <div className="empty-view"><span>▤</span><strong>Nenhuma demanda encontrada</strong><p>Crie uma demanda para iniciar uma tabela de processo.</p></div>}{processNames.map((process) => <section key={process}><header><div><span>Fluxo específico</span><strong>{process}</strong></div><b>{contagem(grouped[process].length, "demanda", "demandas")}</b></header><DemandTableView cards={grouped[process]} lists={lists} areas={areas} onOpen={onOpen} /></section>)}</div>;
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
    <section className="catalog-section"><header><div><strong>Feriados e exceções</strong><span>{contagem(snapshot.holidays.length, "data", "datas")} fora do expediente.</span></div></header><div className="holiday-list">{snapshot.holidays.map((holiday) => <article key={holiday.date}><time>{formatDate(holiday.date, true)}</time><strong>{holiday.name}</strong>{isAdmin && <button onClick={() => void onCatalog({ resource: "holiday", operation: "delete", date: holiday.date }, "Feriado removido.")} disabled={busy}>×</button>}</article>)}</div>{isAdmin && <form className="catalog-form compact" onSubmit={addHoliday}><label>Data<input type="date" name="date" required /></label><label>Nome<input name="name" placeholder="Ex.: Feriado municipal" required /></label><button className="primary-button" disabled={busy}>Adicionar</button></form>}</section></div>;
}

function IndicatorsView({ cards, companyId, scopeLabel, rules, busy, canManageRules, canExportWorkspace, onToggleRule, onExport, hrMetrics, companies }: { cards: Card[]; companyId: string; scopeLabel: string; canExportWorkspace: boolean; rules: WorkspaceSnapshot["rules"]; busy: boolean; canManageRules: boolean; onToggleRule: (id: string, enabled: boolean) => Promise<void>; onExport: () => void; hrMetrics: WorkspaceSnapshot["hrMetrics"]; companies: WorkspaceSnapshot["companies"] }) {
  type ReportHrMetrics = {
    admissions: number; terminations: number; averageHeadcount: number;
    payrollCostTotal: number; turnoverRate: number; payrollByCompany: Record<string, number>;
  };
  /** Command Center, passo 1 (§4.19): saúde e conformidade, para quem não abre EPI/ASO/acidentes todo dia. */
  type ReportSafetyMetrics = {
    overdueExams: number; overdueTrainings: number; accidentsInPeriod: number; catPending: number; overdueObligations: number;
    epiComplianceRate: number | null;
  };
  type ReportSummary = {
    from: string; to: string; total: number; completed: number; completionRate: number;
    averageCompletionHours: number; activityCount: number; byProcess: Record<string, number>;
    hrMetrics?: ReportHrMetrics; safetyMetrics?: ReportSafetyMetrics;
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
      <section className="hr-indicators-panel"><header><div><strong>Indicadores do Departamento Pessoal</strong><span>Turnover e custo da folha por competência · {scopeLabel}</span></div><b>{(report?.hrMetrics?.turnoverRate ?? 0).toFixed(2)}%</b></header><div className="hr-indicator-grid"><article><strong>{report?.hrMetrics?.turnoverRate?.toFixed(2) ?? "0,00"}%</strong><span>Turnover</span></article><article><strong>{report?.hrMetrics?.averageHeadcount ?? 0}</strong><span>Headcount médio</span></article><article><strong>{report?.hrMetrics?.admissions ?? 0}</strong><span>Admissões</span></article><article><strong>{report?.hrMetrics?.terminations ?? 0}</strong><span>Desligamentos</span></article><article><strong>{(report?.hrMetrics?.payrollCostTotal ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong><span>Custo da folha</span></article></div><div className="hr-indicator-note">{hrMetrics.length ? `${contagem(hrMetrics.length, "competência cadastrada", "competências cadastradas")} em ${contagem(companies.length, "empresa", "empresas")}.` : "Cadastre empresas e competências para calcular os indicadores."}</div></section>
      {/* Command Center, passo 1 (§4.19): a diretoria não abre EPI, ASO ou o
          painel de acidentes todo dia — este é o resumo que ela vê sem entrar
          em nenhum dos três. Não substitui os módulos: cada número aqui já
          existe em algum deles, apenas juntos num lugar que não exige saber
          onde procurar. */}
      <section className="safety-indicators-panel"><header><div><strong>Saúde e conformidade</strong><span>SST, ASO e obrigações legais no grupo · {scopeLabel}</span></div><HardHat aria-hidden="true" /></header><div className="hr-indicator-grid"><article><strong>{report?.safetyMetrics?.overdueExams ?? 0}</strong><span>Exames (ASO) vencidos</span></article><article><strong>{report?.safetyMetrics?.overdueTrainings ?? 0}</strong><span>Treinamentos vencidos</span></article><article><strong>{report?.safetyMetrics?.accidentsInPeriod ?? 0}</strong><span>Acidentes no período</span></article><article><strong>{report?.safetyMetrics?.catPending ?? 0}</strong><span>CAT pendente</span></article><article><strong>{report?.safetyMetrics?.overdueObligations ?? 0}</strong><span>Obrigações legais vencidas</span></article><article><strong>{report?.safetyMetrics?.epiComplianceRate == null ? "—" : `${report.safetyMetrics.epiComplianceRate}%`}</strong><span>Conformidade de EPI</span></article></div></section>
      <section className="metrics-panel"><header><div><strong>Volume por processo</strong><span>{contagem(cards.length, "demanda", "demandas")} · {scopeLabel}</span></div><div className="export-actions">
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
