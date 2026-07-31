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

export function formatWorkingMinutes(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (!hours) return `${remainder} min úteis`;
  return remainder ? `${hours}h${String(remainder).padStart(2, "0")} úteis` : `${hours}h úteis`;
}
