import type { PayrollLine } from "./payroll-calc.ts";

/**
 * Obrigações da folha fechada do ERP DP (item 13 do roadmap, §4.35 da
 * arquitetura): encargos do empregador, guias com vencimento, rubricas no
 * formato do S-1200 e lançamentos contábeis.
 *
 * O Vinculato gera o número e o arquivo; a transmissão (DCTFWeb, FGTS Digital,
 * eSocial) continua com quem tem o certificado digital.
 *
 * Puro: quem lê a folha e devolve o arquivo é a rota.
 */

export type EmployerContribution = "standard" | "simples_exempt";
export const employerContributionLabels: Record<EmployerContribution, string> = {
  standard: "Lucro Real / Presumido: 20% + RAT × FAP + terceiros",
  simples_exempt: "Simples Nacional (anexos I a III, V): CPP dentro do DAS",
};

export type CompanyPayrollSettings = {
  employerContribution: EmployerContribution;
  /** RAT (antigo SAT), em %: 1, 2 ou 3 pelo grau de risco do CNAE. */
  ratPercent: number;
  /** FAP, multiplicador entre 0,5 e 2. */
  fap: number;
  /** Outras entidades (terceiros), em %. 5,8% é o caso mais comum (FPAS 515). */
  thirdPartiesPercent: number;
  /** Piso salarial da convenção coletiva, em centavos (0 = sem piso cadastrado). */
  salaryFloorCents: number;
  bank: { code: string; agency: string; agencyDigit: string; account: string; accountDigit: string; agreement: string } | null;
  accounts: AccountingAccounts;
};

export type AccountingAccounts = {
  salaryExpense: string;
  inssExpense: string;
  fgtsExpense: string;
  salariesPayable: string;
  inssPayable: string;
  irrfPayable: string;
  fgtsPayable: string;
  otherDeductions: string;
};

/** Contas padrão, para o escritório trocar pelas do plano dele. */
export const defaultAccounts: AccountingAccounts = {
  salaryExpense: "3.1.1.01 Salários e ordenados",
  inssExpense: "3.1.1.02 INSS patronal",
  fgtsExpense: "3.1.1.03 FGTS",
  salariesPayable: "2.1.3.01 Salários a pagar",
  inssPayable: "2.1.4.01 INSS a recolher",
  irrfPayable: "2.1.4.02 IRRF a recolher",
  fgtsPayable: "2.1.4.03 FGTS a recolher",
  otherDeductions: "2.1.3.09 Descontos a repassar",
};

export const defaultSettings: CompanyPayrollSettings = {
  employerContribution: "standard", ratPercent: 2, fap: 1, thirdPartiesPercent: 5.8, salaryFloorCents: 0, bank: null, accounts: defaultAccounts,
};

export type ResultForObligations = { employeeId: string; name: string; registrationNumber: string; netCents: number; earningsCents: number; deductionsCents: number; fgtsCents: number; lines: PayrollLine[] };

const sum = (lines: readonly PayrollLine[], codes: readonly string[]) => lines.filter((line) => codes.includes(line.code)).reduce((acc, line) => acc + line.amount, 0);

/** Códigos das rubricas de cada guia. */
export const INSS_CODES = ["5000", "5002"] as const;
export const IRRF_CODES = ["5001", "5003"] as const;

/** Dia útil anterior quando cai em fim de semana. Feriados nacionais não estão no calendário: o resumo avisa. */
export function previousBusinessDay(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);
  while (parsed.getUTCDay() === 0 || parsed.getUTCDay() === 6) parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/** Dia 20 do mês seguinte à competência, antecipado se não for dia útil — FGTS Digital e DCTFWeb. */
export function dueDay20(competence: string) {
  const [y, m] = competence.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 20, 12)).toISOString().slice(0, 10);
  return previousBusinessDay(next);
}

/** Quinto dia útil do mês seguinte: prazo do salário (CLT art. 459, §1º), contando o sábado. */
export function salaryDueDate(competence: string) {
  const [y, m] = competence.split("-").map(Number);
  const date = new Date(Date.UTC(y, m, 1, 12));
  let count = 0;
  for (;;) {
    if (date.getUTCDay() !== 0) count += 1;
    if (count === 5) return date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 1);
  }
}

const round = (value: number) => Math.round(value);
const reais = (cents: number) => (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function employerCharges(results: readonly ResultForObligations[], settings: CompanyPayrollSettings) {
  // A base patronal é a soma das bases de INSS (rubrica 9000) dos empregados.
  const base = results.reduce((acc, result) => acc + sum(result.lines.filter((line) => line.kind === "info"), ["9000"]), 0);
  // Pró-labore: 20% patronal, sem RAT nem terceiros (Lei 8.212/91, art. 22, III).
  const partners = results.reduce((acc, result) => acc + sum(result.lines.filter((line) => line.kind === "info"), ["9002"]), 0);
  if (settings.employerContribution === "simples_exempt") {
    return { base, cpp: 0, rat: 0, thirdParties: 0, total: 0, note: "Simples Nacional: a contribuição patronal está no DAS. Anexo IV recolhe CPP à parte — confira o enquadramento." };
  }
  const cpp = round((base + partners) * 0.2);
  const rat = round(base * (settings.ratPercent / 100) * settings.fap);
  const thirdParties = round(base * (settings.thirdPartiesPercent / 100));
  return { base, cpp, rat, thirdParties, total: cpp + rat + thirdParties, note: "" };
}

export type Guide = { code: string; label: string; system: string; amountCents: number; dueDate: string; detail: string };

/** As guias da competência e o pagamento dos salários, com vencimento. */
export function obligationsSummary(competence: string, results: readonly ResultForObligations[], settings: CompanyPayrollSettings) {
  const inssEmployees = results.reduce((acc, result) => acc + sum(result.lines, INSS_CODES), 0);
  const irrf = results.reduce((acc, result) => acc + sum(result.lines, IRRF_CODES), 0);
  const fgts = results.reduce((acc, result) => acc + result.fgtsCents, 0);
  const net = results.reduce((acc, result) => acc + result.netCents, 0);
  // Salário-família é pago pela empresa e compensado na contribuição previdenciária.
  const familyAllowance = results.reduce((acc, result) => acc + sum(result.lines, ["1060"]), 0);
  const charges = employerCharges(results, settings);
  const due = dueDay20(competence);
  const guides: Guide[] = [
    { code: "salaries", label: "Salários líquidos", system: "Pagamento (CNAB 240)", amountCents: net, dueDate: salaryDueDate(competence), detail: "Até o 5º dia útil (CLT art. 459, §1º)" },
    { code: "fgts", label: "FGTS mensal (8%)", system: "FGTS Digital", amountCents: fgts, dueDate: due, detail: "Guia GFD; vence no dia 20 (Lei 14.438/2022)" },
    { code: "cp", label: "Contribuição previdenciária", system: "DCTFWeb (DARF)", amountCents: Math.max(0, inssEmployees + charges.total - familyAllowance),
      dueDate: due, detail: `Segurados R$ ${reais(inssEmployees)} + patronal R$ ${reais(charges.total)}${familyAllowance ? ` − salário-família R$ ${reais(familyAllowance)}` : ""}` },
    { code: "irrf", label: "IRRF sobre salários", system: "DCTFWeb (DARF)", amountCents: irrf, dueDate: due, detail: "Retido na fonte dos empregados" },
  ];
  const notes = ["Vencimentos antecipados para o dia útil anterior em fim de semana; feriados não estão no calendário — confira."];
  if (charges.note) notes.push(charges.note);
  return { guides, charges, inssEmployees, irrf, fgts, net, familyAllowance, notes };
}

/* -------------------------------------------------------------------------- */
/* Rubricas no formato do S-1200                                               */
/* -------------------------------------------------------------------------- */

/**
 * Uma linha por rubrica e trabalhador, com os campos do grupo `itensRemun` do
 * S-1200 (codRubr, ideTabRubr, qtdRubr, vrRubr). A chave é a matrícula: o
 * Vinculato não guarda o CPF inteiro, e o sistema que transmite faz o vínculo.
 */
export function s1200Csv(competence: string, results: readonly ResultForObligations[], tableId = "VINC") {
  const rows = [["perApur", "matricula", "nome", "codRubr", "ideTabRubr", "dscRubr", "natureza", "qtdRubr", "vrRubr"]];
  for (const result of results) {
    for (const line of result.lines) {
      if (line.kind === "info" || line.amount === 0) continue;
      const quantity = /^([\d.,]+)\s*(h|dias?)/u.exec(line.reference ?? "")?.[1]?.replace(",", ".") ?? "";
      rows.push([competence, result.registrationNumber, result.name, line.code, tableId, line.label,
        line.kind === "earning" ? "provento" : "desconto", quantity, (line.amount / 100).toFixed(2)]);
    }
  }
  return toCsv(rows);
}

/* -------------------------------------------------------------------------- */
/* Contabilização                                                             */
/* -------------------------------------------------------------------------- */

export type AccountingEntry = { date: string; debit: string; credit: string; amountCents: number; history: string };

/**
 * Os lançamentos da folha por regime de competência, no último dia do mês:
 * despesa contra obrigação, e os descontos do empregado transferindo de
 * salários a pagar para cada obrigação.
 */
export function accountingEntries(competence: string, results: readonly ResultForObligations[], settings: CompanyPayrollSettings): AccountingEntry[] {
  const [y, m] = competence.split("-").map(Number);
  const date = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const accounts = settings.accounts;
  const earnings = results.reduce((acc, result) => acc + result.earningsCents, 0);
  const inss = results.reduce((acc, result) => acc + sum(result.lines, INSS_CODES), 0);
  const irrf = results.reduce((acc, result) => acc + sum(result.lines, IRRF_CODES), 0);
  const deductions = results.reduce((acc, result) => acc + result.deductionsCents, 0);
  const others = deductions - inss - irrf;
  const fgts = results.reduce((acc, result) => acc + result.fgtsCents, 0);
  const charges = employerCharges(results, settings);
  const familyAllowance = results.reduce((acc, result) => acc + sum(result.lines, ["1060"]), 0);
  const label = `Folha ${competence}`;
  const entries: AccountingEntry[] = [
    { date, debit: accounts.salaryExpense, credit: accounts.salariesPayable, amountCents: earnings - familyAllowance, history: `${label}: proventos` },
    // Salário-família não é despesa: a empresa adianta e compensa no INSS.
    { date, debit: accounts.inssPayable, credit: accounts.salariesPayable, amountCents: familyAllowance, history: `${label}: salário-família a compensar` },
    { date, debit: accounts.salariesPayable, credit: accounts.inssPayable, amountCents: inss, history: `${label}: INSS dos empregados` },
    { date, debit: accounts.salariesPayable, credit: accounts.irrfPayable, amountCents: irrf, history: `${label}: IRRF retido` },
    { date, debit: accounts.salariesPayable, credit: accounts.otherDeductions, amountCents: others, history: `${label}: outros descontos` },
    { date, debit: accounts.fgtsExpense, credit: accounts.fgtsPayable, amountCents: fgts, history: `${label}: FGTS` },
    { date, debit: accounts.inssExpense, credit: accounts.inssPayable, amountCents: charges.total, history: `${label}: INSS patronal, RAT e terceiros` },
  ];
  return entries.filter((entry) => entry.amountCents > 0);
}

export function accountingCsv(entries: readonly AccountingEntry[]) {
  return toCsv([["data", "debito", "credito", "valor", "historico"],
    ...entries.map((entry) => [entry.date, entry.debit, entry.credit, (entry.amountCents / 100).toFixed(2).replace(".", ","), entry.history])]);
}

/** CSV com ponto e vírgula, que é o que o Excel em português abre sem perguntar. */
export function toCsv(rows: readonly (readonly string[])[]) {
  const escape = (value: string) => (/[";\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value);
  return `﻿${rows.map((row) => row.map(escape).join(";")).join("\r\n")}\r\n`;
}
