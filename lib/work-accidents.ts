/**
 * Vocabulário e apuração do Dashboard de Acidente de Trabalho (SESMT).
 *
 * Este arquivo é **puro**: nenhum import, nenhum acesso a banco, nenhuma
 * dependência de ambiente. É a única cópia do vocabulário do módulo e da conta
 * que o dashboard mostra — o servidor valida com ela, a tela rotula e agrega
 * com ela. Duas cópias significariam a tela dizendo "Trajeto" para um registro
 * que o banco chama de outra coisa, ou um percentual na rosca que não bate com
 * o total do cartão, e a divergência só apareceria no relatório de alguém.
 *
 * Duas decisões estão gravadas aqui, e não espalhadas pelas rotas:
 *
 *  - **quem alimenta é o SESMT**. Não existe origem automática de acidente: o
 *    registro é digitado por quem apura, e por isso todo campo que o dashboard
 *    soma tem valor padrão explícito. Um acidente sem despesa informada vale
 *    zero real, não "desconhecido" — senão o cartão de despesa mentiria pela
 *    metade;
 *  - **o período é do fato, não do lançamento**. Tudo é filtrado por
 *    `occurredOn`. Lançar em setembro um acidente de março move o número de
 *    março, que é onde ele aconteceu — é isso que faz a série do ano fechar com
 *    o que a CAT registrou.
 *
 * Nenhuma função daqui calcula taxa de frequência ou de gravidade da NBR 14280:
 * elas exigem horas-homem trabalhadas, que este módulo não coleta. Publicar uma
 * taxa a partir de um denominador que ninguém informou seria inventar
 * indicador legal — e indicador legal errado é pior que indicador nenhum.
 */

export const accidentTypes = ["incident", "typical", "commute", "occupational_disease"] as const;
export type AccidentType = typeof accidentTypes[number];

export const accidentTypeLabels: Record<AccidentType, string> = {
  incident: "Incidente",
  typical: "Típico",
  commute: "Trajeto",
  occupational_disease: "Doença ocupacional",
};

/**
 * Regiões do corpo, no vocabulário do mapa do dashboard.
 *
 * A lista é fechada de propósito: "parte do corpo" digitada à mão vira
 * "mão esquerda", "MAO", "mao dir." e três fatias diferentes para o mesmo
 * lugar. O que é aberto no módulo é o **setor**, porque a estrutura de cada
 * empresa é dela; a anatomia não é.
 */
export const accidentBodyParts = [
  "skull", "face", "eyes", "neck", "shoulder", "arm", "elbow", "hand", "fingers",
  "chest", "abdomen", "lumbar", "hip", "leg", "knee", "foot", "toes", "multiple", "other",
] as const;
export type AccidentBodyPart = typeof accidentBodyParts[number];

export const accidentBodyPartLabels: Record<AccidentBodyPart, string> = {
  skull: "Crânio",
  face: "Face",
  eyes: "Olhos",
  neck: "Pescoço",
  shoulder: "Ombro",
  arm: "Braço",
  elbow: "Cotovelo",
  hand: "Mão",
  fingers: "Dedos da mão",
  chest: "Tórax",
  abdomen: "Abdômen",
  lumbar: "Região lombar",
  hip: "Quadril",
  leg: "Perna",
  knee: "Joelho",
  foot: "Pé",
  toes: "Dedos do pé",
  multiple: "Múltiplas regiões",
  other: "Demais",
};

export const accidentShifts = ["morning", "afternoon", "night"] as const;
export type AccidentShift = typeof accidentShifts[number];

export const accidentShiftLabels: Record<AccidentShift, string> = {
  morning: "Manhã",
  afternoon: "Tarde",
  night: "Noite",
};

/**
 * Gênero, com "não informado" como padrão real.
 *
 * O dashboard mostra a divisão porque ela orienta a análise de exposição por
 * função, mas informar não é obrigatório: um registro sem gênero continua
 * contando no total de acidentes e aparece como não informado na divisão, em
 * vez de sumir dela. Somar só quem declarou e apresentar o resultado como se
 * fosse o todo seria um gráfico que mente sem errar nenhuma conta.
 */
export const accidentGenders = ["female", "male", "other", "not_informed"] as const;
export type AccidentGender = typeof accidentGenders[number];

export const accidentGenderLabels: Record<AccidentGender, string> = {
  female: "Feminino",
  male: "Masculino",
  other: "Outro",
  not_informed: "Não informado",
};

export const monthAbbreviations = [
  "JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ",
] as const;

export const monthLabels = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
] as const;

/** Setor em branco tem nome, e não vira uma barra sem rótulo no gráfico. */
export const UNASSIGNED_SECTOR = "Sem setor informado";

export type WorkAccidentRecord = {
  id: string;
  companyId: string;
  companyName: string;
  /** Data do fato, em `AAAA-MM-DD`. É ela que decide o período. */
  occurredOn: string;
  accidentType: AccidentType;
  bodyPart: AccidentBodyPart;
  sector: string;
  shift: AccidentShift;
  gender: AccidentGender;
  employeeLabel: string;
  leaveDays: number;
  expenseAmount: number;
  catNumber: string;
  catIssued: boolean;
  description: string;
};

/**
 * O recorte do dashboard.
 *
 * `years` e `months` vazios significam "tudo", e não "nada": é o estado em que
 * a tela abre, e uma tela que abre vazia obriga a pessoa a adivinhar qual
 * combinação faz aparecer alguma coisa.
 */
export type AccidentPeriodFilter = {
  years?: readonly number[];
  months?: readonly number[];
  companyId?: string;
};

export type AccidentSlice = { key: string; label: string; total: number; share: number };

export type WorkAccidentDashboard = {
  totals: {
    accidents: number;
    leaveDays: number;
    expenses: number;
    /** Acidentes que geraram afastamento — o subconjunto que a CAT pesa. */
    withLeave: number;
    catIssued: number;
  };
  byType: AccidentSlice[];
  byBodyPart: AccidentSlice[];
  bySector: AccidentSlice[];
  byGender: AccidentSlice[];
  byShift: AccidentSlice[];
  /** Doze posições, sempre. Mês sem acidente é zero, e zero é informação. */
  byMonth: Array<{ month: number; label: string; total: number }>;
  /** Anos presentes na base inteira, para montar os botões de período. */
  years: number[];
};

const isFinitePositive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Prazo da CAT: um dia útil depois do acidente.
 *
 * "Um dia útil" aqui só pula sábado e domingo — feriado municipal, estadual e
 * nacional não entram, porque o produto não tem calendário de feriados por
 * empresa. O prazo real da CAT (Lei 8.213/91, art. 22) é o mesmo do INSS, que
 * considera feriados; esta função é deliberadamente mais permissiva que a lei
 * (nunca marca vencido antes da hora), nunca mais rígida.
 */
export function catDeadline(occurredOn: string) {
  const date = new Date(`${occurredOn}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return occurredOn;
  const day = date.getUTCDay(); // 0=domingo … 6=sábado
  const add = day === 5 ? 3 : day === 6 ? 2 : 1;
  date.setUTCDate(date.getUTCDate() + add);
  return date.toISOString().slice(0, 10);
}

/** Ano de uma data `AAAA-MM-DD`; `0` quando a data não é utilizável. */
export function accidentYear(occurredOn: string) {
  const year = Number(String(occurredOn).slice(0, 4));
  return Number.isInteger(year) && year > 1900 ? year : 0;
}

/** Mês de 1 a 12 de uma data `AAAA-MM-DD`; `0` quando a data não é utilizável. */
export function accidentMonth(occurredOn: string) {
  const month = Number(String(occurredOn).slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : 0;
}

/** O registro pertence ao recorte pedido. Filtro vazio aceita tudo. */
export function matchesPeriod(record: WorkAccidentRecord, filter: AccidentPeriodFilter) {
  if (filter.companyId && record.companyId !== filter.companyId) return false;
  const years = filter.years ?? [];
  if (years.length && !years.includes(accidentYear(record.occurredOn))) return false;
  const months = filter.months ?? [];
  if (months.length && !months.includes(accidentMonth(record.occurredOn))) return false;
  return true;
}

/**
 * Percentual inteiro que fecha em 100.
 *
 * Arredondar cada fatia isolada produz 24 + 33 + 43 = 100 num dia e 99 no
 * outro, e a rosca do dashboard tem os números escritos ao lado. O maior resto
 * recebe a diferença — é a regra da maior sobra, a mesma que reparte cadeira em
 * eleição, e ela garante que a soma exibida seja a soma real.
 */
function distributeShares<T extends { total: number }>(items: T[], total: number): Array<T & { share: number }> {
  if (!isFinitePositive(total)) return items.map((item) => ({ ...item, share: 0 }));
  const exact = items.map((item) => (item.total * 100) / total);
  const floors = exact.map((value) => Math.floor(value));
  let missing = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((left, right) => right.rest - left.rest || left.index - right.index);
  for (const { index } of order) {
    if (missing <= 0) break;
    floors[index] += 1;
    missing -= 1;
  }
  return items.map((item, index) => ({ ...item, share: floors[index] }));
}

function tally<Key extends string>(
  records: readonly WorkAccidentRecord[],
  pick: (record: WorkAccidentRecord) => Key,
  labels: Record<Key, string>,
  order: readonly Key[],
): AccidentSlice[] {
  const totals = new Map<Key, number>();
  for (const record of records) {
    const key = pick(record);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const present = order.filter((key) => totals.has(key));
  const items = present.map((key) => ({ key: key as string, label: labels[key], total: totals.get(key) ?? 0 }));
  return distributeShares(items, records.length);
}

/**
 * A conta inteira do dashboard, em uma passada.
 *
 * Recebe a base completa e o recorte, e não a base já filtrada: os botões de
 * ano precisam listar todos os anos que existem, inclusive os que o recorte
 * atual esconde. Filtrar antes de chamar apagaria justamente os botões que a
 * pessoa usa para sair do recorte em que está.
 */
export function summarizeAccidents(
  records: readonly WorkAccidentRecord[],
  filter: AccidentPeriodFilter = {},
): WorkAccidentDashboard {
  const years = [...new Set(records.map((record) => accidentYear(record.occurredOn)).filter(Boolean))]
    .sort((left, right) => left - right);
  const scoped = records.filter((record) => matchesPeriod(record, filter));

  const sectorTotals = new Map<string, number>();
  const monthTotals = new Array<number>(12).fill(0);
  let leaveDays = 0;
  let expenses = 0;
  let withLeave = 0;
  let catIssued = 0;
  for (const record of scoped) {
    const sector = record.sector.trim() || UNASSIGNED_SECTOR;
    sectorTotals.set(sector, (sectorTotals.get(sector) ?? 0) + 1);
    const month = accidentMonth(record.occurredOn);
    if (month) monthTotals[month - 1] += 1;
    leaveDays += Math.max(0, record.leaveDays);
    expenses += Math.max(0, record.expenseAmount);
    if (record.leaveDays > 0) withLeave += 1;
    if (record.catIssued) catIssued += 1;
  }

  const sectors = [...sectorTotals.entries()]
    .map(([sector, total]) => ({ key: sector, label: sector, total }))
    .sort((left, right) => right.total - left.total || left.label.localeCompare(right.label, "pt-BR"));

  return {
    totals: {
      accidents: scoped.length,
      leaveDays,
      // Centavos: somar `numeric` do banco em ponto flutuante acumula resto, e
      // o cartão de despesa é lido como dinheiro real pelo SESMT.
      expenses: Math.round(expenses * 100) / 100,
      withLeave,
      catIssued,
    },
    byType: tally(scoped, (record) => record.accidentType, accidentTypeLabels, accidentTypes),
    byBodyPart: tally(scoped, (record) => record.bodyPart, accidentBodyPartLabels, accidentBodyParts)
      .sort((left, right) => right.total - left.total || left.label.localeCompare(right.label, "pt-BR")),
    bySector: distributeShares(sectors, scoped.length),
    byGender: tally(scoped, (record) => record.gender, accidentGenderLabels, accidentGenders),
    byShift: tally(scoped, (record) => record.shift, accidentShiftLabels, accidentShifts),
    byMonth: monthTotals.map((total, index) => ({ month: index + 1, label: monthAbbreviations[index], total })),
    years,
  };
}
