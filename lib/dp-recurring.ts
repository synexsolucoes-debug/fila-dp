/**
 * DP Operacional, Fase 2 — rotinas fixas viram demandas por competência.
 *
 * O calendário do mês do DP (fechamento de impostos de 1 a 15, ponto de 26 a
 * 28, Caju no dia 30, Wellhub toda sexta…) morava numa aba da planilha e na
 * cabeça de quem faz. Aqui cada rotina é um modelo, e `planOccurrences` diz
 * quais demandas um período precisa ter — uma por empresa, uma por raiz de
 * CNPJ ou uma para o grupo inteiro.
 *
 * Puro. Quem grava é `lib/dp-recurring-service.ts`, e quem impede a mesma
 * demanda de nascer duas vezes é o índice único de
 * `fdp_recurring_occurrences` (modelo, período, escopo).
 *
 * Prazo: o dia final da janela; se cair em dia não útil, antecipa para o dia
 * útil anterior. O dia 31 vale como "último dia do mês" (28, 29 ou 30 nos
 * meses curtos).
 */
import {
  competenceLabel, dayLabel, monthDay, previousBusinessDay, weekDate, type BusinessCalendar,
} from "./dp-calendar.ts";
import { cleanText } from "./clean-text.ts";

export type RecurringFrequency = "monthly" | "weekly";
export type RecurringScope = "company" | "cnpj_root" | "tenant";

export const recurringScopeLabels: Record<RecurringScope, string> = {
  company: "Por empresa",
  cnpj_root: "Por raiz de CNPJ",
  tenant: "Uma para o grupo",
};

export const weekdayLabels = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export type RecurringTemplate = {
  id: string;
  code: string;
  name: string;
  description: string;
  frequency: RecurringFrequency;
  dayStart: number;
  dayEnd: number;
  weekday: number | null;
  scope: RecurringScope;
  /** `null` = todas as empresas com situação `interno`. */
  companyIds: string[] | null;
  processType: string;
  listWeekMovements: boolean;
  active: boolean;
};

export type RecurringCompany = {
  id: string;
  name: string;
  code: string;
  dpStatus: string;
  status: string;
  cnpjRoot: string;
  isHeadquarters: boolean;
};

export type PlannedOccurrence = {
  templateId: string;
  periodKey: string;
  scopeKey: string;
  /** A empresa cuja carteira responde (a matriz, na rotina por raiz). */
  companyId: string | null;
  /** Empresas cobertas pela demanda (mais de uma na rotina por raiz). */
  companyIds: string[];
  title: string;
  description: string;
  processType: string;
  competence: string;
  startDate: string;
  dueDate: string;
};

/** Período: a competência (mensal) ou a segunda-feira da semana (semanal). */
export type RecurringPeriod =
  | { frequency: "monthly"; competence: string }
  | { frequency: "weekly"; monday: string };

export function templateFromRow(row: Record<string, unknown>): RecurringTemplate {
  const companyIds = Array.isArray(row.company_ids)
    ? (row.company_ids as unknown[]).map(String)
    : typeof row.company_ids === "string" && row.company_ids.trim().startsWith("[")
      ? (JSON.parse(row.company_ids) as unknown[]).map(String)
      : null;
  return {
    id: String(row.id),
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    frequency: row.frequency === "weekly" ? "weekly" : "monthly",
    dayStart: Number(row.day_start ?? 1),
    dayEnd: Number(row.day_end ?? 1),
    weekday: row.weekday === null || row.weekday === undefined ? null : Number(row.weekday),
    scope: row.scope === "cnpj_root" || row.scope === "tenant" ? row.scope : "company",
    companyIds,
    processType: String(row.process_type ?? "ROTINA DP"),
    listWeekMovements: row.list_week_movements === true || row.list_week_movements === 1,
    active: row.active === true || row.active === 1,
  };
}

/** Janela do modelo no período, com o prazo já antecipado para dia útil. */
export function occurrenceWindow(template: RecurringTemplate, period: RecurringPeriod, calendar: BusinessCalendar) {
  if (period.frequency === "weekly") {
    const day = weekDate(period.monday, template.weekday ?? 5);
    return { startDate: period.monday, dueDate: previousBusinessDay(day, calendar), competence: day.slice(0, 7) };
  }
  const startDate = monthDay(period.competence, template.dayStart);
  const dueDate = previousBusinessDay(monthDay(period.competence, template.dayEnd), calendar);
  // Janela de um dia só que cai em dia não útil (Caju no dia 30 de fevereiro
  // → 28, sábado): o prazo antecipa e a janela abre junto com ele.
  return { startDate: dueDate < startDate ? dueDate : startDate, dueDate, competence: period.competence };
}

/** Empresas que o modelo cobre. */
export function eligibleCompanies(template: RecurringTemplate, companies: readonly RecurringCompany[]) {
  const active = companies.filter((company) => company.status === "active");
  if (template.companyIds) {
    const wanted = new Set(template.companyIds);
    return active.filter((company) => wanted.has(company.id));
  }
  return active.filter((company) => company.dpStatus === "interno");
}

function companyLabel(company: RecurringCompany) {
  return company.code ? `${company.code} · ${company.name}` : company.name;
}

/**
 * As demandas que o período precisa ter para um modelo.
 *
 * Na rotina por raiz de CNPJ, as empresas com a mesma raiz viram uma demanda
 * só (Goiânia e Goianésia), e quem responde é a carteira da **matriz** da
 * raiz — mesmo que a matriz não esteja entre as elegíveis, como a 40, que é
 * matriz e não tem funcionários. Empresa sem CNPJ não tem raiz e fica sozinha.
 */
export function planOccurrences(input: {
  template: RecurringTemplate;
  period: RecurringPeriod;
  companies: readonly RecurringCompany[];
  calendar: BusinessCalendar;
}): PlannedOccurrence[] {
  const { template, period } = input;
  if (!template.active || template.frequency !== period.frequency) return [];
  const window = occurrenceWindow(template, period, input.calendar);
  const periodKey = period.frequency === "weekly" ? period.monday : period.competence;
  const periodLabel = period.frequency === "weekly"
    ? `semana de ${dayLabel(period.monday)}`
    : competenceLabel(period.competence);
  const base = {
    templateId: template.id, periodKey, processType: template.processType,
    competence: window.competence, startDate: window.startDate, dueDate: window.dueDate,
  };
  const describe = (scopeText: string) => [
    template.description,
    `Rotina ${template.frequency === "weekly" ? `semanal (${weekdayLabels[template.weekday ?? 5]})` : `do dia ${template.dayStart} ao dia ${template.dayEnd === 31 ? "último" : template.dayEnd}`} — ${periodLabel}.`,
    scopeText,
  ].filter(Boolean).join("\n\n");

  if (template.scope === "tenant") {
    return [{
      ...base, scopeKey: "grupo", companyId: null, companyIds: [],
      title: `${template.name} — ${periodLabel}`,
      description: describe("Uma demanda para o grupo inteiro."),
    }];
  }

  const eligible = eligibleCompanies(template, input.companies);
  if (template.scope === "company") {
    return eligible.map((company) => ({
      ...base, scopeKey: company.id, companyId: company.id, companyIds: [company.id],
      title: `${template.name} — ${company.name} — ${periodLabel}`,
      description: describe(`Empresa: ${companyLabel(company)}.`),
    }));
  }

  const groups = new Map<string, RecurringCompany[]>();
  for (const company of eligible) {
    const key = company.cnpjRoot ? `raiz:${company.cnpjRoot}` : company.id;
    groups.set(key, [...(groups.get(key) ?? []), company]);
  }
  return [...groups.entries()].map(([scopeKey, members]) => {
    const root = members[0].cnpjRoot;
    const headquarters = (root
      ? input.companies.find((company) => company.cnpjRoot === root && company.isHeadquarters)
      : null) ?? members.find((company) => company.isHeadquarters) ?? members[0];
    const names = members.map(companyLabel).join(", ");
    return {
      ...base, scopeKey, companyId: headquarters.id, companyIds: members.map((company) => company.id),
      title: `${template.name} — ${root ? `raiz ${root.slice(0, 2)}.${root.slice(2, 5)}.${root.slice(5, 8)}` : headquarters.name} — ${periodLabel}`,
      description: describe(`Raiz de CNPJ: ${names}. Responde a carteira da matriz (${companyLabel(headquarters)}).`),
    };
  });
}

/**
 * Quais períodos o job diário garante, a partir de `today`:
 * a competência atual (recupera o que faltou), a seguinte a partir do dia 25
 * e a semana atual.
 */
export function periodsToEnsure(today: string): RecurringPeriod[] {
  const competence = today.slice(0, 7);
  const periods: RecurringPeriod[] = [{ frequency: "monthly", competence }];
  if (Number(today.slice(8, 10)) >= 25) {
    const [year, month] = competence.split("-").map(Number);
    periods.push({ frequency: "monthly", competence: month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}` });
  }
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = new Date(`${today}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  periods.push({ frequency: "weekly", monday: monday.toISOString().slice(0, 10) });
  return periods;
}

/** Texto da semana para a rotina do Wellhub: quem entrou e quem saiu. */
export function weekMovementsText(input: {
  admissions: Array<{ name: string; date: string }>;
  terminations: Array<{ name: string; date: string }>;
}) {
  const lines = (title: string, people: Array<{ name: string; date: string }>) =>
    people.length ? [`${title}:`, ...people.map((person) => `- ${person.name} (${dayLabel(person.date)})`)] : [`${title}: nenhuma.`];
  return [...lines("Inclusões (admissões da semana)", input.admissions), "", ...lines("Exclusões (desligamentos da semana)", input.terminations)].join("\n");
}

export type RecurringTemplateInput = Omit<RecurringTemplate, "id">;

/** Valida o corpo de criação/edição de modelo; devolve a mensagem do primeiro problema. */
export function validateTemplateInput(input: Partial<RecurringTemplateInput>): string | null {
  if (!input.code || !/^[a-z0-9_-]{2,40}$/u.test(input.code)) return "Código do modelo inválido (letras minúsculas, números, - e _).";
  if (!input.name || input.name.length > 160) return "Informe o nome do modelo.";
  if (input.frequency !== "monthly" && input.frequency !== "weekly") return "Frequência inválida.";
  if (!["company", "cnpj_root", "tenant"].includes(String(input.scope))) return "Escopo inválido.";
  if (input.frequency === "weekly") {
    if (input.weekday === null || input.weekday === undefined || input.weekday < 0 || input.weekday > 6) return "Escolha o dia da semana.";
  } else {
    const start = Number(input.dayStart);
    const end = Number(input.dayEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 31 || start > end) return "Janela do mês inválida (1 a 31, início antes do fim).";
  }
  return null;
}

export type CalendarRow = { templateId: string; name: string; frequency: RecurringFrequency; days: string[]; dueDays: string[] };

/**
 * Linha do tempo do mês: para cada rotina ativa, os dias em que ela está
 * aberta e o dia do prazo; e, por dia, quantas frentes correm ao mesmo tempo.
 * Dia com 5 ou mais frentes é o dia que a planilha chamava de "pico".
 */
export function calendarMatrix(templates: readonly RecurringTemplate[], competence: string, calendar: BusinessCalendar) {
  const [year, month] = competence.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthDays = Array.from({ length: last }, (_, index) => `${competence}-${String(index + 1).padStart(2, "0")}`);
  const rows: CalendarRow[] = [];
  for (const template of templates.filter((item) => item.active)) {
    if (template.frequency === "monthly") {
      const window = occurrenceWindow(template, { frequency: "monthly", competence }, calendar);
      rows.push({
        templateId: template.id, name: template.name, frequency: "monthly",
        days: monthDays.filter((day) => day >= window.startDate && day <= monthDay(competence, template.dayEnd)),
        dueDays: [window.dueDate],
      });
    } else {
      const dueDays = monthDays
        .filter((day) => new Date(`${day}T12:00:00Z`).getUTCDay() === (template.weekday ?? 5))
        .map((day) => previousBusinessDay(day, calendar));
      rows.push({ templateId: template.id, name: template.name, frequency: "weekly", days: dueDays, dueDays });
    }
  }
  const load = monthDays.map((day) => ({ day, count: rows.filter((row) => row.days.includes(day)).length }));
  return { days: monthDays, rows, load, peakThreshold: 5 };
}

/** Lê o corpo de criação/edição de modelo recorrente. */
export function templateBody(body: Record<string, unknown>): Partial<RecurringTemplateInput> {
  const companyIds = Array.isArray(body.companyIds)
    ? [...new Set(body.companyIds.filter((id): id is string => typeof id === "string" && id.length <= 120))].slice(0, 200)
    : null;
  return {
    code: cleanText(body.code, 40).toLowerCase(),
    name: cleanText(body.name, 160),
    description: cleanText(body.description, 1000),
    frequency: body.frequency === "weekly" ? "weekly" : body.frequency === "monthly" ? "monthly" : undefined,
    dayStart: Number(body.dayStart ?? 1),
    dayEnd: Number(body.dayEnd ?? body.dayStart ?? 1),
    weekday: body.frequency === "weekly" ? Number(body.weekday) : null,
    scope: body.scope === "cnpj_root" || body.scope === "tenant" || body.scope === "company" ? body.scope : undefined,
    companyIds: companyIds && companyIds.length ? companyIds : null,
    processType: cleanText(body.processType, 40).toUpperCase() || "ROTINA DP",
    listWeekMovements: body.listWeekMovements === true,
    active: body.active !== false,
  };
}

