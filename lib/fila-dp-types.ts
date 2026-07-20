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
  createdAt: string;
  updatedAt: string;
  checklist: ChecklistItem[];
  comments: CardComment[];
  activities: ActivityEvent[];
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
  lists: BoardList[];
  inbox: InboxItem[];
  rules: AutomationRule[];
  members: WorkspaceMember[];
  availableWorkspaces: AvailableWorkspace[];
};
