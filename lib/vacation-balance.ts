import { addDays, addMonths } from "./payroll-calc.ts";

/**
 * Controle de férias do ERP DP — a cota de ausência (infotipo 2006) do SAP
 * (item 8 do roadmap, §4.39 da arquitetura).
 *
 * O período aquisitivo nasce da admissão: 12 meses de vínculo dão direito a
 * 30 dias (CLT art. 130), a gozar nos 12 meses seguintes — o período
 * concessivo (art. 134). Passou do concessivo com saldo, as férias são devidas
 * em dobro (art. 137). Aqui ficam o saldo de cada período, o alerta antes de
 * vencer e as regras da programação.
 *
 * Puro e sem dependência de servidor: a tela mostra a prévia com o mesmo código.
 */

export const vacationStatuses = ["planned", "approved", "taken", "canceled"] as const;
export type VacationStatus = typeof vacationStatuses[number];
export const vacationStatusLabels: Record<VacationStatus, string> = {
  planned: "Programada", approved: "Aprovada", taken: "Gozada", canceled: "Cancelada",
};

export type VacationSchedule = {
  id: string;
  acquisitiveStart: string;
  startDate: string;
  restDays: number;
  soldDays: number;
  entitledDays: number;
  status: VacationStatus;
  collective: boolean;
};

export type PeriodStatus = "acquiring" | "available" | "expiring" | "overdue" | "settled";
export const periodStatusLabels: Record<PeriodStatus, string> = {
  acquiring: "Em aquisição", available: "Disponível", expiring: "Vence em breve", overdue: "Vencida (em dobro)", settled: "Quitada",
};

export type VacationPeriod = {
  acquisitiveStart: string;
  acquisitiveEnd: string;
  /** Último dia para começar a gozar sem pagar em dobro. */
  concessiveEnd: string;
  entitledDays: number;
  usedDays: number;
  scheduledDays: number;
  balance: number;
  status: PeriodStatus;
};

/** Dias até o fim do concessivo que já contam como "vence em breve". */
export const EXPIRING_WINDOW_DAYS = 60;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * Os períodos aquisitivos da admissão até a data, com o saldo de cada um. O
 * período em curso aparece como "em aquisição"; quitado é quem não tem saldo.
 */
export function vacationPeriods(admissionDate: string, today: string, schedules: readonly VacationSchedule[], terminationDate?: string | null): VacationPeriod[] {
  const until = terminationDate && terminationDate < today ? terminationDate : today;
  const periods: VacationPeriod[] = [];
  for (let index = 0; ; index += 1) {
    const start = addMonths(admissionDate, 12 * index);
    if (start > until) break;
    const end = addDays(addMonths(admissionDate, 12 * (index + 1)), -1);
    const concessiveEnd = addDays(addMonths(admissionDate, 12 * (index + 2)), -1);
    const mine = schedules.filter((item) => item.acquisitiveStart === start && item.status !== "canceled");
    const entitledDays = mine.length ? Math.min(...mine.map((item) => item.entitledDays)) : 30;
    const usedDays = mine.filter((item) => item.status === "taken").reduce((sum, item) => sum + item.restDays + item.soldDays, 0);
    const scheduledDays = mine.filter((item) => item.status !== "taken").reduce((sum, item) => sum + item.restDays + item.soldDays, 0);
    const balance = Math.max(0, entitledDays - usedDays - scheduledDays);
    let status: PeriodStatus;
    if (end >= until) status = "acquiring";
    else if (balance === 0 && scheduledDays === 0) status = "settled";
    else if (until > concessiveEnd && balance + scheduledDays > 0) status = "overdue";
    else if (daysBetween(until, concessiveEnd) <= EXPIRING_WINDOW_DAYS && balance > 0) status = "expiring";
    else status = balance === 0 ? "settled" : "available";
    periods.push({ acquisitiveStart: start, acquisitiveEnd: end, concessiveEnd, entitledDays, usedDays, scheduledDays, balance, status });
  }
  return periods;
}

/** O período que mais aperta: vencido, depois o que vence primeiro. */
export function mostUrgentPeriod(periods: readonly VacationPeriod[]) {
  const open = periods.filter((period) => period.status === "overdue" || period.status === "expiring" || period.status === "available");
  return open.sort((a, b) => a.concessiveEnd.localeCompare(b.concessiveEnd))[0] ?? null;
}

export type ScheduleInput = { acquisitiveStart: string; startDate: string; restDays: number; soldDays: number; entitledDays: number; collective?: boolean };

const invalid = (message: string, code: string) => Object.assign(new Error(message), { code, status: 400 });

/**
 * As regras da programação (CLT arts. 134, 135 e 143), contra o período e as
 * frações já programadas dele:
 *
 * - até três frações, uma com 14 dias ou mais e as outras com 5 ou mais;
 * - abono de no máximo 1/3 do direito;
 * - não começar nos dois dias que antecedem o repouso semanal (sexta e sábado);
 * - não passar do saldo;
 * - período ainda em aquisição só em férias coletivas (art. 140).
 *
 * Devolve avisos que não bloqueiam (aviso com menos de 30 dias, fim depois do
 * concessivo).
 */
export function validateSchedule(input: ScheduleInput, period: VacationPeriod | null, others: readonly VacationSchedule[], today: string) {
  if (!period) throw invalid("Período aquisitivo não encontrado para este colaborador.", "VACATION_PERIOD_NOT_FOUND");
  if (period.status === "acquiring" && !input.collective) {
    throw invalid("O período aquisitivo ainda não terminou: só férias coletivas podem ser concedidas antes (CLT art. 140).", "VACATION_NOT_ACQUIRED");
  }
  if (!Number.isInteger(input.restDays) || input.restDays < 5) throw invalid("Cada fração de férias tem no mínimo 5 dias (CLT art. 134, §1º).", "VACATION_FRACTION_TOO_SHORT");
  if (!Number.isInteger(input.soldDays) || input.soldDays < 0) throw invalid("Dias de abono inválidos.", "VACATION_SALE_INVALID");
  const weekday = new Date(`${input.startDate}T12:00:00Z`).getUTCDay();
  if (weekday === 5 || weekday === 6) {
    throw invalid("As férias não podem começar nos dois dias que antecedem o repouso semanal (CLT art. 134, §3º).", "VACATION_START_BEFORE_REST");
  }
  const active = others.filter((item) => item.acquisitiveStart === period.acquisitiveStart && item.status !== "canceled");
  if (active.length >= 3) throw invalid("As férias podem ser divididas em no máximo três períodos (CLT art. 134, §1º).", "VACATION_TOO_MANY_FRACTIONS");
  const soldTotal = active.reduce((sum, item) => sum + item.soldDays, 0) + input.soldDays;
  if (soldTotal > Math.floor(input.entitledDays / 3)) throw invalid("O abono pecuniário é de no máximo 1/3 dos dias de férias (CLT art. 143).", "VACATION_SALE_TOO_LONG");
  const usedOrPlanned = active.reduce((sum, item) => sum + item.restDays + item.soldDays, 0);
  if (usedOrPlanned + input.restDays + input.soldDays > input.entitledDays) {
    throw invalid(`Saldo insuficiente: o período tem ${input.entitledDays - usedOrPlanned} dias.`, "VACATION_BALANCE_EXCEEDED");
  }
  // Uma das frações precisa ter 14 dias ou mais. Se esta é a última que cabe
  // e nenhuma chegou lá, recusa agora — depois não haveria como cumprir.
  const fractions = [...active.map((item) => item.restDays), input.restDays];
  const remaining = input.entitledDays - usedOrPlanned - input.restDays - input.soldDays;
  const canStillHave14 = fractions.length < 3 && remaining >= 14;
  if (!fractions.some((days) => days >= 14) && !canStillHave14) {
    throw invalid("Uma das frações precisa ter no mínimo 14 dias corridos (CLT art. 134, §1º).", "VACATION_NO_LONG_FRACTION");
  }
  const end = addDays(input.startDate, input.restDays - 1);
  const warnings: string[] = [];
  if (daysBetween(today, input.startDate) < 30) warnings.push("O aviso de férias deve ser dado com 30 dias de antecedência (CLT art. 135).");
  if (input.startDate > period.concessiveEnd) warnings.push("Início depois do fim do período concessivo: as férias são devidas em dobro (CLT art. 137).");
  return { end, returnDate: addDays(input.startDate, input.restDays), paymentDue: addDays(input.startDate, -2), noticeDeadline: addDays(input.startDate, -30), warnings };
}
