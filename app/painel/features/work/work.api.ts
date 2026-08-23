import type {
  AgentLogLine, AgentRun, AgentsPayload, AgentStatus, TriageItem, TriagePayload,
  WorkCounts, WorkItem, WorkPayload,
} from "./work.types";

type Row = Record<string, unknown>;

const text = (value: unknown) => (value == null ? "" : String(value));
const number = (value: unknown) => Number(value) || 0;
const bool = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";
const rows = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object") : []);

/**
 * Uma chamada, um erro legível (§56).
 *
 * A rota já devolve frase pronta em `message`; o que não pode acontecer é a tela
 * mostrar "Failed to fetch" quando o servidor explicou o problema. O fallback
 * genérico é a última linha, e não a primeira.
 */
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.message || payload.error || "Não foi possível concluir a operação.");
  return payload;
}

const option = (row: Row) => ({ key: text(row.key), label: text(row.label) });

export function normalizeWorkItem(row: Row): WorkItem {
  const tone = text(row.tone);
  return {
    id: text(row.id),
    sourceType: text(row.sourceType),
    sourceId: text(row.sourceId),
    title: text(row.title),
    description: text(row.description),
    status: text(row.status),
    statusLabel: text(row.statusLabel),
    priority: text(row.priority),
    priorityLabel: text(row.priorityLabel),
    companyId: text(row.companyId),
    companyName: text(row.companyName),
    employeeId: text(row.employeeId),
    dueAt: text(row.dueAt),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
    processId: text(row.processId),
    processStep: text(row.processStep),
    origin: text(row.origin),
    originLabel: text(row.originLabel),
    blockedReason: text(row.blockedReason),
    nextAction: text(row.nextAction),
    href: text(row.href),
    tone: tone === "critical" || tone === "warning" ? tone : "neutral",
  };
}

const emptyCounts: WorkCounts = {
  total: 0, overdue: 0, today: 0, blocked: 0, awaitingApproval: 0, triage: 0, failures: 0,
};

export function normalizeWorkPayload(payload: Row): WorkPayload {
  const counts = (payload.counts ?? {}) as Row;
  const options = (payload.options ?? {}) as Row;
  return {
    scope: text(payload.scope) || "meu",
    sort: text(payload.sort) || "urgency",
    group: text(payload.group),
    items: rows(payload.items).map(normalizeWorkItem),
    nextCursor: text(payload.nextCursor),
    counts: {
      ...emptyCounts,
      total: number(counts.total),
      overdue: number(counts.overdue),
      today: number(counts.today),
      blocked: number(counts.blocked),
      awaitingApproval: number(counts.awaitingApproval),
      triage: number(counts.triage),
      failures: number(counts.failures),
    },
    groups: rows(payload.groups).map((row) => ({ key: text(row.key), total: number(row.total) })),
    sources: rows(payload.sources).map(option),
    unavailable: rows(payload.unavailable).map((row) => ({
      key: text(row.key), label: text(row.label), reason: text(row.reason),
    })),
    options: {
      sorts: rows(options.sorts).map(option),
      groups: rows(options.groups).map(option),
      dueWindows: rows(options.dueWindows).map(option),
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Triagem
 * -------------------------------------------------------------------------- */

export function normalizeTriageItem(row: Row): TriageItem {
  const confidence = (row.confidence ?? {}) as Row;
  const uncertainty = (row.uncertainty ?? {}) as Row;
  const likely = (row.likely ?? {}) as Row;
  const resolution = row.resolution && typeof row.resolution === "object" ? row.resolution as Row : null;
  return {
    id: text(row.id),
    source: text(row.source) === "movement_suggestion" ? "movement_suggestion" : "agent_proposal",
    sourceId: text(row.sourceId),
    origin: text(row.origin),
    originLabel: text(row.originLabel),
    eventName: text(row.eventName),
    title: text(row.title),
    proposal: text(row.proposal),
    status: text(row.status),
    confidence: {
      level: text(confidence.level) || "baixa",
      label: text(confidence.label) || "Baixa",
      tone: text(confidence.tone) || "critical",
      percent: number(confidence.percent),
      detail: text(confidence.detail),
    },
    uncertainty: { title: text(uncertainty.title), action: text(uncertainty.action) },
    likely: {
      employeeId: text(likely.employeeId), employeeName: text(likely.employeeName),
      companyId: text(likely.companyId), companyName: text(likely.companyName),
      processId: text(likely.processId), processStep: text(likely.processStep),
    },
    fields: rows(row.fields).map((field) => ({ label: text(field.label), value: text(field.value) })),
    evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds.map(text) : [],
    resolveHref: text(row.resolveHref),
    createdAt: text(row.createdAt),
    resolution: resolution ? {
      decidedBy: text(resolution.decidedBy), decidedAt: text(resolution.decidedAt),
      decision: text(resolution.decision), note: text(resolution.note),
      resultType: text(resolution.resultType), resultId: text(resolution.resultId),
      failure: text(resolution.failure),
    } : null,
  };
}

export function normalizeTriagePayload(payload: Row): TriagePayload {
  const counts = (payload.counts ?? {}) as Row;
  const permissions = (payload.permissions ?? {}) as Row;
  return {
    items: rows(payload.items).map(normalizeTriageItem),
    counts: {
      pendingTriage: number(counts.pendingTriage),
      suggested: number(counts.suggested),
      mine: number(counts.mine),
      movements: number(counts.movements),
      total: number(counts.total),
    },
    nextCursor: text(payload.nextCursor),
    permissions: { resolve: bool(permissions.resolve), confirmMovement: bool(permissions.confirmMovement) },
  };
}

/* -------------------------------------------------------------------------- *
 * Agentes
 * -------------------------------------------------------------------------- */

export function normalizeAgent(row: Row): AgentStatus {
  const schedule = (row.schedule ?? {}) as Row;
  const runs = (row.runs ?? {}) as Row;
  const queue = (row.queue ?? {}) as Row;
  const events = (row.events ?? {}) as Row;
  const proposals = (row.proposals ?? {}) as Row;
  const tone = text(row.healthTone);
  const state = (row.state ?? {}) as Row;
  return {
    key: text(row.key),
    integrationId: text(row.integrationId),
    displayName: text(row.displayName),
    summary: text(row.summary),
    kind: text(row.kind) === "channel" ? "channel" : "agent",
    state: {
      key: text(state.key) || "not_configured",
      label: text(state.label) || "Não configurado",
      detail: text(state.detail),
    },
    // `rows` só deixa passar objeto; os passos são texto puro.
    steps: (Array.isArray(row.steps) ? row.steps : []).map((step) => text(step)).filter(Boolean),
    setup: {
      by: text((row.setup as Row | undefined)?.by) || "workspace",
      note: text((row.setup as Row | undefined)?.note),
    },
    supportsSchedule: bool(row.supportsSchedule),
    canRunNow: bool(row.canRunNow),
    connectorVersion: text(row.connectorVersion),
    status: text(row.status),
    enabled: bool(row.enabled),
    health: text(row.health),
    healthLabel: text(row.healthLabel),
    healthTone: tone === "critical" || tone === "warning" || tone === "positive" ? tone : "neutral",
    healthDetail: text(row.healthDetail),
    lastError: text(row.lastError) || null,
    schedule: {
      enabled: bool(schedule.enabled),
      cadence: text(schedule.cadence) || "manual",
      cadenceLabel: text(schedule.cadenceLabel),
      timeZone: text(schedule.timeZone),
      nextRunAt: text(schedule.nextRunAt) || null,
      consecutiveFailures: number(schedule.consecutiveFailures),
      degradedSince: text(schedule.degradedSince) || null,
    },
    runs: {
      total: number(runs.total), failed: number(runs.failed), succeeded: number(runs.succeeded),
      lastAt: text(runs.lastAt) || null, lastStatus: text(runs.lastStatus),
      lastSuccessAt: text(runs.lastSuccessAt) || null,
      lastDurationMs: runs.lastDurationMs == null ? null : number(runs.lastDurationMs),
      averageDurationMs: runs.averageDurationMs == null ? null : number(runs.averageDurationMs),
      received: number(runs.received), processed: number(runs.processed),
      skipped: number(runs.skipped), failedItems: number(runs.failedItems),
    },
    queue: { active: number(queue.active), deadLetter: number(queue.deadLetter) },
    events: {
      received: number(events.received), processed: number(events.processed),
      ignored: number(events.ignored), failed: number(events.failed),
      deduplicated: number(events.deduplicated),
    },
    proposals: {
      pendingTriage: number(proposals.pendingTriage), suggested: number(proposals.suggested),
      applied: number(proposals.applied), rejected: number(proposals.rejected),
    },
  };
}

export function normalizeAgentsPayload(payload: Row): AgentsPayload {
  const automation = (payload.automation ?? {}) as Row;
  const permissions = (payload.permissions ?? {}) as Row;
  return {
    agents: rows(payload.agents).map(normalizeAgent),
    cadences: rows(payload.cadences).map((row) => ({
      key: text(row.key), label: text(row.label), description: text(row.description),
      intervalMinutes: number(row.intervalMinutes), businessHoursOnly: bool(row.businessHoursOnly),
    })),
    automation: { policy: text(automation.policy) || "suggest_only", label: text(automation.label) },
    permissions: {
      manage: bool(permissions.manage), execute: bool(permissions.execute),
      reprocess: bool(permissions.reprocess), viewLogs: bool(permissions.viewLogs),
      resolveTriage: bool(permissions.resolveTriage),
    },
  };
}

export function normalizeAgentRun(row: Row): AgentRun {
  return {
    id: text(row.id), trigger: text(row.trigger), status: text(row.status),
    attempt: number(row.attempt), received: number(row.received), processed: number(row.processed),
    skipped: number(row.skipped), conflict: number(row.conflict), failed: number(row.failed),
    durationMs: number(row.durationMs), summary: text(row.summary),
    errorCode: text(row.errorCode), errorMessage: text(row.errorMessage),
    startedAt: text(row.startedAt) || null, completedAt: text(row.completedAt) || null,
    createdAt: text(row.createdAt), logLines: number(row.logLines),
    jobStatus: text(row.jobStatus), jobId: text(row.jobId), reprocessable: bool(row.reprocessable),
  };
}

export function normalizeAgentLog(row: Row): AgentLogLine {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
  return {
    sequence: number(row.sequence), level: text(row.level) || "info", phase: text(row.phase),
    code: text(row.code), message: text(row.message), metadata, at: text(row.at),
  };
}

/* -------------------------------------------------------------------------- *
 * Formatação compartilhada
 * -------------------------------------------------------------------------- */

const DATE = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });
const DATE_TIME = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(value.length <= 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : DATE.format(date);
}

export function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DATE_TIME.format(date);
}

/** Prazo em linguagem de quem opera: "venceu ontem" diz mais que uma data. */
export function dueLabel(value: string, today = new Date()) {
  if (!value) return "Sem prazo";
  const due = new Date(value.length <= 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(due.getTime())) return value;
  const days = Math.round((due.setHours(12, 0, 0, 0) - new Date(today).setHours(12, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Vence hoje";
  if (days === 1) return "Vence amanhã";
  if (days === -1) return "Venceu ontem";
  if (days < 0) return `Venceu há ${Math.abs(days)} dias`;
  if (days <= 7) return `Vence em ${days} dias`;
  return formatDate(value);
}

export function formatDuration(ms: number | null) {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
