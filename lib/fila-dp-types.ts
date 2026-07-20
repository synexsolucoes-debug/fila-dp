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

export type Card = {
  id: string;
  boardId: string;
  listId: string;
  title: string;
  description: string;
  company: string;
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
  slaPausedMinutes: number;
  slaEscalationLevel: number;
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

export type BoardSummary = { id: string; name: string; description: string; boardType: string };

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
};

export type AvailableWorkspace = {
  id: string;
  name: string;
  role: WorkspaceRole;
};

export type WorkspaceSnapshot = {
  workspace: { id: string; name: string; timezone: string; role: WorkspaceRole };
  board: { id: string; name: string; description: string };
  boards: BoardSummary[];
  lists: BoardList[];
  inbox: InboxItem[];
  rules: AutomationRule[];
  members: WorkspaceMember[];
  availableWorkspaces: AvailableWorkspace[];
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
  recentActivity: ActivityEvent[];
};
