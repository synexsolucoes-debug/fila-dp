import { ApiError } from "./api-errors.ts";
import { defaultAccounts, defaultSettings, type AccountingAccounts, type CompanyPayrollSettings, type EmployerContribution } from "./payroll-obligations.ts";

/** Configuração de folha da empresa e conta bancária do colaborador (§4.40). */

export async function companySettings(d1: SqlDatabase, workspaceId: string, companyId: string): Promise<CompanyPayrollSettings> {
  const row = await d1.prepare("SELECT * FROM fdp_company_payroll_settings WHERE workspace_id = ? AND company_id = ?")
    .bind(workspaceId, companyId).first<Record<string, unknown>>();
  if (!row) return defaultSettings;
  const accounts = (typeof row.accounts_json === "string" ? JSON.parse(row.accounts_json) : row.accounts_json) as Partial<AccountingAccounts>;
  const bankCode = String(row.bank_code ?? "");
  return {
    employerContribution: row.employer_contribution === "simples_exempt" ? "simples_exempt" : "standard",
    ratPercent: Number(row.rat_percent), fap: Number(row.fap), thirdPartiesPercent: Number(row.third_parties_percent),
    salaryFloorCents: Number(row.salary_floor_cents ?? 0),
    bank: bankCode ? {
      code: bankCode, agency: String(row.bank_agency ?? ""), agencyDigit: String(row.bank_agency_digit ?? ""),
      account: String(row.bank_account ?? ""), accountDigit: String(row.bank_account_digit ?? ""), agreement: String(row.bank_agreement ?? ""),
    } : null,
    accounts: { ...defaultAccounts, ...accounts },
  };
}

const onlyDigits = (value: unknown, max: number, label: string) => {
  const text = String(value ?? "").trim();
  if (text && !new RegExp(`^\\d{1,${max}}$`, "u").test(text)) throw ApiError.badRequest(`${label}: só números, até ${max} dígitos.`, "BANK_FIELD_INVALID");
  return text;
};
const digit = (value: unknown) => String(value ?? "").trim().slice(0, 1).toUpperCase();

export function parseSettings(body: Record<string, unknown>): CompanyPayrollSettings {
  const employerContribution: EmployerContribution = body.employerContribution === "simples_exempt" ? "simples_exempt" : "standard";
  const ratPercent = Number(body.ratPercent ?? 2);
  const fap = Number(String(body.fap ?? 1).replace(",", "."));
  const thirdPartiesPercent = Number(String(body.thirdPartiesPercent ?? 5.8).replace(",", "."));
  if (![1, 2, 3].includes(ratPercent)) throw ApiError.badRequest("RAT é 1%, 2% ou 3%.", "SETTINGS_RAT_INVALID");
  if (!(fap >= 0.5 && fap <= 2)) throw ApiError.badRequest("FAP fica entre 0,5 e 2.", "SETTINGS_FAP_INVALID");
  if (!(thirdPartiesPercent >= 0 && thirdPartiesPercent <= 10)) throw ApiError.badRequest("Terceiros entre 0% e 10%.", "SETTINGS_THIRD_INVALID");
  const bankBody = (body.bank ?? {}) as Record<string, unknown>;
  const code = onlyDigits(bankBody.code, 3, "Banco");
  const bank = code ? {
    code: code.padStart(3, "0"), agency: onlyDigits(bankBody.agency, 5, "Agência"), agencyDigit: digit(bankBody.agencyDigit),
    account: onlyDigits(bankBody.account, 12, "Conta"), accountDigit: digit(bankBody.accountDigit), agreement: String(bankBody.agreement ?? "").trim().slice(0, 20),
  } : null;
  const accountsBody = (body.accounts ?? {}) as Record<string, unknown>;
  const accounts = Object.fromEntries(Object.entries(defaultAccounts).map(([key, fallback]) => [key, String(accountsBody[key] ?? fallback).trim().slice(0, 80) || fallback])) as AccountingAccounts;
  const floor = String(body.salaryFloor ?? "").trim();
  const salaryFloorCents = typeof body.salaryFloorCents === "number" ? Math.round(body.salaryFloorCents)
    : floor ? Math.round(Number(floor.replace(/\./gu, "").replace(",", ".")) * 100) : 0;
  if (!Number.isFinite(salaryFloorCents) || salaryFloorCents < 0) throw ApiError.badRequest("Piso salarial inválido.", "SETTINGS_FLOOR_INVALID");
  return { employerContribution, ratPercent, fap, thirdPartiesPercent, salaryFloorCents, bank, accounts };
}

export type BankAccount = { bankCode: string; agency: string; agencyDigit: string; account: string; accountDigit: string; accountType: "checking" | "savings" | "salary"; pixKey: string };

export function parseBankAccount(body: Record<string, unknown>): BankAccount {
  const bankCode = onlyDigits(body.bankCode, 3, "Banco").padStart(3, "0");
  const agency = onlyDigits(body.agency, 5, "Agência");
  const account = onlyDigits(body.account, 12, "Conta");
  if (!bankCode || bankCode === "000" || !agency || !account) throw ApiError.badRequest("Informe banco, agência e conta.", "BANK_ACCOUNT_REQUIRED");
  const accountType = body.accountType === "savings" ? "savings" : body.accountType === "salary" ? "salary" : "checking";
  return { bankCode, agency, agencyDigit: digit(body.agencyDigit), account, accountDigit: digit(body.accountDigit), accountType, pixKey: String(body.pixKey ?? "").trim().slice(0, 77) };
}

export function bankAccountFromRow(row: Record<string, unknown>): BankAccount {
  return {
    bankCode: String(row.bank_code), agency: String(row.agency), agencyDigit: String(row.agency_digit ?? ""), account: String(row.account),
    accountDigit: String(row.account_digit ?? ""), accountType: String(row.account_type) as BankAccount["accountType"], pixKey: String(row.pix_key ?? ""),
  };
}
