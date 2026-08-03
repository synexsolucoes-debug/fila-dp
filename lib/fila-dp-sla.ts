export type SlaCalendar = {
  businessDays: number[];
  holidays: Set<string>;
  dayStart: string;
  dayEnd: string;
  timezone: string;
};

function clockToMinutes(value: string, fallback: number) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return hour * 60 + minute;
}

function asDate(value: string | Date) {
  if (value instanceof Date) return value;
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return { year, month, day, minute: Number(parts.hour) * 60 + Number(parts.minute), key: `${parts.year}-${parts.month}-${parts.day}` };
}

export function zonedDateKey(value: string | Date, timezone: string) {
  const date = asDate(value);
  return date ? zonedParts(date, timezone).key : "";
}

export function workingDayMinutes(calendar: Pick<SlaCalendar, "dayStart" | "dayEnd">) {
  return Math.max(1, clockToMinutes(calendar.dayEnd, 18 * 60) - clockToMinutes(calendar.dayStart, 8 * 60));
}

export function businessMinutesBetween(startValue: string | Date, endValue: string | Date, calendar: SlaCalendar) {
  const start = asDate(startValue);
  const end = asDate(endValue);
  if (!start || !end || end <= start) return 0;
  const startPart = zonedParts(start, calendar.timezone);
  const endPart = zonedParts(end, calendar.timezone);
  const dayStart = clockToMinutes(calendar.dayStart, 8 * 60);
  const dayEnd = clockToMinutes(calendar.dayEnd, 18 * 60);
  if (dayEnd <= dayStart) return 0;

  const cursor = new Date(Date.UTC(startPart.year, startPart.month - 1, startPart.day));
  const last = new Date(Date.UTC(endPart.year, endPart.month - 1, endPart.day));
  let total = 0;
  while (cursor <= last) {
    const key = cursor.toISOString().slice(0, 10);
    if (calendar.businessDays.includes(cursor.getUTCDay()) && !calendar.holidays.has(key)) {
      const from = key === startPart.key ? Math.max(dayStart, startPart.minute) : dayStart;
      const to = key === endPart.key ? Math.min(dayEnd, endPart.minute) : dayEnd;
      total += Math.max(0, to - from);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return total;
}

export function businessDaysUntil(fromValue: string | Date, toValue: string | Date, calendar: SlaCalendar) {
  const fromKey = zonedDateKey(fromValue, calendar.timezone);
  const toKey = typeof toValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(toValue) ? toValue : zonedDateKey(toValue, calendar.timezone);
  if (!fromKey || !toKey) return 0;
  const cursor = new Date(`${fromKey}T00:00:00Z`);
  const end = new Date(`${toKey}T00:00:00Z`);
  let count = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const key = cursor.toISOString().slice(0, 10);
    if (calendar.businessDays.includes(cursor.getUTCDay()) && !calendar.holidays.has(key)) count += 1;
  }
  return count;
}

export type SlaEvaluation = {
  status: "safe" | "warning" | "overdue" | "paused" | "completed";
  elapsedMinutes: number;
  overdueMinutes: number;
  escalationLevel: number;
};

export function evaluateSla(input: {
  behavior: string;
  activePause: boolean;
  dueAt: string | null;
  targetMinutes: number;
  startedAt: string | null;
  pausedMinutes: number;
  warningBusinessDays: number;
}, calendar: SlaCalendar, now = new Date()): SlaEvaluation {
  if (input.activePause || input.behavior === "paused") return { status: "paused", elapsedMinutes: 0, overdueMinutes: 0, escalationLevel: 0 };
  if (input.behavior === "completed") return { status: "completed", elapsedMinutes: 0, overdueMinutes: 0, escalationLevel: 0 };

  const workdayMinutes = workingDayMinutes(calendar);
  const warningMinutes = Math.max(0, input.warningBusinessDays * workdayMinutes);
  let elapsedMinutes = 0;
  let overdueMinutes = 0;
  let status: SlaEvaluation["status"] = "safe";

  if (input.targetMinutes > 0 && input.startedAt) {
    elapsedMinutes = Math.max(0, businessMinutesBetween(input.startedAt, now, calendar) - Math.max(0, input.pausedMinutes));
    overdueMinutes = Math.max(0, elapsedMinutes - input.targetMinutes);
    if (elapsedMinutes >= input.targetMinutes) status = "overdue";
    else if (elapsedMinutes >= Math.max(0, input.targetMinutes - warningMinutes)) status = "warning";
  } else if (input.dueAt) {
    const today = zonedDateKey(now, calendar.timezone);
    const dueDate = zonedDateKey(input.dueAt, calendar.timezone) || input.dueAt.slice(0, 10);
    const remainingDays = businessDaysUntil(today, dueDate, calendar);
    if (new Date(input.dueAt).getTime() < now.getTime()) {
      status = "overdue";
      overdueMinutes = businessMinutesBetween(input.dueAt, now, calendar);
    } else if (remainingDays <= input.warningBusinessDays) status = "warning";
  }

  const escalationLevel = status !== "overdue" ? 0 : overdueMinutes >= workdayMinutes * 3 ? 3 : overdueMinutes >= workdayMinutes ? 2 : 1;
  return { status, elapsedMinutes, overdueMinutes, escalationLevel };
}

export function formatWorkingMinutes(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (!hours) return `${remainder} min úteis`;
  return remainder ? `${hours}h${String(remainder).padStart(2, "0")} úteis` : `${hours}h úteis`;
}
