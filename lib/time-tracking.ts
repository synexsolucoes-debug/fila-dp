import { ApiError } from "./api-errors.ts";
import { cleanText } from "./registrations.ts";

/**
 * Conferência de ponto (§28 da especificação).
 *
 * Este módulo é puro: não acessa banco, sessão nem rede. Ele responde a três
 * perguntas operacionais do DP e a nenhuma outra:
 *
 *   1. o que o cartão de ponto do colaborador diz que aconteceu no dia?
 *   2. o que está inconsistente e precisa de decisão humana antes do fechamento?
 *   3. quais eventos de hora saem para a folha, e em qual campo do destino?
 *
 * O que este módulo **não** faz, deliberadamente:
 *
 * - não calcula valor em dinheiro de hora extra, adicional noturno ou falta.
 *   O produto confere horas; quem transforma hora em dinheiro é a folha.
 * - não aplica a conversão da hora noturna reduzida (art. 73, §1º da CLT).
 *   Ele apura os minutos dentro da janela noturna e entrega a quantidade; a
 *   conversão legal pertence ao sistema de folha, que é a fonte oficial.
 * - não adivinha destino de rubrica. Sem mapeamento configurado, a exportação
 *   é bloqueada (§22).
 */
export const TIME_CALC_VERSION = "time-tracking-1.0.0";

/* -------------------------------------------------------------------------- */
/* Vocabulário                                                                 */
/* -------------------------------------------------------------------------- */

export const timeDayTypes = ["regular", "rest", "holiday", "vacation", "leave", "absence"] as const;
export type TimeDayType = typeof timeDayTypes[number];

/** Dias em que não se espera trabalho: qualquer marcação neles exige decisão humana. */
const nonWorkingDayTypes = new Set<TimeDayType>(["rest", "holiday", "vacation", "leave", "absence"]);

export const timeEntryOrigins = ["manual", "import", "integration"] as const;
export type TimeEntryOrigin = typeof timeEntryOrigins[number];

export const timeSheetStatuses = ["draft", "review", "approved", "rejected", "exported", "closed"] as const;
export type TimeSheetStatus = typeof timeSheetStatuses[number];

/**
 * Ciclo de vida da folha de ponto da competência.
 *
 * A exportação só é alcançável depois da aprovação: não existe caminho de
 * `review` direto para `exported`. Voltar de `exported` ou `closed` para
 * `review` é reabertura e exige justificativa — a regra é repetida em trigger
 * no banco, porque histórico de ponto exportado é prova documental.
 */
export const timeSheetTransitions: Record<TimeSheetStatus, readonly TimeSheetStatus[]> = {
  draft: ["review"],
  review: ["approved", "rejected", "draft"],
  approved: ["exported", "review"],
  rejected: ["draft"],
  exported: ["closed", "review"],
  closed: ["review"],
};

/** Estados em que a folha de ponto está congelada: alterar exige reabertura justificada. */
export const frozenTimeSheetStatuses: readonly TimeSheetStatus[] = ["exported", "closed"];

/**
 * Eventos do tipo hora reconhecidos pela conferência.
 *
 * A lista é fechada de propósito: cada código tem uma regra de apuração escrita
 * abaixo. Um evento sem regra seria um número inventado.
 */
export const hourEventCodes = [
  "overtime_50",
  "overtime_100",
  "night_hours",
  "late_hours",
  "absence_hours",
  "interval_not_taken",
  "on_call_hours",
  "time_bank_credit",
  "time_bank_debit",
] as const;
export type HourEventCode = typeof hourEventCodes[number];

export const hourEventLabels: Record<HourEventCode, string> = {
  overtime_50: "Hora extra (dia útil)",
  overtime_100: "Hora extra (descanso e feriado)",
  night_hours: "Horas em janela noturna",
  late_hours: "Atrasos e saídas antecipadas",
  absence_hours: "Faltas em horas",
  interval_not_taken: "Intervalo não usufruído",
  on_call_hours: "Sobreaviso",
  time_bank_credit: "Banco de horas — crédito",
  time_bank_debit: "Banco de horas — débito",
};

/** Eventos apurados pelo motor a partir das marcações; os demais são manuais e justificados. */
export const computedHourEventCodes: readonly HourEventCode[] = [
  "overtime_50", "overtime_100", "night_hours", "late_hours", "absence_hours",
];

export const hourEventSources = ["computed", "manual"] as const;
export type HourEventSource = typeof hourEventSources[number];

/**
 * REGRA ABSOLUTA (§22): evento do tipo hora vai para índice, referência ou
 * quantidade — nunca para valor.
 *
 * `value` não é um destino desabilitado: ele simplesmente não existe neste
 * vocabulário, e o banco repete a restrição em CHECK.
 */
export const hourEventTargetFields = ["quantity", "reference", "index"] as const;
export type HourEventTargetField = typeof hourEventTargetFields[number];

/** Destinos proibidos, mantidos explícitos para que a proibição seja testável. */
export const forbiddenHourEventTargets = ["value", "amount", "valor", "montante", "money"] as const;

export const hourEventUnits = ["hours_decimal", "hours_minutes", "minutes"] as const;
export type HourEventUnit = typeof hourEventUnits[number];

export const timeInconsistencyKinds = [
  "missing_punch",
  "odd_punch_count",
  "duplicate_punch",
  "out_of_order_punch",
  "missing_schedule",
  "future_date",
  "work_on_non_working_day",
  "overtime_without_justification",
  "interval_below_minimum",
] as const;
export type TimeInconsistencyKind = typeof timeInconsistencyKinds[number];

export const timeInconsistencySeverities = ["blocking", "warning"] as const;
export type TimeInconsistencySeverity = typeof timeInconsistencySeverities[number];

export const timeInconsistencyStatuses = ["open", "resolved", "waived"] as const;
export type TimeInconsistencyStatus = typeof timeInconsistencyStatuses[number];

/** Bloqueia a aprovação enquanto estiver aberta; a de aviso apenas sinaliza. */
const inconsistencySeverity: Record<TimeInconsistencyKind, TimeInconsistencySeverity> = {
  missing_punch: "blocking",
  odd_punch_count: "blocking",
  duplicate_punch: "blocking",
  out_of_order_punch: "blocking",
  missing_schedule: "blocking",
  future_date: "blocking",
  work_on_non_working_day: "blocking",
  overtime_without_justification: "warning",
  interval_below_minimum: "warning",
};

export const timeInconsistencyLabels: Record<TimeInconsistencyKind, string> = {
  missing_punch: "Dia útil sem nenhuma marcação",
  odd_punch_count: "Marcação de entrada sem a saída correspondente",
  duplicate_punch: "Marcação repetida no mesmo horário",
  out_of_order_punch: "Marcações fora de ordem cronológica",
  missing_schedule: "Jornada esperada não informada",
  future_date: "Marcação em data futura",
  work_on_non_working_day: "Trabalho em dia sem jornada prevista",
  overtime_without_justification: "Hora extra sem justificativa",
  interval_below_minimum: "Intervalo abaixo do mínimo",
};

export function inconsistencySeverityOf(kind: TimeInconsistencyKind) {
  return inconsistencySeverity[kind];
}

/* -------------------------------------------------------------------------- */
/* Marcações                                                                   */
/* -------------------------------------------------------------------------- */

const MINUTES_IN_DAY = 24 * 60;
/** Janela noturna do art. 73 da CLT: das 22h às 5h. */
const NIGHT_START = 22 * 60;
const NIGHT_END = 5 * 60;

export type Punch = { in: string; out: string };

export function parseClock(value: unknown, field = "Horário") {
  const raw = cleanText(value, 5);
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(raw);
  if (!match) throw ApiError.badRequest(`${field} inválido. Use HH:MM.`, "INVALID_CLOCK");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClock(minutes: number) {
  const normalized = ((Math.round(minutes) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

/** Duração em minutos como HH:MM, aceitando mais de 24 horas acumuladas. */
export function formatDuration(minutes: number) {
  const total = Math.abs(Math.round(minutes));
  const sign = minutes < 0 ? "-" : "";
  return `${sign}${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Normaliza as marcações do dia para pares entrada/saída.
 *
 * Só os campos `in` e `out` sobrevivem: qualquer outra chave enviada pelo
 * relógio ou pelo arquivo importado é descartada antes de tocar o banco.
 */
export function sanitizePunches(value: unknown): Punch[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    const start = cleanText(entry.in, 5);
    const end = cleanText(entry.out, 5);
    if (!start && !end) return [];
    // A entrada é obrigatória; a saída pode faltar e vira inconsistência.
    parseClock(start, "Horário de entrada");
    if (end) parseClock(end, "Horário de saída");
    return [{ in: start, out: end }];
  });
}

export type ParsedTimeEntry = {
  entryDate: string;
  dayType: TimeDayType;
  expectedMinutes: number | null;
  punches: Punch[];
  origin: TimeEntryOrigin;
  justification: string;
  note: string;
};

/**
 * Normaliza um dia recebido da tela, do arquivo importado ou do conector.
 *
 * Digitação e importação passam pelo mesmo caminho de propósito: a regra do que
 * é um dia válido não pode divergir entre quem opera na tela e quem integra.
 */
export function parseTimeEntryPayload(value: unknown, defaultOrigin: TimeEntryOrigin = "manual"): ParsedTimeEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.badRequest("Marcação inválida.", "INVALID_TIME_ENTRY");
  }
  const input = value as Record<string, unknown>;
  const entryDate = cleanText(input.entryDate ?? input.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(entryDate) || Number.isNaN(Date.parse(`${entryDate}T12:00:00Z`))) {
    throw ApiError.badRequest("Informe a data da marcação no formato AAAA-MM-DD.", "INVALID_DATE");
  }
  const dayType = cleanText(input.dayType, 20) || "regular";
  if (!(timeDayTypes as readonly string[]).includes(dayType)) {
    throw ApiError.badRequest("Tipo de dia inválido.", "INVALID_TIME_DAY_TYPE");
  }
  const origin = cleanText(input.origin, 20);
  const rawExpected = input.expectedMinutes;
  let expectedMinutes: number | null = null;
  if (rawExpected !== undefined && rawExpected !== null && rawExpected !== "") {
    const minutes = Number(rawExpected);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_IN_DAY) {
      throw ApiError.badRequest("Jornada prevista inválida.", "INVALID_EXPECTED_MINUTES");
    }
    expectedMinutes = minutes;
  }
  return {
    entryDate,
    dayType: dayType as TimeDayType,
    expectedMinutes,
    punches: sanitizePunches(input.punches),
    origin: (timeEntryOrigins as readonly string[]).includes(origin) ? origin as TimeEntryOrigin : defaultOrigin,
    justification: cleanText(input.justification, 500),
    note: cleanText(input.note, 300),
  };
}

type PunchAnalysis = {
  workedMinutes: number;
  nightMinutes: number;
  longestGapMinutes: number;
  problems: TimeInconsistencyKind[];
};

/** Minutos trabalhados dentro da janela noturna, sem conversão de hora reduzida. */
function nightMinutesOf(start: number, end: number) {
  let night = 0;
  for (let minute = start; minute < end; minute += 1) {
    const clock = minute % MINUTES_IN_DAY;
    if (clock >= NIGHT_START || clock < NIGHT_END) night += 1;
  }
  return night;
}

function analysePunches(punches: readonly Punch[]): PunchAnalysis {
  const problems: TimeInconsistencyKind[] = [];
  let workedMinutes = 0;
  let nightMinutes = 0;
  let longestGapMinutes = 0;
  let previousEnd: number | null = null;
  const seen = new Set<string>();

  for (const punch of punches) {
    const key = `${punch.in}-${punch.out}`;
    if (seen.has(key)) problems.push("duplicate_punch");
    seen.add(key);

    if (!punch.out) {
      problems.push("odd_punch_count");
      continue;
    }
    const start = parseClock(punch.in, "Horário de entrada");
    // Saída anterior à entrada é virada de dia, não erro.
    const rawEnd = parseClock(punch.out, "Horário de saída");
    const end = rawEnd <= start ? rawEnd + MINUTES_IN_DAY : rawEnd;

    if (previousEnd !== null) {
      if (start < previousEnd) problems.push("out_of_order_punch");
      else longestGapMinutes = Math.max(longestGapMinutes, start - previousEnd);
    }
    previousEnd = end;

    workedMinutes += end - start;
    nightMinutes += nightMinutesOf(start, end);
  }

  return { workedMinutes, nightMinutes, longestGapMinutes, problems: [...new Set(problems)] };
}

/* -------------------------------------------------------------------------- */
/* Conferência do dia                                                          */
/* -------------------------------------------------------------------------- */

export type TimeDayInput = {
  entryDate: string;
  dayType: TimeDayType;
  /** Jornada prevista em minutos. `null` significa "não informada" e é bloqueante. */
  expectedMinutes: number | null;
  punches: readonly Punch[];
  justification?: string;
};

export type TimeDayIssue = {
  entryDate: string;
  kind: TimeInconsistencyKind;
  severity: TimeInconsistencySeverity;
  detail: string;
};

export type TimeDayResult = {
  entryDate: string;
  dayType: TimeDayType;
  expectedMinutes: number;
  workedMinutes: number;
  nightMinutes: number;
  balanceMinutes: number;
  events: Partial<Record<HourEventCode, number>>;
  issues: TimeDayIssue[];
};

export type TimeRules = {
  /** Referência de "hoje" para acusar marcação futura; formato AAAA-MM-DD. */
  today?: string;
  /** Acima deste total diário, a hora extra exige justificativa escrita. */
  overtimeJustificationMinutes?: number;
  /** Intervalo mínimo esperado quando a jornada trabalhada ultrapassa `intervalRequiredAfterMinutes`. */
  minimumIntervalMinutes?: number;
  intervalRequiredAfterMinutes?: number;
};

const defaultRules: Required<TimeRules> = {
  today: "9999-12-31",
  overtimeJustificationMinutes: 0,
  minimumIntervalMinutes: 60,
  intervalRequiredAfterMinutes: 6 * 60,
};

/**
 * Apura um dia do cartão de ponto.
 *
 * Regras de derivação de evento, todas determinísticas:
 *
 * - dia com jornada prevista: saldo positivo vira `overtime_50`; saldo negativo
 *   vira `absence_hours` quando não houve nenhuma marcação e `late_hours`
 *   quando houve trabalho parcial;
 * - descanso e feriado: tudo que foi trabalhado vira `overtime_100`;
 * - férias, licença e falta registrada: trabalho nesses dias **não** vira
 *   evento automático — vira inconsistência bloqueante, porque o certo depende
 *   de decisão humana;
 * - `night_hours` acompanha qualquer dia com marcação dentro da janela noturna.
 */
export function calculateTimeDay(input: TimeDayInput, rules: TimeRules = {}): TimeDayResult {
  const config = { ...defaultRules, ...rules };
  const issues: TimeDayIssue[] = [];
  const events: Partial<Record<HourEventCode, number>> = {};
  const add = (code: HourEventCode, minutes: number) => {
    if (minutes > 0) events[code] = (events[code] ?? 0) + minutes;
  };
  const raise = (kind: TimeInconsistencyKind, detail: string) => {
    issues.push({ entryDate: input.entryDate, kind, severity: inconsistencySeverity[kind], detail });
  };

  const analysis = analysePunches(input.punches);
  for (const problem of analysis.problems) {
    raise(problem, timeInconsistencyLabels[problem]);
  }
  if (input.entryDate > config.today) raise("future_date", `Marcação lançada em ${input.entryDate}.`);

  const isNonWorking = nonWorkingDayTypes.has(input.dayType);
  if (input.expectedMinutes === null && !isNonWorking) {
    raise("missing_schedule", "Sem jornada prevista não é possível apurar saldo do dia.");
  }
  const expectedMinutes = isNonWorking ? 0 : Math.max(input.expectedMinutes ?? 0, 0);
  const workedMinutes = Math.max(analysis.workedMinutes, 0);
  const balanceMinutes = workedMinutes - expectedMinutes;

  if (input.dayType === "regular") {
    if (workedMinutes === 0 && expectedMinutes > 0) {
      raise("missing_punch", "Dia útil sem marcação registrada.");
      add("absence_hours", expectedMinutes);
    } else if (balanceMinutes > 0) {
      add("overtime_50", balanceMinutes);
    } else if (balanceMinutes < 0) {
      add("late_hours", -balanceMinutes);
    }
  } else if (input.dayType === "rest" || input.dayType === "holiday") {
    add("overtime_100", workedMinutes);
  } else if (workedMinutes > 0) {
    // Férias, licença e falta com marcação: o produto acusa, não decide.
    raise("work_on_non_working_day", `Marcação em dia de ${input.dayType} com ${formatDuration(workedMinutes)} trabalhados.`);
  }

  add("night_hours", analysis.nightMinutes);

  const overtimeMinutes = (events.overtime_50 ?? 0) + (events.overtime_100 ?? 0);
  if (overtimeMinutes > config.overtimeJustificationMinutes && !cleanText(input.justification, 500)) {
    raise("overtime_without_justification", `${formatDuration(overtimeMinutes)} de hora extra sem justificativa.`);
  }
  if (workedMinutes > config.intervalRequiredAfterMinutes
    && input.punches.length > 1
    && analysis.longestGapMinutes < config.minimumIntervalMinutes) {
    raise("interval_below_minimum", `Maior intervalo do dia: ${formatDuration(analysis.longestGapMinutes)}.`);
  }

  return {
    entryDate: input.entryDate,
    dayType: input.dayType,
    expectedMinutes,
    workedMinutes,
    nightMinutes: analysis.nightMinutes,
    balanceMinutes,
    events,
    issues,
  };
}

export type TimeSheetTotals = {
  entriesCount: number;
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  events: { eventCode: HourEventCode; minutes: number; source: HourEventSource }[];
  issues: TimeDayIssue[];
  blockingIssues: number;
  warningIssues: number;
  calcVersion: string;
};

export type ManualHourEventInput = {
  eventCode: HourEventCode;
  minutes: number;
  justification: string;
};

/** Consolida os dias da competência e soma os eventos apurados e os manuais. */
export function calculateTimeSheet(input: {
  days: readonly TimeDayInput[];
  manualEvents?: readonly ManualHourEventInput[];
  rules?: TimeRules;
}): TimeSheetTotals {
  const results = input.days.map((day) => calculateTimeDay(day, input.rules ?? {}));
  const totals = new Map<HourEventCode, { minutes: number; source: HourEventSource }>();
  for (const result of results) {
    for (const [code, minutes] of Object.entries(result.events) as [HourEventCode, number][]) {
      const current = totals.get(code) ?? { minutes: 0, source: "computed" as HourEventSource };
      totals.set(code, { minutes: current.minutes + minutes, source: current.source });
    }
  }
  for (const manual of input.manualEvents ?? []) {
    if (manual.minutes <= 0) continue;
    if (cleanText(manual.justification, 500).length < 5) {
      throw ApiError.badRequest("Evento manual de hora exige justificativa.", "TIME_EVENT_JUSTIFICATION_REQUIRED");
    }
    const current = totals.get(manual.eventCode);
    totals.set(manual.eventCode, { minutes: (current?.minutes ?? 0) + manual.minutes, source: "manual" });
  }

  const issues = results.flatMap((result) => result.issues);
  return {
    entriesCount: results.length,
    workedMinutes: results.reduce((total, result) => total + result.workedMinutes, 0),
    expectedMinutes: results.reduce((total, result) => total + result.expectedMinutes, 0),
    balanceMinutes: results.reduce((total, result) => total + result.balanceMinutes, 0),
    events: [...totals.entries()]
      .map(([eventCode, entry]) => ({ eventCode, minutes: entry.minutes, source: entry.source }))
      .sort((left, right) => left.eventCode.localeCompare(right.eventCode)),
    issues,
    blockingIssues: issues.filter((issue) => issue.severity === "blocking").length,
    warningIssues: issues.filter((issue) => issue.severity === "warning").length,
    calcVersion: TIME_CALC_VERSION,
  };
}

/* -------------------------------------------------------------------------- */
/* Aprovação                                                                   */
/* -------------------------------------------------------------------------- */

/** Inconsistência bloqueante em aberto impede a aprovação da folha de ponto. */
export function assertApprovable(openBlockingIssues: number) {
  if (openBlockingIssues > 0) {
    throw ApiError.badRequest(
      `Resolva as ${openBlockingIssues} inconsistência(s) bloqueante(s) antes de aprovar o ponto.`,
      "TIME_BLOCKING_INCONSISTENCIES",
    );
  }
}

export function assertTimeTransition(from: string, to: TimeSheetStatus) {
  const allowed = timeSheetTransitions[from as TimeSheetStatus];
  if (!allowed || !allowed.includes(to)) {
    throw ApiError.badRequest(`Transição de ${from} para ${to} não é permitida no ponto.`, "INVALID_TIME_TRANSITION");
  }
  return to;
}

/** Folha exportada ou fechada só volta a ser editável com justificativa registrada. */
export function assertTimeSheetMutable(status: string) {
  if ((frozenTimeSheetStatuses as readonly string[]).includes(status)) {
    throw ApiError.badRequest(
      "A folha de ponto está exportada e não pode ser alterada. Reabra com justificativa.",
      "TIME_SHEET_LOCKED",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Exportação — §22                                                            */
/* -------------------------------------------------------------------------- */

export type HourEventMapping = {
  eventCode: HourEventCode;
  /** Código da rubrica no sistema de destino. */
  rubricCode: string;
  targetField: HourEventTargetField;
  unit: HourEventUnit;
  destination: string;
  status?: "active" | "inactive";
};

/**
 * Guarda de destino (§22).
 *
 * Chamada em toda entrada de mapeamento — interface, API e importação. Um
 * mapeamento que aponte evento de hora para valor é recusado aqui antes mesmo
 * de chegar ao CHECK do banco.
 */
export function assertHourEventTarget(value: unknown): HourEventTargetField {
  const candidate = cleanText(value, 40).toLowerCase();
  if ((forbiddenHourEventTargets as readonly string[]).includes(candidate)) {
    throw ApiError.badRequest(
      "Evento do tipo hora não pode ser enviado para valor. Use índice, referência ou quantidade.",
      "HOUR_EVENT_VALUE_TARGET_FORBIDDEN",
    );
  }
  if (!(hourEventTargetFields as readonly string[]).includes(candidate)) {
    throw ApiError.badRequest("Destino do evento de hora inválido.", "INVALID_HOUR_EVENT_TARGET");
  }
  return candidate as HourEventTargetField;
}

/** Converte minutos para a unidade declarada no mapeamento. Sem unidade não há conversão. */
export function convertMinutes(minutes: number, unit: HourEventUnit): number | string {
  const rounded = Math.round(minutes);
  if (unit === "minutes") return rounded;
  if (unit === "hours_minutes") return formatDuration(rounded);
  // hours_decimal: quatro casas evitam perda em jornadas fracionadas.
  return Math.round((rounded / 60) * 10_000) / 10_000;
}

export type TimeExportLine = {
  eventCode: HourEventCode;
  rubricCode: string;
  targetField: HourEventTargetField;
  unit: HourEventUnit;
  destination: string;
  minutes: number;
  quantity: number | string;
};

export type TimeExportPlan = {
  ready: boolean;
  lines: TimeExportLine[];
  missingMappings: HourEventCode[];
  ignoredZeroEvents: HourEventCode[];
};

/**
 * Monta as linhas da exportação de ponto para a folha.
 *
 * §22, na íntegra: cada evento de hora só sai se existir mapeamento ativo
 * declarando rubrica, destino (`quantity`, `reference` ou `index`) e unidade.
 * Falta de mapeamento não vira palpite nem valor padrão: vira bloqueio.
 *
 * A linha resultante não possui campo de valor. Não é omissão de preenchimento:
 * o formato simplesmente não tem para onde mandar dinheiro.
 */
export function planTimeExport(input: {
  events: readonly { eventCode: HourEventCode; minutes: number }[];
  mappings: readonly HourEventMapping[];
}): TimeExportPlan {
  const active = new Map<HourEventCode, HourEventMapping>();
  for (const mapping of input.mappings) {
    if ((mapping.status ?? "active") !== "active") continue;
    assertHourEventTarget(mapping.targetField);
    active.set(mapping.eventCode, mapping);
  }

  const lines: TimeExportLine[] = [];
  const missingMappings: HourEventCode[] = [];
  const ignoredZeroEvents: HourEventCode[] = [];

  for (const event of input.events) {
    const minutes = Math.round(event.minutes);
    if (minutes <= 0) {
      ignoredZeroEvents.push(event.eventCode);
      continue;
    }
    const mapping = active.get(event.eventCode);
    if (!mapping) {
      missingMappings.push(event.eventCode);
      continue;
    }
    lines.push({
      eventCode: event.eventCode,
      rubricCode: mapping.rubricCode,
      targetField: mapping.targetField,
      unit: mapping.unit,
      destination: mapping.destination,
      minutes,
      quantity: convertMinutes(minutes, mapping.unit),
    });
  }

  return {
    ready: missingMappings.length === 0 && lines.length > 0,
    lines: lines.sort((left, right) => left.eventCode.localeCompare(right.eventCode)),
    missingMappings: [...new Set(missingMappings)],
    ignoredZeroEvents: [...new Set(ignoredZeroEvents)],
  };
}

/** Sem configuração, bloquear exportação (§22). A mensagem nomeia o que falta configurar. */
export function assertExportable(plan: TimeExportPlan) {
  if (plan.missingMappings.length > 0) {
    const missing = plan.missingMappings.map((code) => hourEventLabels[code]).join(", ");
    throw ApiError.badRequest(
      `Exportação bloqueada: sem mapeamento de rubrica para ${missing}. Configure o destino do evento antes de exportar.`,
      "HOUR_EVENT_MAPPING_REQUIRED",
    );
  }
  if (plan.lines.length === 0) {
    throw ApiError.badRequest("Não há evento de hora apurado para exportar nesta competência.", "TIME_EXPORT_EMPTY");
  }
  return plan;
}

/** Arquivo CSV da exportação: uma linha por evento, sem nenhuma coluna de valor. */
export function renderTimeExportCsv(rows: readonly (TimeExportLine & { registrationNumber: string; employeeName: string })[]) {
  const header = ["matricula", "colaborador", "rubrica", "evento", "campo_destino", "unidade", "quantidade"];
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[";\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  const body = rows.map((row) => [
    row.registrationNumber, row.employeeName, row.rubricCode, row.eventCode, row.targetField, row.unit, row.quantity,
  ].map(escape).join(";"));
  return [header.join(";"), ...body].join("\n");
}
