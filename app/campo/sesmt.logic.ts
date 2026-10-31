/**
 * Regras puras das telas do SESMT no Vinculato Campo.
 *
 * Ficam fora dos componentes por dois motivos. O primeiro é teste: a ordem da
 * lista de vencimentos é a decisão mais importante destas telas (quem o técnico
 * vai procurar primeiro no galpão), e ela precisa ser verificável sem navegador.
 * O segundo é que só há `import type` aqui — o arquivo roda direto no
 * `node --test` sem resolver o apelido `@/`.
 */
import type { EpiComplianceItem, EpiEmployeeCompliance } from "@/lib/epi-compliance";

type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);
const number = (value: unknown) => Number(value) || 0;
const day = (value: unknown) => text(value).slice(0, 10);

/* -------------------------------------------------------------------------- */
/* Vencimentos e trocas                                                       */
/* -------------------------------------------------------------------------- */

export type DueStatus = EpiComplianceItem["status"];
export type ActionableStatus = Exclude<DueStatus, "compliant">;

/**
 * A ordem é a de gravidade, e é a mesma do mapa de conformidade do painel:
 * quem está **sem** o EPI obrigatório está exposto agora; EPI ou CA vencido é
 * equipamento sem validade legal no corpo da pessoa; troca atrasada e troca
 * próxima são planejamento.
 */
export const actionableStatuses: readonly ActionableStatus[] = ["missing", "expired", "overdue", "due_soon"];

export const dueStatusLabels: Record<ActionableStatus, string> = {
  missing: "Sem o EPI",
  expired: "Vencido",
  overdue: "Troca atrasada",
  due_soon: "Troca próxima",
};

/**
 * Motivo da entrega sugerido a partir da pendência.
 *
 * A entrega aberta a partir desta lista já nasce com o motivo certo, porque é
 * ele que aparece no termo e no relatório de trocas. Deixar "Primeira entrega"
 * numa troca periódica faria o histórico contar uma admissão que não houve.
 */
export const dueDeliveryReason: Record<ActionableStatus, "first_delivery" | "expiry_replacement" | "periodic_exchange"> = {
  missing: "first_delivery",
  expired: "expiry_replacement",
  overdue: "periodic_exchange",
  due_soon: "periodic_exchange",
};

export type DueEntry = {
  key: string;
  employeeId: string;
  employeeName: string;
  registrationNumber: string;
  positionName: string;
  departmentName: string;
  productId: string;
  productName: string;
  caNumber: string;
  status: ActionableStatus;
  /** Data que dá a pendência: vencimento (CA ou produto) ou próxima troca. Vazio para "sem o EPI". */
  date: string;
  expiryReason: EpiComplianceItem["expiryReason"];
  heldQuantity: number;
  requiredQuantity: number;
  missingQuantity: number;
};

/** Achata o mapa de conformidade em pendências, uma por colaborador e EPI. */
export function dueEntries(employees: EpiEmployeeCompliance[]): DueEntry[] {
  const rank = new Map(actionableStatuses.map((status, index) => [status, index]));
  const entries: DueEntry[] = [];
  for (const employee of employees) {
    for (const item of employee.items) {
      if (item.status === "compliant") continue;
      entries.push({
        key: `${employee.id}:${item.productId}`,
        employeeId: employee.id,
        employeeName: employee.name,
        registrationNumber: employee.registrationNumber,
        positionName: employee.positionName,
        departmentName: employee.departmentName,
        productId: item.productId,
        productName: item.productName,
        caNumber: item.caNumber,
        status: item.status,
        date: item.status === "expired" ? item.expiresOn : item.status === "missing" ? "" : item.nextExchangeOn,
        expiryReason: item.expiryReason,
        heldQuantity: item.heldQuantity,
        requiredQuantity: item.requiredQuantity,
        missingQuantity: item.missingQuantity,
      });
    }
  }
  // Dentro da mesma gravidade, a data mais antiga primeiro: o que venceu há
  // mais tempo é o que está há mais tempo errado. Empate cai no nome, para a
  // lista não trocar de ordem a cada atualização.
  return entries.sort((left, right) =>
    (rank.get(left.status) ?? 9) - (rank.get(right.status) ?? 9)
    || (left.date || "").localeCompare(right.date || "")
    || left.employeeName.localeCompare(right.employeeName, "pt-BR")
    || left.productName.localeCompare(right.productName, "pt-BR"));
}

export function countByStatus(entries: DueEntry[]): Record<ActionableStatus, number> {
  const counts: Record<ActionableStatus, number> = { missing: 0, expired: 0, overdue: 0, due_soon: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  return counts;
}

/** Busca por nome, matrícula ou EPI — sem acento e sem caixa, como se digita de luva. */
export function matchesTerm(entry: DueEntry, term: string) {
  const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const query = fold(term.trim());
  if (!query) return true;
  return [entry.employeeName, entry.registrationNumber, entry.productName, entry.caNumber]
    .some((value) => fold(value).includes(query));
}

const DAY = 86_400_000;

/** Diferença em dias corridos, contada ao meio-dia para não cair no fuso. */
export function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from.slice(0, 10)}T12:00:00Z`);
  const end = Date.parse(`${to.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / DAY);
}

/**
 * A frase da data, relativa a hoje.
 *
 * "Venceu há 12 dias" diz mais a quem está no galpão do que "19/10": a pessoa
 * não precisa fazer a conta para saber se é urgente.
 */
export function dueDateLabel(entry: Pick<DueEntry, "status" | "date" | "expiryReason" | "missingQuantity">, today: string) {
  if (entry.status === "missing") {
    return entry.missingQuantity > 1 ? `Faltam ${entry.missingQuantity} unidades` : "Não está com o colaborador";
  }
  const days = entry.date ? daysBetween(today, entry.date) : null;
  if (days === null) return "Sem data";
  const subject = entry.status === "expired" ? (entry.expiryReason === "produto" ? "Validade" : "CA") : "Troca";
  if (days === 0) return `${subject} vence hoje`;
  if (days < 0) {
    const ago = -days;
    return entry.status === "expired"
      ? `${subject} venceu há ${ago} dia${ago === 1 ? "" : "s"}`
      : `Troca atrasada há ${ago} dia${ago === 1 ? "" : "s"}`;
  }
  return `${subject} em ${days} dia${days === 1 ? "" : "s"}`;
}

/* -------------------------------------------------------------------------- */
/* Higienização                                                               */
/* -------------------------------------------------------------------------- */

export type SanitizationStatus = "awaiting" | "in_progress";

export type SanitizationItem = {
  id: string;
  epiName: string;
  employeeName: string;
  quantity: number;
  returnedOn: string;
  status: SanitizationStatus;
  stockLocationId: string;
};

/**
 * Só o que ainda pede tratamento.
 *
 * A rota de devoluções filtra por `needs_sanitizing`, que continua 1 depois de
 * higienizado — é a condição de chegada, não o estado. O estado é
 * `sanitization_status`, e é ele que decide o que aparece aqui. Mostrar o já
 * concluído convidaria a concluir de novo, e o servidor recusaria com 409.
 */
export function pendingSanitization(rows: Row[]): SanitizationItem[] {
  return rows
    .filter((row) => row.sanitization_status === "awaiting" || row.sanitization_status === "in_progress")
    .map((row) => ({
      id: text(row.id),
      epiName: text(row.epi_name),
      employeeName: text(row.employee_social_name) || text(row.employee_full_name),
      quantity: number(row.quantity),
      returnedOn: day(row.returned_on),
      status: row.sanitization_status as SanitizationStatus,
      stockLocationId: text(row.stock_location_id),
    }))
    // Em andamento primeiro (já tem alguém mexendo), depois o que espera há mais tempo.
    .sort((left, right) =>
      Number(right.status === "in_progress") - Number(left.status === "in_progress")
      || left.returnedOn.localeCompare(right.returnedOn));
}

/* -------------------------------------------------------------------------- */
/* Descarte                                                                   */
/* -------------------------------------------------------------------------- */

export type DisposalItem = {
  id: string;
  epiName: string;
  employeeName: string;
  quantity: number;
  reason: string;
  disposalDate: string;
  origin: "manual" | "return" | "damage";
  caNumber: string;
};

export function awaitingDisposals(rows: Row[]): DisposalItem[] {
  return rows
    .filter((row) => row.status === "awaiting_disposal")
    .map((row) => ({
      id: text(row.id),
      epiName: text(row.epi_name),
      employeeName: text(row.employee_social_name) || text(row.employee_full_name),
      quantity: number(row.quantity),
      reason: text(row.disposal_reason),
      disposalDate: day(row.disposal_date),
      origin: (["manual", "return", "damage"].includes(text(row.origin_type)) ? text(row.origin_type) : "manual") as DisposalItem["origin"],
      caNumber: text(row.ca_number),
    }))
    .sort((left, right) => left.disposalDate.localeCompare(right.disposalDate));
}

/**
 * O que a confirmação faz com o estoque, dito antes do toque.
 *
 * Espelha `disposalTouchesStock` do servidor: só o descarte aberto à mão a
 * partir do estoque dá baixa. O que veio de devolução ou de dano já saiu do
 * estoque na entrega. A tela repete a regra em vez de importar `@/lib/epi` para
 * este arquivo continuar rodando no teste sem o apelido.
 */
export function disposalStockEffect(origin: DisposalItem["origin"], quantity: number) {
  return origin === "manual"
    ? `Dá baixa de ${quantity} unidade(s) do estoque do local de origem.`
    : "Não mexe no estoque: o equipamento já tinha saído na entrega.";
}
