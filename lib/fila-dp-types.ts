export type ChecklistItem = {
  id: string;
  cardId: string;
  title: string;
  completed: boolean;
  position: number;
  completedAt: string | null;
};

export type WorkspaceRole = "admin" | "member" | "observer" | "guest";

export type CardComment = {
  id: string;
  cardId: string;
  authorName: string;
  authorEmail: string;
  body: string;
  createdAt: string;
};

export type ActivityEvent = {
  id: string;
  cardId: string | null;
  actorEmail: string;
  actorName: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type CardAssignee = { userId: string; name: string; email: string };
export type CardLabel = { id: string; name: string; color: string };
export type CardAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
  downloadUrl: string;
};

export type CustomFieldDefinition = {
  id: string;
  name: string;
  fieldKey: string;
  fieldType: "text" | "number" | "date" | "select";
  options: string[];
  required: boolean;
  position: number;
};

export type ProcessTemplate = {
  id: string;
  name: string;
  processType: string;
  description: string;
  checklist: string[];
  defaultSlaDays: number;
  active: boolean;
  position: number;
};

export type SlaPolicy = {
  id: string;
  processType: string;
  targetBusinessDays: number;
  warningBusinessDays: number;
  active: boolean;
};

export type BusinessHoliday = { date: string; name: string };
export type WorkspaceSettings = {
  businessDays: number[];
  dayStart: string;
  dayEnd: string;
  realtimeSeconds: number;
};

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  cardId: string | null;
  readAt: string | null;
  createdAt: string;
};

export type IntegrationItem = {
  id: string;
  channel: string;
  displayName: string;
  status: "connected" | "needs_credentials" | "paused" | "error";
  config: Record<string, unknown>;
  lastSyncAt: string | null;
  lastError: string | null;
};
export type PlannerBlock = { id: string; userId: string; cardId: string | null; title: string; startAt: string; endAt: string; blockType: string; notes: string };
export type CalendarConnection = { id: string; provider: string; status: string; config: Record<string, unknown>; externalCalendarId: string | null; lastSyncAt: string | null; lastError: string | null };

export type Company = {
  id: string;
  parentCompanyId: string | null;
  isPrincipal: boolean;
  legalName: string;
  tradeName: string;
  taxId: string;
  externalCode: string;
  email: string;
  phone: string;
  status: "active" | "inactive";
};

export type HrMetric = {
  id: string;
  companyId: string;
  period: string;
  headcount: number;
  headcountStart: number;
  headcountEnd: number;
  leavesCount: number;
  admissions: number;
  terminations: number;
  voluntaryTerminations: number;
  involuntaryTerminations: number;
  baseSalary: number;
  variablePay: number;
  overtimePay: number;
  additionalPay: number;
  vacationPay: number;
  thirteenthPay: number;
  terminationPay: number;
  grossPayroll: number;
  employeeInss: number;
  employeeIrrf: number;
  employeeOtherDeductions: number;
  netPay: number;
  employerInss: number;
  ratContribution: number;
  thirdPartyContributions: number;
  fgts: number;
  fgtsPenalty: number;
  employerCharges: number;
  benefitsCost: number;
  provisionsCost: number;
  otherCosts: number;
  payrollCost: number;
  source: string;
  externalId: string;
  notes: string;
};

export type Card = {
  id: string;
  boardId: string;
  listId: string;
  title: string;
  description: string;
  companyId: string | null;
  company: string;
  requesterAreaId: string | null;
  responsibleAreaId: string | null;
  processType: string;
  priority: "low" | "normal" | "high" | "urgent";
  assigneeName: string;
  dueAt: string | null;
  slaStatus: "safe" | "warning" | "overdue" | "paused" | "completed";
  position: number;
  sourceType: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  checklist: ChecklistItem[];
  comments: CardComment[];
  activities: ActivityEvent[];
  assignees: CardAssignee[];
  labels: CardLabel[];
  customValues: Record<string, string>;
  attachments: CardAttachment[];
  slaPausedReason: string;
  slaTargetMinutes: number;
  slaPausedMinutes: number;
  slaEscalationLevel: number;
  competence: string;
  legalDueAt: string | null;
  processTemplateId: string | null;
  closedAt: string | null;
};

export type OperationalArea = {
  id: string; name: string; code: string; description: string; status: string;
  managerUserId: string | null; color: string; icon: string; defaultSlaDays: number;
  membersCount: number; moduleKeys: string[];
};

export type BoardList = {
  id: string;
  boardId: string;
  name: string;
  kind: string;
  position: number;
  slaBehavior: "running" | "paused" | "completed";
  cards: Card[];
};

export type BoardSummary = {
  id: string;
  name: string;
  description: string;
  boardType: string;
  stages: Array<{ id: string; name: string; kind: string; slaBehavior: "running" | "paused" | "completed" }>;
};

export type InboxItem = {
  id: string;
  channel: string;
  senderName: string;
  subject: string;
  body: string;
  status: string;
  receivedAt: string;
  convertedCardId: string | null;
};

export type AutomationRule = {
  id: string;
  name: string;
  trigger: string;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
  position: number;
};

export type WorkspaceMember = {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  joinedAt: string;
  isOwner: boolean;
  isActivated: boolean;
  companyIds: string[];
  /** Departamento principal no Workspace; dá os módulos padrão da pessoa. */
  departmentId: string | null;
  departmentName: string;
};

export type AvailableWorkspace = {
  id: string;
  name: string;
  role: WorkspaceRole;
  /** Ciclo de vida do workspace: só `active` é contexto operacional. */
  status: string;
  statusReason: string;
  isOwner: boolean;
  operational: boolean;
};

export type WorkspaceSnapshot = {
  workspace: { id: string; name: string; timezone: string; role: WorkspaceRole; companyScope: "all" | "restricted" };
  /** Catálogo resolvido: liberados e bloqueados, cada um com o motivo. */
  modules: {
    key: string; name: string; description: string; category: string; route: string;
    allowed: boolean; reason: string; message: string; upgradeable: boolean; position: number;
  }[];
  board: { id: string; name: string; description: string };
  boards: BoardSummary[];
  lists: BoardList[];
  inbox: InboxItem[];
  rules: AutomationRule[];
  members: WorkspaceMember[];
  availableWorkspaces: AvailableWorkspace[];
  /** Grupo que deixou de operar e provocou a troca automática de contexto. */
  switchedFrom: { id: string; name: string; status: string } | null;
  archivedCards: Card[];
  labels: CardLabel[];
  customFields: CustomFieldDefinition[];
  templates: ProcessTemplate[];
  slaPolicies: SlaPolicy[];
  holidays: BusinessHoliday[];
  settings: WorkspaceSettings;
  notifications: NotificationItem[];
  integrations: IntegrationItem[];
  plannerBlocks: PlannerBlock[];
  calendarConnections: CalendarConnection[];
  companies: Company[];
  areas: OperationalArea[];
  hrMetrics: HrMetric[];
  recentActivity: ActivityEvent[];
  /**
   * Ciclos de folha da competência mais recente do grupo.
   *
   * O fechamento é o fato mais estruturante do DP: a operação inteira é
   * cíclica e a interface não dizia isso em lugar nenhum. Vem no mesmo lote do
   * snapshot — uma consulta a mais, nenhuma ida extra ao banco.
   */
  payrollCycles: PayrollCycleSummary[];
  /**
   * Janela do histórico carregado (§39).
   *
   * O snapshot de abertura traz uma janela de comentários, caixa de entrada e
   * atividade — não o histórico inteiro. `total` existe para que a interface
   * possa dizer que há mais: janela sem aviso vira "o sistema perdeu meus
   * dados".
   */
  history: {
    windowDays: number;
    comments: { loaded: number; total: number };
    inbox: { loaded: number; total: number };
    activity: { loaded: number; total: number };
  };
};

/** Um ciclo de folha, do jeito que a Visão geral precisa dele. */
export type PayrollCycleSummary = {
  id: string;
  companyId: string;
  competence: string;
  /** `open` | `pre_closing` | `processing` | `post_closing` | `closed`. */
  status: string;
  closedAt: string | null;
};
