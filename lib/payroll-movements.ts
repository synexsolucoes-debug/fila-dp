/**
 * Movimentos para o Sankhya: as regras do módulo.
 *
 * Este arquivo é puro — não acessa banco, sessão nem rede — para poder ser
 * testado sozinho. Tudo que decide o que vai para a planilha do Importador de
 * Movimentos do Sankhya mora aqui.
 *
 * ## O layout
 *
 * A planilha tem uma aba, cabeçalho na linha 1, nesta ordem exata:
 * CODEMP, CODFUNC, REFERENCIA, TIPMOV, CODEVENTO, SEQUENCIA, INDICE, VLRMOV,
 * TIPEVENTO, UNIDADE. REFERENCIA é o primeiro dia da competência. SEQUENCIA
 * começa em 0 e sobe quando o mesmo colaborador recebe o mesmo evento mais de
 * uma vez na mesma competência. TIPEVENTO e UNIDADE vêm do catálogo (TFPEVE):
 * o Vinculato não escolhe por conta própria.
 *
 * ## Índice ou valor
 *
 * Evento de unidade V recebe valor em reais. Horas (H), dias (D) e quantidade
 * ou percentual (Q) vão no índice — o Sankhya transforma em dinheiro pela
 * fórmula do evento. Lançar um no lugar do outro é o erro mais comum da
 * planilha feita à mão, e por isso é bloqueio, não aviso.
 */

export const movementUnits = ["V", "H", "D", "Q"] as const;
export type MovementUnit = typeof movementUnits[number];

export const movementUnitLabels: Record<MovementUnit, string> = {
  V: "Valor em R$",
  H: "Horas no índice",
  D: "Dias no índice",
  Q: "Quantidade ou percentual no índice",
};

export type PayrollEventType = -1 | 0 | 1;

export const payrollEventTypeLabels: Record<string, string> = {
  "1": "Provento",
  "-1": "Desconto",
  "0": "Informativo",
};

export type PayrollCatalogEvent = {
  code: number;
  description: string;
  unit: MovementUnit;
  eventType: PayrollEventType;
  active: boolean;
};

export const MOVEMENT_EXPORT_HEADER = [
  "CODEMP", "CODFUNC", "REFERENCIA", "TIPMOV", "CODEVENTO",
  "SEQUENCIA", "INDICE", "VLRMOV", "TIPEVENTO", "UNIDADE",
] as const;

/** TIPMOV padrão, o que veio na planilha modelo do Sankhya. */
export const DEFAULT_TIPMOV = "A";

/** Teto de linhas por lote enviado de uma vez (colar do Excel). */
export const MAX_MOVEMENTS_PER_REQUEST = 500;

/* ------------------------------------------------------------------ */
/* Entrada                                                             */
/* ------------------------------------------------------------------ */

export function parseCompetence(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/u.test(value) ? value : null;
}

/** Primeiro dia da competência, no formato da coluna REFERENCIA (AAAA-MM-01). */
export function competenceReference(competence: string): string {
  return `${competence}-01`;
}

/** Último dia da competência (AAAA-MM-DD). */
export function competenceEnd(competence: string): string {
  const [year, month] = competence.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${competence}-${String(last).padStart(2, "0")}`;
}

/**
 * Número digitado do jeito brasileiro: "1.234,56", "12,5", "312.50" ou horas
 * "2:30" (vira 2,5). Vazio é zero. Texto que não é número devolve `null` — e
 * `null` vira erro na tela, nunca zero silencioso.
 */
export function parseDecimalInput(input: unknown): number | null {
  if (input === null || input === undefined) return 0;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  let value = String(input).trim().replace(/\s/gu, "").replace(/^R\$/iu, "");
  if (!value) return 0;
  const hours = value.match(/^(\d+):([0-5]?\d)$/u);
  if (hours) return Number(hours[1]) + Number(hours[2]) / 60;
  if (value.includes(",")) value = value.replace(/\./gu, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/u.test(value)) return null;
  return Number(value);
}

export function toCents(value: number): number {
  return Math.round(value * 100);
}

/** Índice com no máximo quatro casas, como a coluna do banco. */
export function roundIndex(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function normalizeTipmov(input: unknown): string {
  const value = String(input ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{1,2}$/u.test(value) ? value : DEFAULT_TIPMOV;
}

/* ------------------------------------------------------------------ */
/* Catálogo de eventos (TFPEVE)                                        */
/* ------------------------------------------------------------------ */

const cellText = (value: unknown) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const intOf = (value: unknown) => {
  const text = cellText(value).replace(/\.0+$/u, "");
  return /^-?\d+$/u.test(text) ? Number(text) : null;
};

/**
 * Lê as linhas da query de eventos do Sankhya ("Resultado da Query" da
 * TFPEVE). O cabeçalho é procurado — a exportação traz título e emissão antes
 * dele. Linha sem código ou sem descrição é ignorada e contada; código
 * repetido fica com a última ocorrência.
 */
export function parseEventCatalogRows(rows: unknown[][]): { events: PayrollCatalogEvent[]; skipped: number } {
  const headerIndex = rows.findIndex((row) => Array.isArray(row)
    && row.some((cell) => cellText(cell).toUpperCase() === "CODEVENTO")
    && row.some((cell) => cellText(cell).toUpperCase() === "DESCREVENTO"));
  if (headerIndex < 0) {
    throw new Error("Modelo Sankhya inválido: cabeçalhos CODEVENTO e DESCREVENTO não encontrados.");
  }
  const header = rows[headerIndex].map((cell) => cellText(cell).toUpperCase());
  const column = (name: string) => header.indexOf(name);
  const code = column("CODEVENTO");
  const description = column("DESCREVENTO");
  const unit = column("UNIDADE");
  const type = column("TIPEVENTO");
  const active = column("ATIVO");

  const byCode = new Map<number, PayrollCatalogEvent>();
  let skipped = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    if (!Array.isArray(row) || row.every((cell) => cellText(cell) === "")) continue;
    const eventCode = intOf(row[code]);
    const eventDescription = cellText(row[description]).replace(/\s+/gu, " ");
    if (!eventCode || eventCode <= 0 || !eventDescription) { skipped += 1; continue; }
    const unitText = unit >= 0 ? cellText(row[unit]).toUpperCase() : "V";
    const typeValue = type >= 0 ? intOf(row[type]) : 1;
    byCode.set(eventCode, {
      code: eventCode,
      description: eventDescription.slice(0, 200),
      unit: (movementUnits as readonly string[]).includes(unitText) ? unitText as MovementUnit : "V",
      eventType: typeValue === -1 || typeValue === 0 ? typeValue : 1,
      active: active < 0 || cellText(row[active]).toUpperCase() !== "N",
    });
  }
  const events = [...byCode.values()].sort((left, right) => left.code - right.code);
  if (!events.length) throw new Error("Nenhum evento foi encontrado na planilha.");
  if (events.length > 5000) throw new Error("A importação aceita no máximo 5.000 eventos por arquivo.");
  return { events, skipped };
}

/* ------------------------------------------------------------------ */
/* Códigos do Sankhya                                                  */
/* ------------------------------------------------------------------ */

/**
 * CODFUNC do colaborador. Quem veio da importação do Sankhya carrega
 * `external_id` = "CODEMP:CODFUNC"; quem foi cadastrado à mão usa a matrícula,
 * se for numérica. Sem nenhum dos dois, não há código — e a exportação bloqueia
 * nomeando a pessoa, em vez de adivinhar.
 */
export function sankhyaEmployeeCode(input: { externalId?: string | null; registrationNumber?: string | null }): string {
  const external = String(input.externalId ?? "").trim();
  const fromExternal = external.match(/^\d+:(\d+)$/u);
  if (fromExternal) return String(Number(fromExternal[1]));
  const registration = String(input.registrationNumber ?? "").trim();
  return /^\d+$/u.test(registration) ? String(Number(registration)) : "";
}

/** CODEMP: o "Código Sankhya" da empresa, só dígitos. */
export function sankhyaCompanyCode(externalCode: string | null | undefined): string {
  const value = String(externalCode ?? "").trim();
  return /^\d+$/u.test(value) ? String(Number(value)) : "";
}

/* ------------------------------------------------------------------ */
/* Conferência de um lançamento                                        */
/* ------------------------------------------------------------------ */

export type MovementEmployeeState = {
  employmentStatus: string;
  terminationDate: string | null;
};

export type MovementCheck = { level: "block" | "warn"; message: string };

/**
 * O que impede ou merece atenção num lançamento. Bloqueio impede gravar e
 * exportar; aviso aparece na tabela e não impede nada.
 */
export function checkMovement(input: {
  competence: string;
  indexValue: number;
  amountCents: number;
  event: PayrollCatalogEvent | null | undefined;
  employee: MovementEmployeeState | null | undefined;
}): MovementCheck[] {
  const checks: MovementCheck[] = [];
  const { event, employee } = input;
  if (input.indexValue < 0 || input.amountCents < 0) checks.push({ level: "block", message: "Índice e valor não podem ser negativos." });
  if (input.indexValue <= 0 && input.amountCents <= 0) checks.push({ level: "block", message: "Informe o índice ou o valor." });
  if (!event) {
    checks.push({ level: "block", message: "Evento fora do catálogo. Importe a TFPEVE atualizada." });
  } else {
    if (!event.active) checks.push({ level: "block", message: `Evento ${event.code} está inativo no Sankhya.` });
    if (event.unit === "V" && input.amountCents <= 0) {
      checks.push({ level: "block", message: `Evento ${event.code} é de valor: informe o valor em R$.` });
    }
    if (event.unit !== "V" && input.indexValue <= 0) {
      checks.push({ level: "block", message: `Evento ${event.code} é de ${event.unit === "H" ? "horas" : event.unit === "D" ? "dias" : "quantidade"}: informe o índice.` });
    }
    if (event.unit !== "V" && input.amountCents > 0) {
      checks.push({ level: "warn", message: "Evento de índice com valor preenchido: o Sankhya pode usar o valor no lugar da fórmula." });
    }
    if (event.unit === "V" && input.indexValue > 0) {
      checks.push({ level: "warn", message: "Evento de valor com índice preenchido." });
    }
  }
  if (!employee) {
    checks.push({ level: "block", message: "Colaborador não encontrado nesta empresa." });
  } else if (employee.terminationDate) {
    if (employee.terminationDate < competenceReference(input.competence)) {
      checks.push({ level: "block", message: "Colaborador desligado antes da competência." });
    } else if (employee.terminationDate <= competenceEnd(input.competence)) {
      checks.push({ level: "warn", message: "Colaborador desligado nesta competência: confira se o evento entra na rescisão." });
    }
  } else if (employee.employmentStatus === "terminated") {
    checks.push({ level: "warn", message: "Colaborador marcado como desligado." });
  } else if (employee.employmentStatus === "on_leave") {
    checks.push({ level: "warn", message: "Colaborador afastado." });
  }
  return checks;
}

export const hasBlock = (checks: MovementCheck[]) => checks.some((check) => check.level === "block");

/* ------------------------------------------------------------------ */
/* Sequência e exportação                                              */
/* ------------------------------------------------------------------ */

export type MovementForExport = {
  id: string;
  companyCode: string;
  employeeCode: string;
  employeeName: string;
  eventCode: number;
  indexValue: number;
  amountCents: number;
  createdAt: string;
};

/**
 * SEQUENCIA: 0 no primeiro lançamento de um colaborador num evento, 1, 2… nos
 * seguintes, na ordem em que foram lançados.
 */
export function assignSequences<T extends { companyCode: string; employeeCode: string; eventCode: number; createdAt: string; id: string }>(rows: T[]): Array<T & { sequence: number }> {
  const ordered = [...rows].sort((left, right) =>
    Number(left.companyCode) - Number(right.companyCode)
    || Number(left.employeeCode) - Number(right.employeeCode)
    || left.eventCode - right.eventCode
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id));
  const counters = new Map<string, number>();
  return ordered.map((row) => {
    const key = `${row.companyCode}:${row.employeeCode}:${row.eventCode}`;
    const sequence = counters.get(key) ?? 0;
    counters.set(key, sequence + 1);
    return { ...row, sequence };
  });
}

export type MovementExportRow = {
  companyCode: number;
  employeeCode: number;
  reference: string;
  tipmov: string;
  eventCode: number;
  sequence: number;
  indexValue: number;
  amount: number;
  eventType: PayrollEventType;
  unit: MovementUnit;
};

export type MovementExportProblem = { entryId: string; employeeName: string; message: string };

/**
 * Monta as linhas da planilha. Qualquer problema bloqueia o arquivo inteiro e
 * volta nomeado: uma planilha com metade das linhas é pior que nenhuma, porque
 * o Importador aceita e ninguém percebe o que ficou de fora.
 */
export function buildMovementExport(input: {
  competence: string;
  tipmov: string;
  entries: MovementForExport[];
  events: Map<number, PayrollCatalogEvent>;
}): { rows: MovementExportRow[]; problems: MovementExportProblem[] } {
  const problems: MovementExportProblem[] = [];
  for (const entry of input.entries) {
    const event = input.events.get(entry.eventCode);
    if (!entry.companyCode) problems.push({ entryId: entry.id, employeeName: entry.employeeName, message: "Empresa sem Código Sankhya (CODEMP) no cadastro." });
    if (!entry.employeeCode) problems.push({ entryId: entry.id, employeeName: entry.employeeName, message: "Colaborador sem código do Sankhya (CODFUNC) nem matrícula numérica." });
    if (!event) problems.push({ entryId: entry.id, employeeName: entry.employeeName, message: `Evento ${entry.eventCode} fora do catálogo.` });
    else if (!event.active) problems.push({ entryId: entry.id, employeeName: entry.employeeName, message: `Evento ${entry.eventCode} inativo no Sankhya.` });
  }
  if (problems.length) return { rows: [], problems };

  const tipmov = normalizeTipmov(input.tipmov);
  const reference = competenceReference(input.competence);
  const rows = assignSequences(input.entries).map((entry): MovementExportRow => {
    const event = input.events.get(entry.eventCode) as PayrollCatalogEvent;
    return {
      companyCode: Number(entry.companyCode),
      employeeCode: Number(entry.employeeCode),
      reference,
      tipmov,
      eventCode: entry.eventCode,
      sequence: entry.sequence,
      indexValue: roundIndex(entry.indexValue),
      amount: entry.amountCents / 100,
      eventType: event.eventType,
      unit: event.unit,
    };
  });
  return { rows, problems };
}

/* ------------------------------------------------------------------ */
/* Colar do Excel                                                      */
/* ------------------------------------------------------------------ */

export type PastedMovement = { line: number; employeeCode: string; eventCode: number; indexValue: number; amountCents: number };

/**
 * Linhas coladas do Excel: CODFUNC, CODEVENTO, ÍNDICE, VALOR — separadas por
 * tabulação ou ponto e vírgula. Linha de cabeçalho é pulada. Devolve as linhas
 * entendidas e o número das que não foram.
 */
export function parsePastedMovements(text: string): { rows: PastedMovement[]; invalidLines: number[] } {
  const rows: PastedMovement[] = [];
  const invalidLines: number[] = [];
  String(text ?? "").split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const cells = line.split(/\t|;/u).map((cell) => cell.trim());
    if (/^cod/iu.test(cells[0] ?? "")) return;
    const employeeCode = /^\d+$/u.test(cells[0] ?? "") ? String(Number(cells[0])) : "";
    const eventCode = /^\d+$/u.test(cells[1] ?? "") ? Number(cells[1]) : 0;
    const indexValue = parseDecimalInput(cells[2] ?? "");
    const amount = parseDecimalInput(cells[3] ?? "");
    if (!employeeCode || !eventCode || indexValue === null || amount === null) { invalidLines.push(index + 1); return; }
    rows.push({ line: index + 1, employeeCode, eventCode, indexValue: roundIndex(indexValue), amountCents: toCents(amount) });
  });
  return { rows, invalidLines };
}
