/**
 * Tipos das três centrais operacionais (§3, §13, §20).
 *
 * Espelham o que as rotas devolvem, e nada além. Um campo aqui que a rota não
 * envia vira `undefined` em produção e uma tela que mostra "—" sem motivo —
 * então tudo o que existe neste arquivo existe na resposta.
 */

export type WorkTone = "critical" | "warning" | "neutral";

export type WorkItem = {
  id: string;
  sourceType: string;
  sourceId: string;
  title: string;
  description: string;
  status: string;
  statusLabel: string;
  priority: string;
  priorityLabel: string;
  companyId: string;
  companyName: string;
  employeeId: string;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  processId: string;
  processStep: string;
  origin: string;
  originLabel: string;
  blockedReason: string;
  nextAction: string;
  href: string;
  tone: WorkTone;
};

export type WorkCounts = {
  total: number;
  overdue: number;
  today: number;
  blocked: number;
  awaitingApproval: number;
  triage: number;
  failures: number;
};

export type WorkOption = { key: string; label: string };

export type WorkPayload = {
  scope: string;
  sort: string;
  group: string;
  items: WorkItem[];
  nextCursor: string;
  counts: WorkCounts;
  groups: Array<{ key: string; total: number }>;
  sources: WorkOption[];
  unavailable: Array<{ key: string; label: string; reason: string }>;
  options: { sorts: WorkOption[]; groups: WorkOption[]; dueWindows: WorkOption[] };
};

/* -------------------------------------------------------------------------- *
 * Triagem
 * -------------------------------------------------------------------------- */

export type TriageField = { label: string; value: string };

export type TriageItem = {
  id: string;
  source: "agent_proposal" | "movement_suggestion";
  sourceId: string;
  origin: string;
  originLabel: string;
  eventName: string;
  title: string;
  proposal: string;
  status: string;
  confidence: { level: string; label: string; tone: string; percent: number; detail: string };
  uncertainty: { title: string; action: string };
  likely: {
    employeeId: string; employeeName: string;
    companyId: string; companyName: string;
    processId: string; processStep: string;
  };
  fields: TriageField[];
  evidenceIds: string[];
  resolveHref: string;
  createdAt: string;
  resolution: {
    decidedBy: string; decidedAt: string; decision: string; note: string;
    resultType: string; resultId: string; failure: string;
  } | null;
};

export type TriagePayload = {
  items: TriageItem[];
  counts: { pendingTriage: number; suggested: number; mine: number; movements: number; total: number };
  nextCursor: string;
  permissions: { resolve: boolean; confirmMovement: boolean };
};

/* -------------------------------------------------------------------------- *
 * Agentes
 * -------------------------------------------------------------------------- */

export type AgentStatus = {
  /** Chave de produto (`tangerino_agent`…). O canal interno não chega à tela. */
  key: string;
  integrationId: string;
  /** "Agente Tangerino". Nunca o nome do canal. */
  displayName: string;
  summary: string;
  kind: "agent" | "channel";
  /** Estado em português, com o que ele significa (§10). */
  state: { key: string; label: string; detail: string };
  /** Os passos do setup deste agente, na ordem (§11, §12, §13). */
  steps: string[];
  /** Onde o acesso é preparado, e por quê quando não é aqui (§21). */
  setup: { by: string; note: string };
  supportsSchedule: boolean;
  canRunNow: boolean;
  connectorVersion: string;
  status: string;
  enabled: boolean;
  health: string;
  healthLabel: string;
  healthTone: "critical" | "warning" | "neutral" | "positive";
  healthDetail: string;
  lastError: string | null;
  schedule: {
    enabled: boolean; cadence: string; cadenceLabel: string; timeZone: string;
    nextRunAt: string | null; consecutiveFailures: number; degradedSince: string | null;
  };
  runs: {
    total: number; failed: number; succeeded: number;
    lastAt: string | null; lastStatus: string; lastSuccessAt: string | null;
    lastDurationMs: number | null; averageDurationMs: number | null;
    received: number; processed: number; skipped: number; failedItems: number;
  };
  queue: { active: number; deadLetter: number };
  events: { received: number; processed: number; ignored: number; failed: number; deduplicated: number };
  proposals: { pendingTriage: number; suggested: number; applied: number; rejected: number };
};

/**
 * Saúde do worker do Windows, separada da saúde do agendamento.
 *
 * As duas respondem perguntas diferentes e apontam para pessoas diferentes: um
 * worker impecável não recebe tarefa se a varredura do servidor parou, e um
 * agendamento em dia não consulta nada com o computador do DP desligado.
 */
export type WorkerAvailability = "online" | "stale" | "never_seen" | "needs_authentication";

export type AgentWorkerHealth = {
  availability: WorkerAvailability;
  detail: string;
  secondsSinceLastSeen: number | null;
  pendingConsultations: number;
  pendingAttachments: number;
  heartbeat: {
    workerId: string;
    workerVersion: string;
    lastSeenAt: string;
    lastConsultationAt: string | null;
    lastErrorCode: string;
  } | null;
};

export type AgentScheduleHealth = {
  configured: boolean;
  scheduleEnabled: boolean;
  overdue: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  detail: string;
};

export type AgentsPayload = {
  agents: AgentStatus[];
  worker: AgentWorkerHealth | null;
  schedule: AgentScheduleHealth | null;
  cadences: Array<{ key: string; label: string; description: string; intervalMinutes: number; businessHoursOnly: boolean }>;
  automation: { policy: string; label: string };
  permissions: { manage: boolean; execute: boolean; reprocess: boolean; viewLogs: boolean; resolveTriage: boolean };
};

export type AgentRun = {
  id: string;
  trigger: string;
  status: string;
  attempt: number;
  received: number;
  processed: number;
  skipped: number;
  conflict: number;
  failed: number;
  durationMs: number;
  summary: string;
  errorCode: string;
  errorMessage: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  logLines: number;
  jobStatus: string;
  jobId: string;
  reprocessable: boolean;
};

export type AgentLogLine = {
  sequence: number;
  level: string;
  phase: string;
  code: string;
  message: string;
  metadata: Record<string, unknown>;
  at: string;
};
