/**
 * Remuneração do colaborador (ERP DP, infotipo 0008 do SAP).
 *
 * Um registro por início de vigência. Aumento é registro novo: o anterior é
 * delimitado na véspera, e quem estava depois continua depois — a mesma regra
 * de "copiar e delimitar" do histórico funcional (§4.27). Regravar o mesmo
 * início é correção do registro, não um aumento.
 *
 * Puro e sem dependência de servidor (a tela usa os rótulos e o leitor de
 * valores): valida a entrada e planeja a gravação; quem grava é a rota.
 */

const HIGH_DATE = "9999-12-31";
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const previousDay = (date: string) => shift(date, -1);
const nextDay = (date: string) => shift(date, 1);

export const salaryKinds = ["monthly", "hourly"] as const;
export type SalaryKind = typeof salaryKinds[number];
export const salaryKindLabels: Record<SalaryKind, string> = { monthly: "Mensalista", hourly: "Horista" };

export const remunerationReasons = ["admission", "raise", "promotion", "collective_agreement", "merit", "correction", "other"] as const;
export type RemunerationReason = typeof remunerationReasons[number];
export const remunerationReasonLabels: Record<RemunerationReason, string> = {
  admission: "Admissão",
  raise: "Reajuste",
  promotion: "Promoção",
  collective_agreement: "Dissídio / convenção coletiva",
  merit: "Mérito",
  correction: "Correção de lançamento",
  other: "Outro",
};

export type Remuneration = {
  id: string;
  validFrom: string;
  validTo: string;
  salaryKind: SalaryKind;
  amountCents: number;
  monthlyHours: number;
  irrfDependents: number;
  unhealthyPercent: 0 | 10 | 20 | 40;
  hazardous: boolean;
  /** Custo mensal do vale-transporte; a folha desconta até 6% do salário-base. */
  transportVoucherCents: number;
  /** Coparticipação mensal do vale-refeição/alimentação. */
  mealVoucherDiscountCents: number;
  /** Pró-labore de sócio: INSS de 11% como contribuinte individual, sem FGTS. */
  proLabore: boolean;
  /** Filhos até 14 anos (ou inválidos), para o salário-família. */
  familyAllowanceChildren: number;
  /** Pensão alimentícia em percentual (0 = sem pensão por percentual). */
  alimonyPercent: number;
  alimonyBase: "gross" | "gross_minus_inss";
  reason: RemunerationReason;
  notes: string;
};

export type RemunerationInput = Omit<Remuneration, "id" | "validTo">;

const invalid = (message: string, code: string) => Object.assign(new Error(message), { code, status: 400 });

/** Aceita "3.500,00", "3500.00", "3500" ou centavos inteiros em `amountCents`. */
export function parseMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : null;
  const text = String(value ?? "").trim().replace(/^R\$\s*/u, "");
  if (!text) return null;
  const normalized = /,\d{1,2}$/u.test(text) ? text.replace(/\./gu, "").replace(",", ".") : text.replace(/,/gu, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));

export function parseRemunerationInput(body: Record<string, unknown>, admissionDate: string): RemunerationInput {
  const validFrom = body.validFrom;
  if (!isDate(validFrom)) throw invalid("Informe o início da vigência.", "REMUNERATION_START_REQUIRED");
  if (validFrom < admissionDate) throw invalid("A vigência não pode começar antes da admissão.", "REMUNERATION_BEFORE_ADMISSION");
  const salaryKind = (salaryKinds as readonly string[]).includes(String(body.salaryKind)) ? body.salaryKind as SalaryKind : "monthly";
  const amountCents = typeof body.amountCents === "number" ? Math.round(body.amountCents) : parseMoney(body.amount);
  if (!amountCents || amountCents <= 0) throw invalid("Informe um valor maior que zero.", "REMUNERATION_AMOUNT_INVALID");
  const monthlyHours = Number(body.monthlyHours ?? 220);
  if (!Number.isInteger(monthlyHours) || monthlyHours < 1 || monthlyHours > 744) throw invalid("Horas mensais inválidas.", "REMUNERATION_HOURS_INVALID");
  const irrfDependents = Number(body.irrfDependents ?? 0);
  if (!Number.isInteger(irrfDependents) || irrfDependents < 0 || irrfDependents > 30) throw invalid("Número de dependentes inválido.", "REMUNERATION_DEPENDENTS_INVALID");
  const unhealthyPercent = Number(body.unhealthyPercent ?? 0);
  if (![0, 10, 20, 40].includes(unhealthyPercent)) throw invalid("Insalubridade é 10%, 20% ou 40%.", "REMUNERATION_UNHEALTHY_INVALID");
  const hazardous = body.hazardous === true;
  if (hazardous && unhealthyPercent > 0) {
    throw invalid("Insalubridade e periculosidade não se acumulam (CLT art. 193, §2º): escolha uma.", "REMUNERATION_ADDITIONALS_EXCLUSIVE");
  }
  const transportVoucherCents = body.transportVoucher === undefined || body.transportVoucher === "" ? 0 : parseMoney(body.transportVoucher);
  const mealVoucherDiscountCents = body.mealVoucherDiscount === undefined || body.mealVoucherDiscount === "" ? 0 : parseMoney(body.mealVoucherDiscount);
  if (transportVoucherCents === null || transportVoucherCents < 0 || mealVoucherDiscountCents === null || mealVoucherDiscountCents < 0) {
    throw invalid("Valor de vale-transporte ou vale-refeição inválido.", "REMUNERATION_VOUCHER_INVALID");
  }
  const familyAllowanceChildren = Number(body.familyAllowanceChildren ?? 0);
  if (!Number.isInteger(familyAllowanceChildren) || familyAllowanceChildren < 0 || familyAllowanceChildren > 20) throw invalid("Número de filhos inválido.", "REMUNERATION_CHILDREN_INVALID");
  const alimonyPercent = Number(String(body.alimonyPercent ?? 0).replace(",", "."));
  if (!Number.isFinite(alimonyPercent) || alimonyPercent < 0 || alimonyPercent > 100) throw invalid("Percentual de pensão entre 0 e 100.", "REMUNERATION_ALIMONY_INVALID");
  const alimonyBase = body.alimonyBase === "gross" ? "gross" : "gross_minus_inss";
  const reason = (remunerationReasons as readonly string[]).includes(String(body.reason)) ? body.reason as RemunerationReason : null;
  if (!reason) throw invalid("Informe o motivo.", "REMUNERATION_REASON_REQUIRED");
  return {
    validFrom, salaryKind, amountCents, monthlyHours, irrfDependents,
    unhealthyPercent: unhealthyPercent as Remuneration["unhealthyPercent"], hazardous, transportVoucherCents, mealVoucherDiscountCents,
    proLabore: body.proLabore === true, familyAllowanceChildren, alimonyPercent: Math.round(alimonyPercent * 100) / 100, alimonyBase, reason,
    notes: String(body.notes ?? "").trim().slice(0, 500),
  };
}

const day = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value ?? "")).slice(0, 10);

export function remunerationFromRow(row: Record<string, unknown>): Remuneration {
  return {
    id: String(row.id),
    validFrom: day(row.valid_from),
    validTo: day(row.valid_to) || HIGH_DATE,
    salaryKind: row.salary_kind === "hourly" ? "hourly" : "monthly",
    amountCents: Number(row.amount_cents),
    monthlyHours: Number(row.monthly_hours),
    irrfDependents: Number(row.irrf_dependents),
    unhealthyPercent: Number(row.unhealthy_percent) as Remuneration["unhealthyPercent"],
    hazardous: row.hazardous === true || row.hazardous === "t",
    transportVoucherCents: Number(row.transport_voucher_cents ?? 0),
    mealVoucherDiscountCents: Number(row.meal_voucher_discount_cents ?? 0),
    proLabore: row.pro_labore === true || row.pro_labore === "t",
    familyAllowanceChildren: Number(row.family_allowance_children ?? 0),
    alimonyPercent: Number(row.alimony_percent ?? 0),
    alimonyBase: row.alimony_base === "gross" ? "gross" : "gross_minus_inss",
    reason: String(row.reason) as RemunerationReason,
    notes: String(row.notes ?? ""),
  };
}

/** O salário mensal para o cálculo: o horista vira valor da hora × horas do mês. */
export function monthlySalaryOf(record: Pick<Remuneration, "salaryKind" | "amountCents" | "monthlyHours">) {
  return record.salaryKind === "hourly" ? Math.round(record.amountCents * record.monthlyHours) : record.amountCents;
}

export function remunerationAt(records: readonly Remuneration[], date: string) {
  return records.find((record) => record.validFrom <= date && date <= record.validTo) ?? null;
}

export type RemunerationPlan =
  | { mode: "correct"; id: string }
  | { mode: "insert"; validTo: string; delimit: { id: string; validTo: string } | null };

/**
 * Onde o registro novo entra. Mesmo início: correção. Senão, o registro que
 * cobria a data termina na véspera, e o novo vai até onde aquele ia — ou até
 * a véspera do próximo, se a data cai antes do primeiro registro.
 */
export function planRemuneration(records: readonly Remuneration[], validFrom: string): RemunerationPlan {
  const same = records.find((record) => record.validFrom === validFrom);
  if (same) return { mode: "correct", id: same.id };
  const covering = records.find((record) => record.validFrom < validFrom && validFrom <= record.validTo);
  if (covering) return { mode: "insert", validTo: covering.validTo, delimit: { id: covering.id, validTo: previousDay(validFrom) } };
  const next = [...records].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).find((record) => record.validFrom > validFrom);
  return { mode: "insert", validTo: next ? previousDay(next.validFrom) : HIGH_DATE, delimit: null };
}

/** Lacunas e sobreposições — o que a tela mostra quando o histórico não fecha. */
export function remunerationGaps(records: readonly Remuneration[]) {
  const sorted = [...records].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const problems: string[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const expected = nextDay(sorted[index - 1].validTo);
    if (sorted[index].validFrom !== expected) problems.push(`Entre ${sorted[index - 1].validTo} e ${sorted[index].validFrom}`);
  }
  return problems;
}
