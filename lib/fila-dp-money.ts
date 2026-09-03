function decimalParts(value: unknown) {
  const normalized = String(value ?? "0").trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return { whole: 0, cents: 0 };
  const [wholeText, centsText = ""] = normalized.split(".");
  const whole = Number(wholeText);
  const cents = Number(centsText.padEnd(2, "0"));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(cents)) return { whole: 0, cents: 0 };
  return { whole, cents };
}

export function moneyToCents(value: unknown) {
  const { whole, cents } = decimalParts(value);
  const total = whole * 100 + cents;
  return Number.isSafeInteger(total) ? total : 0;
}

export function moneyFromCents(cents: number) {
  return Math.round(cents) / 100;
}

export function moneyValue(value: unknown) {
  return moneyFromCents(moneyToCents(value));
}

/**
 * Returns the contract value for a closing period using the conventional
 * 30-day month. A missing start date (or a start date before the period)
 * receives the full monthly amount. A contract that starts during the period
 * receives the inclusive amount from its start day through day 30.
 */
export function calculatePjContractAmount(monthlyAmount: unknown, startDate: unknown, period: unknown) {
  const monthlyCents = moneyToCents(monthlyAmount);
  const periodText = String(period ?? "");
  const startDateText = String(startDate ?? "");
  if (!/^\d{4}-\d{2}$/.test(periodText) || !/^\d{4}-\d{2}-\d{2}$/.test(startDateText)) return moneyFromCents(monthlyCents);

  const [startYear, startMonth, startDay] = startDateText.split("-").map(Number);
  const parsedStartDate = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  if (parsedStartDate.getUTCFullYear() !== startYear || parsedStartDate.getUTCMonth() !== startMonth - 1 || parsedStartDate.getUTCDate() !== startDay) return moneyFromCents(monthlyCents);

  const startPeriod = startDateText.slice(0, 7);
  if (startPeriod < periodText) return moneyFromCents(monthlyCents);
  if (startPeriod > periodText) return 0;

  const payableDays = Math.max(0, 31 - Math.min(startDay, 30));
  return moneyFromCents(Math.round((monthlyCents * payableDays) / 30));
}

export function calculatePjClosing(input: {
  contractAmount: unknown;
  variableAmount: unknown;
  reimbursementAmount: unknown;
  deductionsAmount: unknown;
  invoiceLimit: unknown;
  invoiceAmount?: unknown;
}) {
  const contract = moneyToCents(input.contractAmount);
  const variable = moneyToCents(input.variableAmount);
  const reimbursement = moneyToCents(input.reimbursementAmount);
  const deductions = moneyToCents(input.deductionsAmount);
  const invoiceLimit = moneyToCents(input.invoiceLimit);
  const eligible = Math.max(0, contract + variable - deductions);
  const expectedInvoice = invoiceLimit > 0 ? Math.min(eligible, invoiceLimit) : eligible;
  const informedInvoice = moneyToCents(input.invoiceAmount);
  const invoice = informedInvoice > 0 ? informedInvoice : expectedInvoice;
  return {
    contractAmount: moneyFromCents(contract),
    variableAmount: moneyFromCents(variable),
    reimbursementAmount: moneyFromCents(reimbursement),
    deductionsAmount: moneyFromCents(deductions),
    invoiceLimit: moneyFromCents(invoiceLimit),
    invoiceAmount: moneyFromCents(invoice),
    expectedInvoiceAmount: moneyFromCents(expectedInvoice),
    cajuExcess: moneyFromCents(Math.max(0, eligible - expectedInvoice)),
    netAmount: moneyFromCents(eligible + reimbursement),
    invoiceDivergent: informedInvoice > 0 && informedInvoice !== expectedInvoice,
  };
}
