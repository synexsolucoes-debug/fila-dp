import {
  inssTables, irrfTables, minimumWages, tableAt,
  type IrrfTable,
} from "./payroll-tables.ts";

/**
 * Cálculo de folha do ERP DP (docs/engenharia-reversa-sap-hcm.md §18).
 *
 * É o lugar do PY do SAP: as mesmas contas que o esquema de cálculo faz —
 * INSS progressivo, IRRF com redução, férias, 13º e rescisão — escritas como
 * funções puras. Cada resultado devolve as linhas (as "rubricas") com o que
 * entrou na conta, e não só o total: quem confere precisa refazer o número.
 *
 * Todo valor é em centavos e inteiro. Arredonda uma vez, no fim de cada
 * rubrica, para o centavo mais próximo — o mesmo que a folha impressa mostra.
 *
 * Puro e sem dependência de servidor: a tela faz a prévia com o mesmo código.
 */

export type Cents = number;

const round = (value: number) => Math.round(value + Number.EPSILON);

export function brl(cents: Cents) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/* -------------------------------------------------------------------------- */
/* Rubricas                                                                   */
/* -------------------------------------------------------------------------- */

export type PayrollLine = {
  code: string;
  label: string;
  kind: "earning" | "deduction" | "info";
  amount: Cents;
  /** A referência que a folha imprime ao lado: dias, horas, avos, alíquota. */
  reference?: string;
  /** Incide INSS / IRRF / FGTS sobre esta rubrica. */
  incidence?: { inss: boolean; irrf: boolean; fgts: boolean };
};

export type PayrollResult = {
  lines: PayrollLine[];
  earnings: Cents;
  deductions: Cents;
  net: Cents;
  /** FGTS do mês, a cargo do empregador (informativo, não sai do líquido). */
  fgts: Cents;
  notes: string[];
};

function total(lines: readonly PayrollLine[], kind: PayrollLine["kind"]) {
  return lines.filter((line) => line.kind === kind).reduce((sum, line) => sum + line.amount, 0);
}

function finish(lines: PayrollLine[], fgts: Cents, notes: string[]): PayrollResult {
  const kept = lines.filter((line) => line.amount !== 0 || line.kind === "info");
  const earnings = total(kept, "earning");
  const deductions = total(kept, "deduction");
  return { lines: kept, earnings, deductions, net: earnings - deductions, fgts, notes };
}

/* -------------------------------------------------------------------------- */
/* INSS do empregado                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Contribuição progressiva (EC 103/2019): cada alíquota incide só sobre a
 * fatia do salário de contribuição que cai na faixa dela, até o teto.
 */
export function inss(base: Cents, date: string) {
  const table = tableAt(inssTables, date, "INSS_TABLE_UNAVAILABLE");
  let previous = 0;
  let exact = 0;
  for (const bracket of table.brackets) {
    if (base <= previous) break;
    exact += (Math.min(base, bracket.upTo) - previous) * bracket.rate;
    previous = bracket.upTo;
  }
  const ceiling = table.brackets[table.brackets.length - 1].upTo;
  return { amount: round(exact), ceiling, capped: base > ceiling, source: table.source };
}

/** Alíquota efetiva, para a coluna de referência da folha. */
function percent(part: Cents, whole: Cents) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(2).replace(".", ",")}%` : "0%";
}

/* -------------------------------------------------------------------------- */
/* IRRF                                                                       */
/* -------------------------------------------------------------------------- */

export type IrrfInput = {
  /** Rendimento tributável bruto do pagamento. */
  gross: Cents;
  /** INSS retido sobre o mesmo pagamento. */
  inss: Cents;
  dependents: number;
  /** Pensão alimentícia judicial descontada no mesmo pagamento. */
  alimony?: Cents;
  date: string;
  /**
   * O desconto simplificado é alternativa às deduções legais no rendimento
   * mensal. No 13º (tributação exclusiva) ele não se aplica.
   */
  allowSimplified?: boolean;
};

function progressive(table: IrrfTable, base: Cents) {
  if (base <= 0) return 0;
  const bracket = table.brackets.find((item) => item.upTo === null || base <= item.upTo) ?? table.brackets[table.brackets.length - 1];
  return Math.max(0, round(base * bracket.rate - bracket.deduction));
}

export function irrf(input: IrrfInput) {
  const table = tableAt(irrfTables, input.date, "IRRF_TABLE_UNAVAILABLE");
  const legalDeductions = input.inss + input.dependents * table.dependent + (input.alimony ?? 0);
  const legalBase = Math.max(0, input.gross - legalDeductions);
  const legalTax = progressive(table, legalBase);
  let method: "legal" | "simplified" = "legal";
  let base = legalBase;
  let tax = legalTax;
  if (input.allowSimplified !== false) {
    // A lei deixa usar o que for melhor para a pessoa: compara as duas bases.
    const simplifiedBase = Math.max(0, input.gross - table.simplified - (input.alimony ?? 0));
    const simplifiedTax = progressive(table, simplifiedBase);
    if (simplifiedTax < legalTax) {
      method = "simplified";
      base = simplifiedBase;
      tax = simplifiedTax;
    }
  }
  // A redução vem depois da tabela, e a faixa dela é decidida pelo bruto.
  let reduction = 0;
  const reducer = table.reducer;
  if (reducer && tax > 0) {
    if (input.gross <= reducer.fullUpTo) reduction = Math.min(tax, reducer.fullAmount);
    else if (input.gross <= reducer.partialUpTo) reduction = Math.min(tax, Math.max(0, round(reducer.a - reducer.b * input.gross)));
  }
  return { amount: tax - reduction, base, method, beforeReduction: tax, reduction, source: table.source };
}

/* -------------------------------------------------------------------------- */
/* Datas e avos                                                               */
/* -------------------------------------------------------------------------- */

const DAY = 86_400_000;
const at = (date: string) => Date.parse(`${date}T12:00:00Z`);

/** Data no formato da folha impressa (dd/mm/aaaa). */
export function brDate(date: string) {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

export function addDays(date: string, days: number) {
  return new Date(at(date) + days * DAY).toISOString().slice(0, 10);
}

function addMonths(date: string, months: number) {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

function inclusiveDays(start: string, end: string) {
  return Math.round((at(end) - at(start)) / DAY) + 1;
}

function lastDayOfMonth(date: string) {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10);
}

/**
 * Avos de 13º no ano de `end` (Lei 4.090/62, art. 1º, §2º): cada mês com 15
 * dias ou mais de trabalho vale 1/12.
 */
export function thirteenthAvos(admissionDate: string, end: string) {
  const year = end.slice(0, 4);
  let avos = 0;
  for (let month = 1; month <= Number(end.slice(5, 7)); month += 1) {
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const from = admissionDate > first ? admissionDate : first;
    const monthEnd = lastDayOfMonth(first);
    const to = end < monthEnd ? end : monthEnd;
    if (from > to) continue;
    if (inclusiveDays(from, to) >= 15) avos += 1;
  }
  return avos;
}

/**
 * Avos de férias proporcionais no período aquisitivo que começa em
 * `periodStart` (CLT art. 146, parágrafo único): cada mês cheio vale 1/12, e
 * a fração final de mais de 14 dias também.
 */
export function vacationAvos(periodStart: string, end: string) {
  if (end < periodStart) return 0;
  let avos = 0;
  let cursor = periodStart;
  while (avos < 12) {
    const next = addMonths(periodStart, avos + 1);
    if (addDays(next, -1) > end) break;
    avos += 1;
    cursor = next;
  }
  if (avos < 12 && inclusiveDays(cursor, end) >= 15) avos += 1;
  return avos;
}

/** O início do período aquisitivo em curso na data: o aniversário da admissão. */
export function currentVacationPeriodStart(admissionDate: string, date: string) {
  let years = 0;
  while (addMonths(admissionDate, 12 * (years + 1)) <= date) years += 1;
  return addMonths(admissionDate, 12 * years);
}

/** Dias de férias pelo número de faltas injustificadas no período (CLT art. 130). */
export function vacationDaysByAbsences(absences: number) {
  if (absences <= 5) return 30;
  if (absences <= 14) return 24;
  if (absences <= 23) return 18;
  if (absences <= 32) return 12;
  return 0;
}

/** Aviso prévio proporcional (Lei 12.506/2011): 30 + 3 por ano completo, até 90. */
export function noticeDays(admissionDate: string, date: string) {
  const [ay, am, ad] = admissionDate.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  let years = y - ay;
  if (m < am || (m === am && d < ad)) years -= 1;
  return Math.min(90, 30 + 3 * Math.max(0, years));
}

/* -------------------------------------------------------------------------- */
/* Folha mensal                                                               */
/* -------------------------------------------------------------------------- */

export type MonthlyInput = {
  competence: string;
  /** Salário contratual mensal (ou horário × horas, já convertido). */
  salary: Cents;
  /** Horas mensais do contrato (220 para 44h semanais). */
  monthlyHours: number;
  dependents: number;
  overtime50Hours?: number;
  overtime100Hours?: number;
  /** Dias úteis e de descanso (domingos e feriados) do mês, para o DSR. */
  workingDays?: number;
  restDays?: number;
  absenceDays?: number;
  /** Insalubridade sobre o salário mínimo: 10, 20 ou 40 (%). */
  unhealthyPercent?: 0 | 10 | 20 | 40;
  hazardous?: boolean;
  otherEarnings?: Cents;
  otherDeductions?: Cents;
  alimony?: Cents;
  /** Dias do mês com vínculo (admissão no meio do mês), no mês comercial de 30. */
  workedDays?: number;
  /** Minutos de relógio entre 22h e 5h, vindos do ponto (CLT art. 73). */
  nightMinutes?: number;
  /** Faltas e atrasos em horas, vindos do ponto. */
  absenceHours?: number;
  /** Custo mensal do vale-transporte: o desconto é até 6% do salário-base (Lei 7.418/85, art. 4º). */
  transportVoucherCost?: Cents;
  /** Coparticipação do vale-refeição/alimentação, descontada como lançada. */
  mealVoucherDiscount?: Cents;
  /** Rubricas vindas de outros módulos (diferença retroativa, parcelas de desconto). */
  extraLines?: PayrollLine[];
};

export function monthlyPayroll(input: MonthlyInput): PayrollResult {
  const date = `${input.competence}-01`;
  const notes: string[] = [];
  const hourly = input.salary / input.monthlyHours;
  const lines: PayrollLine[] = [];
  const all = { inss: true, irrf: true, fgts: true };
  const days = Math.max(0, Math.min(30, input.workedDays ?? 30));
  const baseSalary = days === 30 ? input.salary : round((input.salary / 30) * days);
  lines.push({ code: "1000", label: "Salário", kind: "earning", amount: baseSalary, reference: `${days} dias`, incidence: all });

  const he50 = round(hourly * 1.5 * (input.overtime50Hours ?? 0));
  const he100 = round(hourly * 2 * (input.overtime100Hours ?? 0));
  lines.push({ code: "1010", label: "Horas extras 50%", kind: "earning", amount: he50, reference: `${input.overtime50Hours ?? 0} h`, incidence: all });
  lines.push({ code: "1011", label: "Horas extras 100%", kind: "earning", amount: he100, reference: `${input.overtime100Hours ?? 0} h`, incidence: all });
  if (he50 + he100 > 0) {
    // DSR sobre horas extras (Lei 605/49): (HE ÷ dias úteis) × domingos e feriados.
    if (!input.workingDays || !input.restDays) notes.push("Informe dias úteis e de descanso do mês para calcular o DSR sobre as horas extras.");
    else lines.push({ code: "1020", label: "DSR sobre horas extras", kind: "earning", amount: round(((he50 + he100) / input.workingDays) * input.restDays), reference: `${input.restDays}/${input.workingDays}`, incidence: all });
  }
  if (input.unhealthyPercent) {
    const wage = tableAt(minimumWages, date, "MINIMUM_WAGE_UNAVAILABLE").amount;
    lines.push({ code: "1030", label: `Adicional de insalubridade ${input.unhealthyPercent}%`, kind: "earning", amount: round(wage * input.unhealthyPercent / 100), reference: "sobre o salário mínimo", incidence: all });
  }
  if (input.hazardous) {
    lines.push({ code: "1031", label: "Adicional de periculosidade 30%", kind: "earning", amount: round(baseSalary * 0.3), reference: "sobre o salário-base", incidence: all });
  }
  if (input.nightMinutes) {
    // Hora noturna reduzida de 52min30s (art. 73, §1º) e adicional de 20% sobre a hora diurna.
    const reducedHours = input.nightMinutes / 52.5;
    lines.push({ code: "1040", label: "Adicional noturno 20%", kind: "earning", amount: round(hourly * 0.2 * reducedHours), reference: `${reducedHours.toFixed(2).replace(".", ",")} h noturnas`, incidence: all });
  }
  lines.push({ code: "1090", label: "Outros proventos", kind: "earning", amount: input.otherEarnings ?? 0, incidence: all });
  for (const line of input.extraLines ?? []) lines.push(line);
  const absences = round((input.salary / 30) * (input.absenceDays ?? 0));
  lines.push({ code: "5010", label: "Faltas", kind: "deduction", amount: absences, reference: `${input.absenceDays ?? 0} dias` });
  const absenceHours = round(hourly * (input.absenceHours ?? 0));
  lines.push({ code: "5011", label: "Faltas e atrasos em horas", kind: "deduction", amount: absenceHours, reference: `${(input.absenceHours ?? 0).toFixed(2).replace(".", ",")} h` });
  if (input.transportVoucherCost) {
    const discount = Math.min(input.transportVoucherCost, round(baseSalary * 0.06));
    lines.push({ code: "5050", label: "Vale-transporte (até 6%)", kind: "deduction", amount: discount, reference: `custo ${brl(input.transportVoucherCost)}` });
  }
  lines.push({ code: "5051", label: "Vale-refeição / alimentação", kind: "deduction", amount: input.mealVoucherDiscount ?? 0 });

  // Desconto de falta reduz a base; as rubricas extras de desconto (VT, VR,
  // parcelas) não são salário e não mexem nas incidências.
  const taxable = total(lines.filter((line) => line.incidence?.inss), "earning") - absences - absenceHours;
  const contribution = inss(taxable, date);
  if (contribution.capped) notes.push(`Salário de contribuição acima do teto: INSS limitado a ${brl(contribution.ceiling)}.`);
  lines.push({ code: "5000", label: "INSS", kind: "deduction", amount: contribution.amount, reference: percent(contribution.amount, taxable) });
  const tax = irrf({ gross: taxable, inss: contribution.amount, dependents: input.dependents, alimony: input.alimony, date });
  lines.push({ code: "5001", label: "IRRF", kind: "deduction", amount: tax.amount, reference: tax.method === "simplified" ? "desconto simplificado" : `${input.dependents} dep.` });
  if (tax.reduction > 0) notes.push(`Redução da Lei 15.270/2025 aplicada: ${brl(tax.reduction)}.`);
  lines.push({ code: "5020", label: "Pensão alimentícia", kind: "deduction", amount: input.alimony ?? 0 });
  lines.push({ code: "5090", label: "Outros descontos", kind: "deduction", amount: input.otherDeductions ?? 0 });
  lines.push({ code: "9000", label: "Base INSS", kind: "info", amount: taxable });
  lines.push({ code: "9001", label: "Base IRRF", kind: "info", amount: tax.base });
  const fgtsBase = total(lines.filter((line) => line.incidence?.fgts), "earning") - absences - absenceHours;
  return finish(lines, round(Math.max(0, fgtsBase) * 0.08), notes);
}

/* -------------------------------------------------------------------------- */
/* Médias de variáveis                                                        */
/* -------------------------------------------------------------------------- */

/** Rubricas variáveis que entram na média de férias, 13º e rescisão. */
export const variableCodes = ["1010", "1011", "1020", "1040"] as const;

/**
 * Média das variáveis: soma das rubricas variáveis das folhas fechadas nos
 * 12 meses anteriores à data, dividida pelos meses com folha. Sem folha
 * fechada, a média é zero — e o cálculo diz isso.
 */
export function variableAverage(results: readonly { competence: string; lines: readonly PayrollLine[] }[], referenceDate: string) {
  const end = referenceDate.slice(0, 7);
  const [y, m] = end.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 13, 1)).toISOString().slice(0, 7);
  const window = results.filter((result) => result.competence >= start && result.competence < end);
  if (!window.length) return { amount: 0, months: 0 };
  const sum = window.reduce((acc, result) => acc + result.lines
    .filter((line) => line.kind === "earning" && (variableCodes as readonly string[]).includes(line.code))
    .reduce((lineSum, line) => lineSum + line.amount, 0), 0);
  return { amount: round(sum / window.length), months: window.length };
}

/* -------------------------------------------------------------------------- */
/* Férias                                                                     */
/* -------------------------------------------------------------------------- */

export type VacationInput = {
  /** Início do gozo. É a data das tabelas. */
  start: string;
  salary: Cents;
  /** Média das variáveis (horas extras, adicionais) dos últimos 12 meses. */
  variableAverage?: Cents;
  /** Dias de direito, já ajustados pelas faltas (art. 130). */
  entitledDays: number;
  /** Dias vendidos (abono pecuniário, art. 143): no máximo 1/3 do direito. */
  soldDays?: number;
  dependents: number;
};

export function vacationPay(input: VacationInput): PayrollResult {
  const sold = input.soldDays ?? 0;
  if (sold > Math.floor(input.entitledDays / 3)) {
    throw Object.assign(new Error("O abono pecuniário é de no máximo 1/3 dos dias de férias (CLT art. 143)."), { code: "VACATION_SALE_TOO_LONG" });
  }
  const restDays = input.entitledDays - sold;
  const daily = (input.salary + (input.variableAverage ?? 0)) / 30;
  const pay = round(daily * restDays);
  const third = round(pay / 3);
  const allowance = round(daily * sold);
  const allowanceThird = round(allowance / 3);
  const lines: PayrollLine[] = [
    { code: "2000", label: "Férias", kind: "earning", amount: pay, reference: `${restDays} dias`, incidence: { inss: true, irrf: true, fgts: true } },
    { code: "2001", label: "1/3 constitucional", kind: "earning", amount: third, incidence: { inss: true, irrf: true, fgts: true } },
    // Abono e o terço dele não têm natureza salarial (art. 144): sem INSS, IRRF nem FGTS.
    { code: "2010", label: "Abono pecuniário", kind: "earning", amount: allowance, reference: `${sold} dias` },
    { code: "2011", label: "1/3 sobre o abono", kind: "earning", amount: allowanceThird },
  ];
  const taxable = pay + third;
  const contribution = inss(taxable, input.start);
  lines.push({ code: "5000", label: "INSS sobre férias", kind: "deduction", amount: contribution.amount, reference: percent(contribution.amount, taxable) });
  const tax = irrf({ gross: taxable, inss: contribution.amount, dependents: input.dependents, date: input.start });
  lines.push({ code: "5001", label: "IRRF sobre férias", kind: "deduction", amount: tax.amount });
  const notes = [
    `Pagamento até 2 dias antes do início (CLT art. 145): ${brDate(addDays(input.start, -2))}.`,
    "O INSS das férias soma ao do salário do mês na competência; aqui ele aparece só sobre as férias.",
  ];
  return finish(lines, round(taxable * 0.08), notes);
}

/* -------------------------------------------------------------------------- */
/* 13º salário                                                                */
/* -------------------------------------------------------------------------- */

export type ThirteenthInput = {
  year: number;
  admissionDate: string;
  salary: Cents;
  variableAverage?: Cents;
  dependents: number;
  /** Valor já adiantado na 1ª parcela, descontado na 2ª. */
  firstInstallmentPaid?: Cents;
  /** Data do pagamento da 2ª parcela, para as tabelas (padrão 20/12). */
  paymentDate?: string;
};

export function thirteenthSalary(input: ThirteenthInput): PayrollResult {
  const end = `${input.year}-12-31`;
  const avos = thirteenthAvos(input.admissionDate, end);
  const date = input.paymentDate ?? `${input.year}-12-20`;
  const gross = round(((input.salary + (input.variableAverage ?? 0)) / 12) * avos);
  const lines: PayrollLine[] = [
    { code: "3000", label: "13º salário", kind: "earning", amount: gross, reference: `${avos}/12`, incidence: { inss: true, irrf: true, fgts: true } },
  ];
  // INSS e IRRF do 13º são calculados à parte do salário do mês.
  const contribution = inss(gross, date);
  lines.push({ code: "5000", label: "INSS sobre 13º", kind: "deduction", amount: contribution.amount, reference: percent(contribution.amount, gross) });
  const tax = irrf({ gross, inss: contribution.amount, dependents: input.dependents, date, allowSimplified: false });
  lines.push({ code: "5001", label: "IRRF sobre 13º", kind: "deduction", amount: tax.amount });
  lines.push({ code: "5030", label: "Adiantamento da 1ª parcela", kind: "deduction", amount: input.firstInstallmentPaid ?? 0 });
  const notes = [
    `1ª parcela (até 30/11, sem descontos): ${brl(round(gross / 2))}.`,
    "2ª parcela até 20/12, com INSS e IRRF sobre o valor integral.",
  ];
  return finish(lines, round(gross * 0.08), notes);
}

/* -------------------------------------------------------------------------- */
/* Rescisão                                                                   */
/* -------------------------------------------------------------------------- */

export const terminationKinds = [
  "without_cause", "resignation", "just_cause", "agreement", "fixed_term_end", "fixed_term_early",
] as const;
export type TerminationKind = typeof terminationKinds[number];
export const terminationKindLabels: Record<TerminationKind, string> = {
  without_cause: "Dispensa sem justa causa",
  resignation: "Pedido de demissão",
  just_cause: "Dispensa por justa causa",
  agreement: "Acordo (CLT art. 484-A)",
  fixed_term_end: "Término do contrato a prazo",
  fixed_term_early: "Rescisão antecipada do contrato a prazo pelo empregador",
};

export type TerminationInput = {
  kind: TerminationKind;
  admissionDate: string;
  /** Último dia trabalhado. */
  terminationDate: string;
  salary: Cents;
  variableAverage?: Cents;
  dependents: number;
  /** Aviso trabalhado (cumprido) ou indenizado. Ignorado onde não há aviso. */
  noticeWorked?: boolean;
  /** No pedido de demissão, a empresa desconta o aviso não cumprido (art. 487, §2º). */
  discountUnworkedNotice?: boolean;
  /** Períodos aquisitivos completos ainda não gozados. */
  overdueVacationPeriods?: number;
  /** Saldo do FGTS para fins rescisórios, para a multa. */
  fgtsBalance?: Cents;
  /** Fim previsto do contrato a prazo, para a indenização do art. 479. */
  contractEnd?: string;
  /** 13º já adiantado no ano. */
  thirteenthAdvance?: Cents;
};

export function terminationPay(input: TerminationInput): PayrollResult & { projectedEnd: string; noticeDays: number } {
  const { kind } = input;
  const date = input.terminationDate;
  if (date < input.admissionDate) throw Object.assign(new Error("O desligamento é anterior à admissão."), { code: "TERMINATION_BEFORE_ADMISSION" });
  const base = input.salary + (input.variableAverage ?? 0);
  const daily = base / 30;
  const notes: string[] = [];
  const lines: PayrollLine[] = [];

  // Saldo de salário: dias trabalhados no mês, no mês comercial de 30 dias.
  const monthStart = `${date.slice(0, 7)}-01`;
  const from = input.admissionDate > monthStart ? input.admissionDate : monthStart;
  // Mês inteiro trabalhado vale 30 dias, também em fevereiro e nos meses de 31.
  const workedDays = from === monthStart && date === lastDayOfMonth(date) ? 30 : Math.min(30, inclusiveDays(from, date));
  const balance = round((input.salary / 30) * workedDays);
  lines.push({ code: "4000", label: "Saldo de salário", kind: "earning", amount: balance, reference: `${workedDays} dias`, incidence: { inss: true, irrf: true, fgts: true } });

  // Aviso prévio. Só a dispensa sem justa causa e o acordo dão aviso indenizado
  // proporcional; no acordo, pela metade (art. 484-A, I, a).
  const proportional = noticeDays(input.admissionDate, date);
  let indemnifiedNoticeDays = 0;
  if ((kind === "without_cause" || kind === "agreement") && !input.noticeWorked) {
    indemnifiedNoticeDays = kind === "agreement" ? Math.floor(proportional / 2) : proportional;
    lines.push({ code: "4010", label: "Aviso prévio indenizado", kind: "earning", amount: round(daily * indemnifiedNoticeDays), reference: `${indemnifiedNoticeDays} dias`, incidence: { inss: false, irrf: false, fgts: true } });
  }
  if (kind === "resignation" && input.discountUnworkedNotice) {
    lines.push({ code: "5040", label: "Aviso prévio não cumprido", kind: "deduction", amount: round(daily * 30), reference: "30 dias" });
  }
  // Projeção do aviso indenizado (OJ 82 da SDI-1): conta para 13º e férias.
  const projectedEnd = indemnifiedNoticeDays > 0 ? addDays(date, indemnifiedNoticeDays) : date;
  if (projectedEnd !== date) notes.push(`Aviso indenizado projeta o contrato até ${brDate(projectedEnd)} para 13º e férias (OJ 82 da SDI-1).`);

  // Indenização do art. 479: metade da remuneração dos dias que faltavam.
  if (kind === "fixed_term_early") {
    if (!input.contractEnd || input.contractEnd <= date) throw Object.assign(new Error("Informe o fim previsto do contrato, depois do desligamento."), { code: "CONTRACT_END_REQUIRED" });
    const remaining = inclusiveDays(addDays(date, 1), input.contractEnd);
    lines.push({ code: "4020", label: "Indenização do art. 479 da CLT", kind: "earning", amount: round(daily * remaining / 2), reference: `${remaining} dias ÷ 2` });
  }

  const justCause = kind === "just_cause";
  // 13º proporcional: não é devido na justa causa (Lei 4.090/62, art. 3º).
  let thirteenth = 0;
  if (!justCause) {
    const avos = thirteenthAvos(input.admissionDate, projectedEnd);
    thirteenth = round((base / 12) * avos);
    lines.push({ code: "4030", label: "13º salário proporcional", kind: "earning", amount: thirteenth, reference: `${avos}/12`, incidence: { inss: true, irrf: true, fgts: true } });
  }

  // Férias vencidas: devidas em qualquer modalidade, com 1/3 (art. 146).
  const overdue = input.overdueVacationPeriods ?? 0;
  if (overdue > 0) {
    const value = round(base * overdue);
    lines.push({ code: "4040", label: "Férias vencidas", kind: "earning", amount: value, reference: `${overdue} período(s)` });
    lines.push({ code: "4041", label: "1/3 sobre férias vencidas", kind: "earning", amount: round(value / 3) });
    notes.push("Férias vencidas fora do período concessivo são devidas em dobro (art. 137): confira se é o caso.");
  }
  // Férias proporcionais: não na justa causa (Súmula 171 do TST); devidas no pedido de demissão (Súmula 261).
  if (!justCause) {
    const periodStart = currentVacationPeriodStart(input.admissionDate, projectedEnd);
    const avos = vacationAvos(periodStart, projectedEnd);
    const value = round((base / 12) * avos);
    lines.push({ code: "4050", label: "Férias proporcionais", kind: "earning", amount: value, reference: `${avos}/12` });
    lines.push({ code: "4051", label: "1/3 sobre férias proporcionais", kind: "earning", amount: round(value / 3) });
  }

  // Descontos. Férias indenizadas e aviso indenizado não têm INSS nem IRRF
  // (Súmula 386 do STJ; Lei 7.713/88, art. 6º, V).
  const salaryInss = inss(balance, date);
  lines.push({ code: "5000", label: "INSS sobre saldo de salário", kind: "deduction", amount: salaryInss.amount });
  const salaryTax = irrf({ gross: balance, inss: salaryInss.amount, dependents: input.dependents, date });
  lines.push({ code: "5001", label: "IRRF sobre saldo de salário", kind: "deduction", amount: salaryTax.amount });
  if (thirteenth > 0) {
    // O 13º tem INSS e IRRF próprios, separados do saldo de salário.
    const thirteenthInss = inss(thirteenth, date);
    lines.push({ code: "5002", label: "INSS sobre 13º", kind: "deduction", amount: thirteenthInss.amount });
    const thirteenthTax = irrf({ gross: thirteenth, inss: thirteenthInss.amount, dependents: input.dependents, date, allowSimplified: false });
    lines.push({ code: "5003", label: "IRRF sobre 13º", kind: "deduction", amount: thirteenthTax.amount });
  }
  lines.push({ code: "5030", label: "Adiantamento de 13º", kind: "deduction", amount: input.thirteenthAdvance ?? 0 });

  // Multa do FGTS (Lei 8.036/90, art. 18): 40% na dispensa sem justa causa e na
  // rescisão antecipada pelo empregador; 20% no acordo. É depositada na conta
  // vinculada, não paga no termo — por isso entra como informação.
  const fgtsRate = kind === "without_cause" || kind === "fixed_term_early" ? 0.4 : kind === "agreement" ? 0.2 : 0;
  const fgtsMonth = round(lines.filter((line) => line.incidence?.fgts).reduce((sum, line) => sum + line.amount, 0) * 0.08);
  if (fgtsRate > 0) {
    if (input.fgtsBalance === undefined) notes.push("Informe o saldo do FGTS para calcular a multa rescisória.");
    else lines.push({ code: "9010", label: `Multa do FGTS ${fgtsRate * 100}%`, kind: "info", amount: round((input.fgtsBalance + fgtsMonth) * fgtsRate), reference: "depósito na conta vinculada" });
  }
  lines.push({ code: "9011", label: "FGTS do mês da rescisão", kind: "info", amount: fgtsMonth, reference: "8%" });
  notes.push(`Prazo de pagamento: 10 dias corridos do término do contrato (CLT art. 477, §6º) — até ${brDate(addDays(date, 10))}.`);
  if (kind === "agreement") notes.push("No acordo, o saque do FGTS é de até 80% e não há seguro-desemprego.");

  const result = finish(lines, fgtsMonth, notes);
  return { ...result, projectedEnd, noticeDays: indemnifiedNoticeDays };
}
