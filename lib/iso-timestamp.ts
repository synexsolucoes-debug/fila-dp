/**
 * Data do banco como ISO. O driver devolve `timestamptz` como `Date`, e
 * `String(date)` vira "Tue Nov 03 2026 …": quem fatiava os dez primeiros
 * caracteres para agrupar por dia recebia lixo, e o Planner punha todo prazo
 * sob "Sem prazo".
 */
export function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}/u.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}
