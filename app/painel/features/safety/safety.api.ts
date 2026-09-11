import type { WorkAccidentRecord } from "@/lib/work-accidents";
import type { AccidentDraft, SafetyCompanyOption, SafetyOverview } from "./safety.types";

/**
 * Conversa da tela com `/api/safety`.
 *
 * O servidor já devolve os acidentes normalizados — `workAccidentFromRow` roda
 * lá, com o mesmo tipo que a apuração usa aqui —, então este arquivo não repete
 * a tradução de `snake_case`: ele cuida do transporte, do erro legível e da
 * montagem do formulário.
 */
export type Row = Record<string, unknown>;

const text = (input: unknown) => input == null ? "" : String(input);
const bool = (input: unknown) => input === true || input === 1 || input === "1" || input === "true";

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function normalizeCompany(row: Row): SafetyCompanyOption {
  return {
    id: text(row.id),
    name: text(row.tradeName ?? row.trade_name) || text(row.legalName ?? row.legal_name),
    taxId: text(row.taxId ?? row.tax_id),
    status: row.status === "inactive" ? "inactive" : "active",
  };
}

export function normalizeOverview(payload: Row): SafetyOverview {
  const permissions = (payload.permissions ?? {}) as Row;
  const summary = (payload.summary ?? {}) as Row;
  return {
    permissions: {
      view: bool(permissions.view),
      manage: bool(permissions.manage),
      remove: bool(permissions.remove),
      export: bool(permissions.export),
    },
    companies: Array.isArray(payload.companies) ? (payload.companies as Row[]).map(normalizeCompany) : [],
    years: Array.isArray(payload.years) ? (payload.years as unknown[]).map((year) => Number(year)).filter(Boolean) : [],
    summary: {
      accidents: Number(summary.accidents) || 0,
      lastOccurrence: text(summary.lastOccurrence).slice(0, 10),
    },
  };
}

export const currency = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });

/**
 * Dinheiro em formato curto para o cartão do topo.
 *
 * "R$ 17,2 mil" cabe onde "R$ 17.234,90" não cabe, e o cartão é para dar a
 * ordem de grandeza. O valor exato continua na tabela de lançamentos e na
 * planilha exportada, que é onde alguém confere centavo.
 */
export function shortCurrency(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (absolute >= 1000) return `${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return currency(value);
}

export const dateLabel = (value: string) =>
  value ? value.split("-").reverse().join("/") : "—";

export const today = () => new Date().toISOString().slice(0, 10);

export function emptyDraft(companyId: string): AccidentDraft {
  return {
    id: "", companyId, occurredOn: today(), accidentType: "typical", bodyPart: "hand",
    sector: "", workShift: "morning", gender: "not_informed", employeeLabel: "",
    leaveDays: "0", expenseAmount: "0", catIssued: false, catNumber: "", description: "",
  };
}

export function draftFromRecord(record: WorkAccidentRecord): AccidentDraft {
  return {
    id: record.id,
    companyId: record.companyId,
    occurredOn: record.occurredOn,
    accidentType: record.accidentType,
    bodyPart: record.bodyPart,
    sector: record.sector,
    workShift: record.shift,
    gender: record.gender,
    employeeLabel: record.employeeLabel,
    leaveDays: String(record.leaveDays),
    expenseAmount: String(record.expenseAmount),
    catIssued: record.catIssued,
    catNumber: record.catNumber,
    description: record.description,
  };
}

/** O corpo da requisição. Número vazio vale zero — o cartão soma, e soma real. */
export function payloadFromDraft(draft: AccidentDraft) {
  return {
    companyId: draft.companyId,
    occurredOn: draft.occurredOn,
    accidentType: draft.accidentType,
    bodyPart: draft.bodyPart,
    sector: draft.sector,
    workShift: draft.workShift,
    gender: draft.gender,
    employeeLabel: draft.employeeLabel,
    leaveDays: Number(draft.leaveDays.replace(",", ".")) || 0,
    expenseAmount: Number(draft.expenseAmount.replace(",", ".")) || 0,
    catIssued: draft.catIssued,
    catNumber: draft.catIssued ? draft.catNumber : "",
    description: draft.description,
  };
}
