/**
 * DP Operacional, Fase 3 — prazo de corte por tipo de processo.
 *
 * "Chegou fora do prazo" era uma conversa, não um dado: ninguém sabia dizer no
 * fim do mês quantas admissões chegaram com um dia de antecedência, nem de qual
 * área. Aqui a regra de cada processo vira dado, `evaluateCutoff` decide na
 * criação da demanda se ela está dentro do corte, e a demanda guarda o
 * veredito (imutável por trigger). Fora do corte, nasce uma ocorrência
 * automática com a área, a empresa e quantos dias de atraso.
 *
 * Tipos de regra:
 * - `antecedencia_dias_uteis`: pedido N dias úteis antes da data pedida
 *   (admissão: 3), com janela opcional do mês (`monthDayLimit`: até o dia 26);
 * - `antecedencia_dias_corridos`: N dias corridos antes (férias: 40);
 * - `dia_do_mes`: até o dia N do mês de referência — a competência, ou o mês da
 *   data pedida (ponto aprovado: 25; variáveis: 26; alteração: dia definido);
 * - `mesmo_dia`: no mesmo dia da decisão (rescisão);
 * - `ate_dias_apos`: até N dias depois do fato (atestado: 2, as 48 horas).
 *
 * Só regra `aprovada` ou `divulgada` vale: regra em `proposta` ainda está em
 * discussão com as áreas e não pode transformar ninguém em atrasado.
 */
import {
  addDays, businessDaysBetween, calendarDaysBetween, dayLabel, monthDay, type BusinessCalendar,
} from "./dp-calendar.ts";

export const cutoffKinds = ["antecedencia_dias_uteis", "antecedencia_dias_corridos", "dia_do_mes", "mesmo_dia", "ate_dias_apos"] as const;
export type CutoffKind = typeof cutoffKinds[number];
export const cutoffStatuses = ["proposta", "aprovada", "divulgada"] as const;
export type CutoffStatus = typeof cutoffStatuses[number];

export const cutoffKindLabels: Record<CutoffKind, string> = {
  antecedencia_dias_uteis: "Antecedência em dias úteis",
  antecedencia_dias_corridos: "Antecedência em dias corridos",
  dia_do_mes: "Até o dia do mês",
  mesmo_dia: "No mesmo dia",
  ate_dias_apos: "Até N dias depois do fato",
};

export type CutoffRule = {
  code: string;
  name: string;
  processTypes: string[];
  kind: CutoffKind;
  value: number;
  monthDayLimit: number | null;
  description: string;
  status: CutoffStatus;
};

export type CutoffInput = {
  /** Dia em que a demanda chegou ao DP (AAAA-MM-DD, no fuso de Brasília). */
  createdOn: string;
  /** Data que o pedido mira: início da admissão, saída de férias, decisão da rescisão, data do atestado. */
  requestedFor: string | null;
  competence: string | null;
};

export type CutoffVerdict = {
  /** `null` quando a regra precisa de uma data que a demanda não trouxe. */
  within: boolean | null;
  deadline: string | null;
  daysLate: number;
  reason: string;
};

/** Maiúsculas e sem acento: "Férias" e "FERIAS" são o mesmo processo. */
export function normalizeProcessType(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toUpperCase().replace(/\s+/gu, " ").trim();
}

export function ruleApplies(rule: CutoffRule) {
  return rule.status === "aprovada" || rule.status === "divulgada";
}

/** A regra vigente do tipo de processo, ou `null`. */
export function ruleFor(rules: readonly CutoffRule[], processType: string) {
  const wanted = normalizeProcessType(processType);
  return rules.find((rule) => ruleApplies(rule) && rule.processTypes.some((type) => normalizeProcessType(type) === wanted)) ?? null;
}

/** O prazo-limite para pedir, quando a regra conta dias úteis para trás. */
function businessDaysBefore(date: string, days: number, calendar: BusinessCalendar) {
  let cursor = date;
  let remaining = days;
  for (let guard = 0; guard < 400 && remaining > 0; guard += 1) {
    cursor = addDays(cursor, -1);
    if (calendar.businessDays.includes(new Date(`${cursor}T12:00:00Z`).getUTCDay()) && !calendar.holidays.has(cursor)) remaining -= 1;
  }
  return cursor;
}

export function evaluateCutoff(rule: CutoffRule, input: CutoffInput, calendar: BusinessCalendar): CutoffVerdict {
  const { createdOn, requestedFor } = input;
  const missing = (what: string): CutoffVerdict => ({ within: null, deadline: null, daysLate: 0, reason: `Sem ${what}: não dá para conferir o corte.` });

  switch (rule.kind) {
    case "antecedencia_dias_uteis": {
      if (!requestedFor) return missing("a data pedida");
      const notice = businessDaysBetween(createdOn, requestedFor, calendar);
      const deadline = businessDaysBefore(requestedFor, rule.value, calendar);
      if (notice < rule.value) {
        return { within: false, deadline, daysLate: Math.max(1, rule.value - notice),
          reason: `Pedido com ${Math.max(0, notice)} dia(s) útil(eis) de antecedência; o corte é ${rule.value} (até ${dayLabel(deadline)}).` };
      }
      if (rule.monthDayLimit && requestedFor.slice(0, 7) === createdOn.slice(0, 7)) {
        const windowEnd = monthDay(createdOn.slice(0, 7), rule.monthDayLimit);
        if (createdOn > windowEnd) {
          return { within: false, deadline: windowEnd, daysLate: calendarDaysBetween(windowEnd, createdOn),
            reason: `Pedido depois do dia ${rule.monthDayLimit}, janela do mês para esta competência.` };
        }
      }
      return { within: true, deadline, daysLate: 0, reason: `Dentro do corte de ${rule.value} dia(s) útil(eis).` };
    }
    case "antecedencia_dias_corridos": {
      if (!requestedFor) return missing("a data pedida");
      const notice = calendarDaysBetween(createdOn, requestedFor);
      const deadline = addDays(requestedFor, -rule.value);
      return notice >= rule.value
        ? { within: true, deadline, daysLate: 0, reason: `Dentro do corte de ${rule.value} dia(s).` }
        : { within: false, deadline, daysLate: rule.value - notice, reason: `Pedido com ${Math.max(0, notice)} dia(s) de antecedência; o corte é ${rule.value} (até ${dayLabel(deadline)}).` };
    }
    case "dia_do_mes": {
      const reference = input.competence ?? requestedFor?.slice(0, 7) ?? createdOn.slice(0, 7);
      const deadline = monthDay(reference, rule.value);
      return createdOn <= deadline
        ? { within: true, deadline, daysLate: 0, reason: `Dentro do corte (até ${dayLabel(deadline)}).` }
        : { within: false, deadline, daysLate: calendarDaysBetween(deadline, createdOn), reason: `Chegou depois do corte de ${dayLabel(deadline)}.` };
    }
    case "mesmo_dia": {
      if (!requestedFor) return missing("a data da decisão");
      return createdOn <= requestedFor
        ? { within: true, deadline: requestedFor, daysLate: 0, reason: "Comunicada no dia da decisão." }
        : { within: false, deadline: requestedFor, daysLate: calendarDaysBetween(requestedFor, createdOn), reason: `Comunicada ${calendarDaysBetween(requestedFor, createdOn)} dia(s) depois da decisão.` };
    }
    case "ate_dias_apos": {
      if (!requestedFor) return missing("a data do fato");
      const deadline = addDays(requestedFor, rule.value);
      return createdOn <= deadline
        ? { within: true, deadline, daysLate: 0, reason: `Dentro de ${rule.value} dia(s) do fato.` }
        : { within: false, deadline, daysLate: calendarDaysBetween(deadline, createdOn), reason: `Chegou depois de ${dayLabel(deadline)} (${rule.value} dia(s) do fato).` };
    }
    default:
      return { within: null, deadline: null, daysLate: 0, reason: "Regra desconhecida." };
  }
}

/** O aviso que o solicitante recebe (card do Teams, descrição da demanda). */
export function cutoffNotice(verdict: CutoffVerdict, rule: CutoffRule) {
  if (verdict.within !== false) return "";
  return `Fora do prazo de corte (${rule.name}): ${verdict.reason} A demanda entra no próximo ciclo ou depende de aprovação da gestão.`;
}

export function ruleFromRow(row: Record<string, unknown>): CutoffRule {
  const types = Array.isArray(row.process_types)
    ? row.process_types
    : typeof row.process_types === "string" ? JSON.parse(row.process_types || "[]") as unknown[] : [];
  return {
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    processTypes: (types as unknown[]).map(String),
    kind: (cutoffKinds as readonly string[]).includes(String(row.kind)) ? row.kind as CutoffKind : "dia_do_mes",
    value: Number(row.value ?? 0),
    monthDayLimit: row.month_day_limit === null || row.month_day_limit === undefined ? null : Number(row.month_day_limit),
    description: String(row.description ?? ""),
    status: (cutoffStatuses as readonly string[]).includes(String(row.status)) ? row.status as CutoffStatus : "proposta",
  };
}

export type AreaReportRow = { area: string; total: number; open: number; outside: number; outsidePercent: number };

/** Relatório por área: total, em aberto, fora do corte e % fora do corte. */
export function areaReport(rows: Array<{ area: string; open: boolean; within: boolean | null }>): AreaReportRow[] {
  const byArea = new Map<string, AreaReportRow>();
  for (const row of rows) {
    const area = row.area.trim() || "Sem área";
    const entry = byArea.get(area) ?? { area, total: 0, open: 0, outside: 0, outsidePercent: 0 };
    entry.total += 1;
    if (row.open) entry.open += 1;
    if (row.within === false) entry.outside += 1;
    byArea.set(area, entry);
  }
  return [...byArea.values()]
    .map((entry) => ({ ...entry, outsidePercent: entry.total ? Math.round((entry.outside / entry.total) * 1000) / 10 : 0 }))
    .sort((left, right) => right.outside - left.outside || right.total - left.total || left.area.localeCompare(right.area));
}
