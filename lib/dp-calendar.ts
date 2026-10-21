/**
 * Calendário do DP: dia útil, último dia do mês, semana.
 *
 * Puro — os feriados e os dias úteis do workspace chegam por parâmetro, como já
 * faz `addBusinessDays` (`lib/fila-dp-relations.ts`). Usado pelas rotinas
 * recorrentes (Fase 2), pela regra de corte (Fase 3) e pelos alertas (Fase 4).
 * Datas são sempre `AAAA-MM-DD`, tratadas ao meio-dia UTC para não escorregar
 * de dia com fuso.
 */

export type BusinessCalendar = {
  /** 0 = domingo … 6 = sábado. */
  businessDays: readonly number[];
  holidays: ReadonlySet<string>;
};

export const DEFAULT_BUSINESS_CALENDAR: BusinessCalendar = { businessDays: [1, 2, 3, 4, 5], holidays: new Set() };

const at = (date: string) => new Date(`${date}T12:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);

export function addDays(date: string, days: number) {
  const cursor = at(date);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return iso(cursor);
}

export function weekdayOf(date: string) {
  return at(date).getUTCDay();
}

export function isBusinessDay(date: string, calendar: BusinessCalendar) {
  return calendar.businessDays.includes(weekdayOf(date)) && !calendar.holidays.has(date);
}

/** O próprio dia, se útil; senão o dia útil anterior. */
export function previousBusinessDay(date: string, calendar: BusinessCalendar) {
  let cursor = date;
  for (let guard = 0; guard < 30 && !isBusinessDay(cursor, calendar); guard += 1) cursor = addDays(cursor, -1);
  return cursor;
}

/**
 * Dias úteis de `from` (exclusivo) até `to` (inclusivo). Negativo quando `to`
 * vem antes. "Admissão com 3 dias úteis de antecedência" é
 * `businessDaysBetween(pedido, início) >= 3`.
 */
export function businessDaysBetween(from: string, to: string, calendar: BusinessCalendar): number {
  if (from === to) return 0;
  if (to < from) return -businessDaysBetween(to, from, calendar);
  let count = 0;
  let cursor = from;
  for (let guard = 0; guard < 4000 && cursor < to; guard += 1) {
    cursor = addDays(cursor, 1);
    if (isBusinessDay(cursor, calendar)) count += 1;
  }
  return count;
}

export function calendarDaysBetween(from: string, to: string) {
  return Math.round((at(to).getTime() - at(from).getTime()) / 86_400_000);
}

export function lastDayOfMonth(competence: string) {
  const [year, month] = competence.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Dia `day` da competência; 31 (ou qualquer dia além do fim) vira o último dia. */
export function monthDay(competence: string, day: number) {
  const last = lastDayOfMonth(competence);
  return `${competence}-${String(Math.min(Math.max(1, day), last)).padStart(2, "0")}`;
}

export function nextCompetence(competence: string) {
  const [year, month] = competence.split("-").map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

export function previousCompetence(competence: string) {
  const [year, month] = competence.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** Segunda-feira da semana da data. */
export function weekStart(date: string) {
  const weekday = weekdayOf(date);
  return addDays(date, weekday === 0 ? -6 : 1 - weekday);
}

/** A data do dia da semana `weekday` na semana que começa em `monday`. */
export function weekDate(monday: string, weekday: number) {
  return addDays(monday, weekday === 0 ? 6 : weekday - 1);
}

export function isCompetence(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/u.test(value);
}

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  return iso(at(value)) === value;
}

export const competenceLabel = (competence: string) => {
  const [year, month] = competence.split("-");
  return `${month}/${year}`;
};

export const dayLabel = (date: string) => {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
};
