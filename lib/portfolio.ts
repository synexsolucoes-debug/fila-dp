/**
 * Carteira do DP — quem responde por cada empresa (Fase 1 do DP Operacional).
 *
 * O DP opera dezenas de CNPJs com dois ou três analistas e nenhuma
 * coordenação formal. A divisão de empresas morava numa planilha, e demanda
 * nova nascia sem dono até alguém lembrar de quem era aquela empresa. A
 * carteira transforma essa divisão em dado, e `resolveResponsible` é a regra
 * única que toda criação de demanda consulta:
 *
 * 1. a vigência da carteira que cobre a data;
 * 2. o titular dela, se não estiver ausente na data;
 * 3. senão o backup, se não estiver ausente;
 * 4. senão ninguém — e a demanda fica em "Sem responsável", visível para a
 *    equipe, em vez de cair silenciosamente com quem está de férias.
 *
 * Este arquivo é puro de propósito: a regra é testada sem banco
 * (`tests/dp-portfolio.test.mts`). A leitura e a gravação moram em
 * `lib/portfolio-service.ts`.
 *
 * Escolha explícita vence: quando quem abre a demanda escolhe o responsável,
 * ou a etapa inicial do processo nomeia um usuário, a carteira não é
 * consultada. Ela preenche o que ficou sem dono, não reescreve decisão.
 */

export const dpStatuses = ["interno", "a_internalizar", "sem_funcionarios", "terceirizado"] as const;
export type DpStatus = typeof dpStatuses[number];

export const dpStatusLabels: Record<DpStatus, string> = {
  interno: "Interno",
  a_internalizar: "A internalizar",
  sem_funcionarios: "Sem funcionários",
  terceirizado: "Terceirizado",
};

export function isDpStatus(value: unknown): value is DpStatus {
  return typeof value === "string" && (dpStatuses as readonly string[]).includes(value);
}

export type PortfolioTerm = {
  companyId: string;
  holderUserId: string;
  backupUserId: string | null;
  validFrom: string;
  /** `null` = vigente. */
  validTo: string | null;
};

export type MemberAbsence = {
  userId: string;
  startsOn: string;
  endsOn: string;
};

export type ResponsibleResolution = {
  userId: string | null;
  /** Por que esta pessoa: titular, backup (titular ausente) ou ninguém. */
  via: "holder" | "backup" | null;
  /** O titular da vigência, mesmo quando ausente — a tela mostra os dois. */
  holderUserId: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * A vigência que cobre a data; datas são `AAAA-MM-DD`, então comparam como texto.
 *
 * Duas vigências só se sobrepõem no dia de uma troca feita na mesma data em que
 * a anterior começou (ela termina e a nova começa no mesmo dia). Nesse dia vale
 * a mais nova: a aberta, ou a de início mais recente.
 */
function rank(term: PortfolioTerm) {
  return `${term.validTo === null ? 1 : 0}:${term.validFrom}`;
}

export function termOn(terms: readonly PortfolioTerm[], companyId: string, date: string) {
  let found: PortfolioTerm | null = null;
  for (const term of terms) {
    if (term.companyId !== companyId || term.validFrom > date) continue;
    if (term.validTo !== null && term.validTo < date) continue;
    if (!found || rank(term) > rank(found)) found = term;
  }
  return found;
}

/** Ausência inclusiva nas duas pontas: quem sai de férias no dia 10 já não recebe no dia 10. */
export function isAbsent(absences: readonly MemberAbsence[], userId: string, date: string) {
  return absences.some((absence) => absence.userId === userId && absence.startsOn <= date && absence.endsOn >= date);
}

/** `responsavelPara(empresa, data)` — a regra, sem consulta. */
export function resolveResponsible(
  terms: readonly PortfolioTerm[],
  absences: readonly MemberAbsence[],
  companyId: string | null | undefined,
  date: string,
): ResponsibleResolution {
  if (!companyId) return { userId: null, via: null, holderUserId: null };
  const term = termOn(terms, companyId, date);
  if (!term) return { userId: null, via: null, holderUserId: null };
  if (!isAbsent(absences, term.holderUserId, date)) {
    return { userId: term.holderUserId, via: "holder", holderUserId: term.holderUserId };
  }
  if (term.backupUserId && !isAbsent(absences, term.backupUserId, date)) {
    return { userId: term.backupUserId, via: "backup", holderUserId: term.holderUserId };
  }
  return { userId: null, via: null, holderUserId: term.holderUserId };
}

/** Raiz do CNPJ (8 dígitos) — o mesmo cálculo da coluna gerada `cnpj_root`. */
export function cnpjRoot(taxId: string) {
  const digits = taxId.replace(/\D/gu, "");
  return digits.length === 14 ? digits.slice(0, 8) : "";
}

/** Matriz = ordem 0001 — o mesmo cálculo da coluna gerada `is_headquarters`. */
export function isHeadquarters(taxId: string) {
  const digits = taxId.replace(/\D/gu, "");
  return digits.length === 14 && digits.slice(8, 12) === "0001";
}

export type PortfolioChangeInput = {
  companyId: string;
  holderUserId: string;
  backupUserId: string | null;
  validFrom: string;
};

/**
 * Valida a troca de carteira antes de qualquer leitura.
 *
 * Devolve a mensagem do primeiro problema, ou `null`. A troca é sempre "a
 * partir de uma data"; onde a vigência anterior termina é `closingDateFor`.
 */
export function validatePortfolioChange(input: Partial<PortfolioChangeInput>): string | null {
  if (!input.companyId) return "Selecione a empresa.";
  if (!input.holderUserId) return "Selecione o titular.";
  if (input.backupUserId && input.backupUserId === input.holderUserId) return "O backup precisa ser outra pessoa.";
  if (!isIsoDate(input.validFrom)) return "Informe a data de início da vigência.";
  return null;
}

/**
 * Onde a vigência que sai termina, quando a nova começa em `newFrom`.
 *
 * Normalmente o dia anterior. Se a troca é no mesmo dia em que a vigência atual
 * começou (corrigir uma carteira recém-cadastrada), a anterior fica com aquele
 * único dia e `termOn` dá preferência à nova. Data anterior ao início é recusada:
 * reescreveria quem respondia por um período que já passou.
 */
export function closingDateFor(openFrom: string, newFrom: string): string | null {
  if (newFrom < openFrom) return null;
  if (newFrom === openFrom) return openFrom;
  const cursor = new Date(`${newFrom}T12:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  return cursor.toISOString().slice(0, 10);
}

/**
 * Sincronização do Sankhya: registro de empresa `sem_funcionarios` é ignorado.
 *
 * Caso real: a 40 (Goianésia) é matriz da raiz da 33 (Goiânia) e o Sankhya
 * mostra os mesmos funcionários nas duas. O cadastro é único por CPF no grupo,
 * então importar a 40 tentaria mover para ela quem a operação mantém na 33 —
 * ou, sem o segredo do CPF no worker, criaria os mesmos funcionários em dobro.
 */
export function skipsSankhyaSync(dpStatus: string | null | undefined) {
  return dpStatus === "sem_funcionarios";
}

export const SANKHYA_SKIPPED_NO_EMPLOYEES = "Empresa marcada como sem funcionários na carteira do DP: o registro não é importado.";
