/**
 * Elementos contratuais — as regras puras, sem dependência nenhuma, para a
 * tela e o servidor usarem a mesma conta (a tela mostra a prévia do aviso
 * prévio enquanto a pessoa digita; o servidor recalcula ao salvar).
 * Validação de entrada e leitura do banco ficam em `lib/contract-terms.ts`.
 */

export const contractKinds = ["indefinite", "experience", "fixed_term"] as const;
export type ContractKind = typeof contractKinds[number];
export const contractKindLabels: Record<ContractKind, string> = {
  indefinite: "Prazo indeterminado",
  experience: "Contrato de experiência",
  fixed_term: "Prazo determinado",
};

export const noticeKinds = ["worked", "indemnified"] as const;
export type NoticeKind = typeof noticeKinds[number];
export const noticeKindLabels: Record<NoticeKind, string> = {
  worked: "Aviso trabalhado",
  indemnified: "Aviso indenizado",
};

/** CLT art. 445, parágrafo único. */
export const EXPERIENCE_MAX_DAYS = 90;
/** CLT art. 445. Dois anos contados em dias corridos: 730 (o dia da admissão conta). */
export const FIXED_TERM_MAX_DAYS = 730;

export function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Dias corridos de `start` a `end`, contando os dois. */
export function inclusiveDays(start: string, end: string) {
  return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000) + 1;
}

/** Anos completos de serviço entre a admissão e a data. */
export function completeYears(admissionDate: string, at: string) {
  const [ay, am, ad] = admissionDate.split("-").map(Number);
  const [y, m, d] = at.split("-").map(Number);
  let years = y - ay;
  if (m < am || (m === am && d < ad)) years -= 1;
  return Math.max(0, years);
}

/**
 * Dias de aviso prévio (Lei 12.506/2011): 30, mais 3 por ano completo de
 * serviço até a data de início do aviso, com teto de 90.
 */
export function noticeDays(admissionDate: string, noticeStart: string) {
  return Math.min(90, 30 + 3 * completeYears(admissionDate, noticeStart));
}

/** Último dia do aviso: o dia de início conta como o primeiro. */
export function noticeEnd(noticeStart: string, days: number) {
  return addDays(noticeStart, days - 1);
}

export type ContractTermsDates = {
  contractKind: ContractKind;
  experienceFirstEnd: string | null;
  contractEnd: string | null;
  noticeEnd: string | null;
};

export type ContractDeadline = {
  kind: "experience_first_end" | "contract_end" | "notice_end";
  date: string;
  label: string;
  action: string;
};

/**
 * Os prazos que o DP precisa decidir antes de vencer, em ordem. O que já
 * passou continua na lista — vencido é exatamente o que precisa de atenção.
 */
export function contractDeadlines(terms: ContractTermsDates): ContractDeadline[] {
  const result: ContractDeadline[] = [];
  if (terms.experienceFirstEnd) {
    result.push({ kind: "experience_first_end", date: terms.experienceFirstEnd, label: "Fim do 1º período de experiência", action: "Decidir: prorrogar a experiência ou encerrar" });
  }
  if (terms.contractEnd) {
    result.push(terms.contractKind === "experience"
      ? { kind: "contract_end", date: terms.contractEnd, label: "Fim da experiência", action: "Decidir: efetivar ou encerrar o contrato" }
      : { kind: "contract_end", date: terms.contractEnd, label: "Fim do prazo determinado", action: "Decidir: encerrar, prorrogar ou converter em indeterminado" });
  }
  if (terms.noticeEnd) {
    result.push({ kind: "notice_end", date: terms.noticeEnd, label: "Fim do aviso prévio", action: "Preparar o desligamento na data" });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

