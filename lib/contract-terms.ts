import { ApiError } from "./api-errors.ts";
import { cleanText, optionalDate } from "./registrations.ts";
import {
  EXPERIENCE_MAX_DAYS, FIXED_TERM_MAX_DAYS, contractKinds, inclusiveDays, noticeDays, noticeEnd, noticeKinds,
  type ContractKind, type NoticeKind,
} from "./contract-terms-rules.ts";

export * from "./contract-terms-rules.ts";

/**
 * Elementos contratuais — o IT0016 (elementos do contrato) e o IT0019
 * (tarefas monitoradas) do SAP HCM, trazidos como prazos
 * (docs/engenharia-reversa-sap-hcm.md §16, item 6).
 *
 * Três perguntas de DP que viviam em planilha:
 *
 * - **quando acaba a experiência?** CLT art. 445, parágrafo único: até 90
 *   dias, admitida uma prorrogação (art. 451) — o contrato pode ter dois
 *   períodos, como 45 + 45;
 * - **quando acaba o prazo determinado?** CLT art. 445: até 2 anos;
 * - **quando termina o aviso prévio?** Lei 12.506/2011: 30 dias, mais 3 por
 *   ano completo de serviço, até 90.
 *
 * Só datas. O valor do aviso indenizado é calculado em ERP DP › Cálculos ›
 * Rescisão (lib/payroll-calc.ts), com a mesma conta de dias.
 *
 * Este arquivo é puro: não acessa banco nem sessão.
 */

export type ContractTermsInput = {
  contractKind: ContractKind;
  experienceFirstEnd: string | null;
  contractEnd: string | null;
  noticeKind: NoticeKind | null;
  noticeStart: string | null;
  noticeDays: number | null;
  noticeEnd: string | null;
  notes: string;
};

/**
 * Valida e completa os elementos contratuais. O fim do aviso e a quantidade
 * de dias nunca vêm de fora: são calculados aqui, para a tela e o banco não
 * divergirem da lei.
 */
export function parseContractTermsInput(body: Record<string, unknown>, admissionDate: string): ContractTermsInput {
  const contractKind = (contractKinds as readonly string[]).includes(String(body.contractKind))
    ? body.contractKind as ContractKind : "indefinite";
  let contractEnd = contractKind === "indefinite" ? null : optionalDate(body.contractEnd);
  let experienceFirstEnd = contractKind === "experience" ? optionalDate(body.experienceFirstEnd) : null;

  if (contractKind !== "indefinite") {
    if (!contractEnd) throw ApiError.badRequest("Informe a data de fim do contrato.", "CONTRACT_END_REQUIRED");
    if (contractEnd < admissionDate) throw ApiError.badRequest("O fim do contrato não pode ser anterior à admissão.", "CONTRACT_END_BEFORE_ADMISSION");
    const days = inclusiveDays(admissionDate, contractEnd);
    if (contractKind === "experience" && days > EXPERIENCE_MAX_DAYS) {
      throw ApiError.badRequest(`O contrato de experiência tem no máximo ${EXPERIENCE_MAX_DAYS} dias (CLT, art. 445, parágrafo único). Este teria ${days}.`, "EXPERIENCE_TOO_LONG");
    }
    if (contractKind === "fixed_term" && days > FIXED_TERM_MAX_DAYS) {
      throw ApiError.badRequest("O contrato por prazo determinado tem no máximo 2 anos (CLT, art. 445).", "FIXED_TERM_TOO_LONG");
    }
  }
  if (experienceFirstEnd) {
    if (experienceFirstEnd < admissionDate || !contractEnd || experienceFirstEnd >= contractEnd) {
      throw ApiError.badRequest("O fim do primeiro período precisa ficar entre a admissão e o fim da experiência.", "EXPERIENCE_FIRST_END_INVALID");
    }
  } else {
    experienceFirstEnd = null;
  }
  if (contractKind === "indefinite") contractEnd = null;

  const rawNoticeKind = String(body.noticeKind ?? "");
  const noticeStart = rawNoticeKind ? optionalDate(body.noticeStart) : null;
  let noticeKind: NoticeKind | null = null;
  let days: number | null = null;
  let end: string | null = null;
  if (rawNoticeKind) {
    if (!(noticeKinds as readonly string[]).includes(rawNoticeKind)) throw ApiError.badRequest("Tipo de aviso prévio inválido.", "NOTICE_KIND_INVALID");
    if (!noticeStart) throw ApiError.badRequest("Informe a data de início do aviso prévio.", "NOTICE_START_REQUIRED");
    if (noticeStart < admissionDate) throw ApiError.badRequest("O aviso prévio não pode começar antes da admissão.", "NOTICE_BEFORE_ADMISSION");
    noticeKind = rawNoticeKind as NoticeKind;
    days = noticeDays(admissionDate, noticeStart);
    end = noticeEnd(noticeStart, days);
  }

  return {
    contractKind, experienceFirstEnd, contractEnd,
    noticeKind, noticeStart, noticeDays: days, noticeEnd: end,
    notes: cleanText(body.notes, 1000),
  };
}

export function contractTermsFromRow(row: Record<string, unknown>) {
  const date = (value: unknown) => value == null || value === "" ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
  return {
    contractKind: (String(row.contract_kind ?? "indefinite")) as ContractKind,
    experienceFirstEnd: date(row.experience_first_end),
    contractEnd: date(row.contract_end),
    noticeKind: row.notice_kind ? String(row.notice_kind) as NoticeKind : null,
    noticeStart: date(row.notice_start),
    noticeDays: row.notice_days == null ? null : Number(row.notice_days),
    noticeEnd: date(row.notice_end),
    notes: String(row.notes ?? ""),
  };
}
