import { getD1, getScopedD1 } from "../db";
import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";
import { optionalDate } from "./registrations.ts";
import { getTenantContext } from "./tenant-context.ts";
import {
  discountTitle, epiAttachmentEntities, epiDamageDecisions, epiDamageReasons, epiDeliveryStatuses,
  epiDisposalReasons, epiDiscountDecisions, epiDiscountTriggers, epiProductStatuses,
  epiRegistrationReasons, epiReturnConditions, epiTypes,
  type EpiAttachmentEntity, type EpiDamageDecision, type EpiDamageReason, type EpiDeliveryStatus,
  type EpiDisposalReason, type EpiDiscountDecision, type EpiDiscountTrigger, type EpiMovementType,
  type EpiProductStatus, type EpiRegistrationReason, type EpiReturnCondition, type EpiType,
} from "./epi.ts";

/**
 * Serviço do Controle de EPI: o que precisa de banco.
 *
 * O vocabulário e as regras de destino ficam em `lib/epi.ts`, que é puro. Aqui
 * ficam as três coisas que só existem contra o banco: validar a entrada da
 * requisição, gravar o razão de movimentações e abrir a demanda do DP.
 *
 * A abertura de demanda é a única costura do módulo com o resto do produto, e
 * ela é deliberadamente estreita: cria um cartão no quadro do grupo com o
 * título que a especificação fixa, e devolve o id. O EPI não sabe o que o DP
 * fará com ele; o DP não precisa saber que veio do EPI para tratá-lo.
 */

type Database = ReturnType<typeof getD1>;

/**
 * Conexão amarrada ao workspace pedido, e só a ele.
 *
 * Vale a mesma regra do registro de atividade: se existe contexto assíncrono e
 * ele aponta para outro grupo, a gravação é recusada em vez de acontecer no
 * tenant errado.
 */
function scopedTo(workspaceId: string) {
  const workspace = String(workspaceId ?? "").trim();
  if (!workspace) throw ApiError.forbidden("Contexto tenant inválido para o Controle de EPI.", "TENANT_CONTEXT_MISMATCH");
  const context = getTenantContext();
  if (context && context.workspaceId !== workspace) {
    throw ApiError.forbidden("Contexto tenant inválido para o Controle de EPI.", "TENANT_CONTEXT_MISMATCH");
  }
  return getScopedD1({ workspaceId: workspace, userId: context?.userId ?? null });
}

export function epiText(value: unknown, field: string, max = 160, required = false) {
  const text = cleanText(value, max);
  if (!text && required) throw ApiError.badRequest(`Informe ${field}.`, "EPI_REQUIRED_FIELD");
  return text;
}

export function epiQuantity(value: unknown, field: string, { min = 1, max = 1_000_000 } = {}) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw ApiError.badRequest(`${field} deve ser um número inteiro entre ${min} e ${max}.`, "EPI_INVALID_QUANTITY");
  }
  return number;
}

export function epiMoney(value: unknown, field: string) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0 || number > 100_000_000) {
    throw ApiError.badRequest(`${field} inválido.`, "EPI_INVALID_VALUE");
  }
  return Math.round(number * 100) / 100;
}

export function epiDate(value: unknown, field: string, required = true) {
  const parsed = optionalDate(value, false);
  if (!parsed && required) throw ApiError.badRequest(`Informe ${field}.`, "EPI_REQUIRED_DATE");
  return parsed;
}

function epiEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, code: string): T {
  const candidate = cleanText(value, 60);
  if (!allowed.includes(candidate as T)) {
    throw ApiError.badRequest(`${field} inválido.`, code);
  }
  return candidate as T;
}

export const parseEpiType = (value: unknown) => epiEnum<EpiType>(value, epiTypes, "Tipo de EPI", "EPI_INVALID_TYPE");
export const parseProductStatus = (value: unknown) => epiEnum<EpiProductStatus>(value, epiProductStatuses, "Status do EPI", "EPI_INVALID_STATUS");
export const parseRegistrationReason = (value: unknown) => epiEnum<EpiRegistrationReason>(value, epiRegistrationReasons, "Motivo", "EPI_INVALID_REASON");
export const parseDeliveryStatus = (value: unknown) => epiEnum<EpiDeliveryStatus>(value, epiDeliveryStatuses, "Status da entrega", "EPI_INVALID_DELIVERY_STATUS");
export const parseReturnCondition = (value: unknown) => epiEnum<EpiReturnCondition>(value, epiReturnConditions, "Condição do EPI", "EPI_INVALID_CONDITION");
export const parseDamageReason = (value: unknown) => epiEnum<EpiDamageReason>(value, epiDamageReasons, "Motivo da danificação", "EPI_INVALID_DAMAGE_REASON");
export const parseDamageDecision = (value: unknown) => epiEnum<EpiDamageDecision>(value, epiDamageDecisions, "Decisão", "EPI_INVALID_DECISION");
export const parseDisposalReason = (value: unknown) => epiEnum<EpiDisposalReason>(value, epiDisposalReasons, "Motivo do descarte", "EPI_INVALID_DISPOSAL_REASON");
export const parseDiscountTrigger = (value: unknown) => epiEnum<EpiDiscountTrigger>(value, epiDiscountTriggers, "Motivo do desconto", "EPI_INVALID_TRIGGER");
export const parseDiscountDecision = (value: unknown) => epiEnum<EpiDiscountDecision>(value, epiDiscountDecisions, "Decisão", "EPI_INVALID_DISCOUNT_DECISION");
export const parseAttachmentEntity = (value: unknown) => epiEnum<EpiAttachmentEntity>(value, epiAttachmentEntities, "Tipo de registro", "EPI_INVALID_ENTITY");

/** Ids de anexo enviados com o registro, para o razão apontar a evidência. */
export function attachmentIds(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.slice(0, 40).map((item) => cleanText(item, 60)).filter(Boolean);
}

/**
 * Confirma que cada anexo citado existe neste workspace antes de o razão
 * apontar para ele.
 *
 * Sem esta conferência o histórico poderia listar evidência inexistente — ou,
 * pior, o id de um anexo de outro grupo, que a RLS esconderia depois deixando
 * uma referência morta na linha que deveria provar alguma coisa.
 */
export async function verifiedAttachments(d1: Database, workspaceId: string, ids: readonly string[]) {
  if (!ids.length) return [] as string[];
  const found = await d1.prepare(`SELECT id FROM fdp_epi_attachments
    WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(workspaceId, ...ids).all<{ id: string }>();
  const known = new Set(found.results.map((row) => String(row.id)));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw ApiError.badRequest("Um dos anexos informados não existe mais. Reenvie o arquivo.", "EPI_ATTACHMENT_NOT_FOUND");
  return ids.filter((id) => known.has(id));
}

export type EpiProductRow = {
  id: string;
  company_id: string;
  name: string;
  ca_number: string;
  size: string;
  status: string;
  unit_value: string | number;
  stock_quantity: number;
};

/** O EPI existe, é desta empresa e é deste workspace — as três, numa consulta. */
export async function loadProduct(d1: Database, workspaceId: string, companyId: string, productId: string) {
  const product = await d1.prepare(`SELECT id, company_id, name, ca_number, size, status, unit_value, stock_quantity
    FROM fdp_epi_products WHERE workspace_id = ? AND company_id = ? AND id = ?`)
    .bind(workspaceId, companyId, productId).first<EpiProductRow>();
  if (!product) throw ApiError.notFound("EPI não encontrado nesta empresa.", "EPI_PRODUCT_NOT_FOUND");
  return product;
}

export type EpiEmployeeRow = { id: string; full_name: string; social_name: string; company_id: string; position_name: string | null; department_name: string | null };

export async function loadEmployee(d1: Database, workspaceId: string, companyId: string, employeeId: string) {
  const employee = await d1.prepare(`SELECT e.id, e.full_name, e.social_name, e.company_id,
      p.name AS position_name, dep.name AS department_name
    FROM fdp_employees e
    LEFT JOIN fdp_positions p ON p.workspace_id = e.workspace_id AND p.id = e.position_id
    LEFT JOIN fdp_departments dep ON dep.workspace_id = e.workspace_id AND dep.id = e.department_id
    WHERE e.workspace_id = ? AND e.company_id = ? AND e.id = ?`)
    .bind(workspaceId, companyId, employeeId).first<EpiEmployeeRow>();
  if (!employee) throw ApiError.notFound("Colaborador não encontrado nesta empresa.", "EPI_EMPLOYEE_NOT_FOUND");
  return employee;
}

export async function loadCompany(d1: Database, workspaceId: string, companyId: string) {
  const company = await d1.prepare("SELECT id, legal_name, trade_name, tax_id, status FROM fdp_companies WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, companyId).first<{ id: string; legal_name: string; trade_name: string; tax_id: string; status: string }>();
  if (!company) throw ApiError.badRequest("Empresa não encontrada.", "EPI_COMPANY_NOT_FOUND");
  return company;
}

export const employeeDisplayName = (employee: { full_name: string; social_name: string }) =>
  employee.social_name || employee.full_name;

export type EpiMovementInput = {
  workspaceId: string;
  companyId: string;
  cnpj: string;
  movementDate: string;
  movementType: EpiMovementType;
  productId: string;
  epiName: string;
  caNumber?: string;
  size?: string;
  employeeId?: string | null;
  employeeName?: string;
  quantity?: number;
  stockDelta?: number;
  unitValue?: number;
  reason?: string;
  condition?: string;
  status?: string;
  generateDpDemand?: boolean;
  demandId?: string | null;
  discountRequestId?: string | null;
  sourceType: "product" | "delivery" | "return" | "damage" | "disposal" | "discount";
  sourceId: string;
  responsibleId?: string | null;
  attachments?: readonly string[];
  notes?: string;
  createdBy: string;
};

/**
 * Uma linha do razão, pronta para entrar no mesmo lote da operação que a
 * originou.
 *
 * Gravar a movimentação numa chamada separada abriria a janela em que a entrega
 * aconteceu e o histórico não registrou — e o histórico é o que o colaborador
 * assina e o auditor lê.
 */
export function prepareEpiMovement(input: EpiMovementInput) {
  const d1 = scopedTo(input.workspaceId);
  return d1.prepare(`INSERT INTO fdp_epi_movements
    (id, workspace_id, company_id, movement_date, movement_type, cnpj, product_id, epi_name, ca_number, size,
     employee_id, employee_name, quantity, stock_delta, unit_value, movement_reason, epi_condition, status,
     generate_dp_demand, demand_id, discount_request_id, source_type, source_id, responsible_id,
     attachments_json, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`)
    .bind(
      crypto.randomUUID(), input.workspaceId, input.companyId, input.movementDate, input.movementType,
      input.cnpj, input.productId, input.epiName, input.caNumber ?? "", input.size ?? "",
      input.employeeId ?? null, input.employeeName ?? "", input.quantity ?? 0, input.stockDelta ?? 0,
      input.unitValue ?? 0, input.reason ?? "", input.condition ?? "", input.status ?? "",
      input.generateDpDemand ? 1 : 0, input.demandId ?? null, input.discountRequestId ?? null,
      input.sourceType, input.sourceId, input.responsibleId ?? null,
      JSON.stringify(input.attachments ?? []), input.notes ?? "", input.createdBy,
    );
}

/**
 * Movimenta o estoque sem deixá-lo negativo.
 *
 * A condição do saldo vai no `WHERE`, não num `if` antes do `UPDATE`: assim a
 * corrida entre duas entregas simultâneas termina com uma delas sem linha
 * afetada, em vez de com estoque negativo. Nenhuma linha afetada vira recusa
 * explícita, com a mensagem que diz o que fazer.
 */
export async function applyStockChange(d1: Database, workspaceId: string, productId: string, delta: number, status: EpiProductStatus | null, actorId: string) {
  const updated = await d1.prepare(`UPDATE fdp_epi_products
    SET stock_quantity = stock_quantity + ?,
        status = COALESCE(?, status),
        updated_by = ?, updated_at = now()
    WHERE workspace_id = ? AND id = ? AND stock_quantity + ? >= 0
    RETURNING id, stock_quantity`)
    .bind(delta, status, actorId, workspaceId, productId, delta)
    .first<{ id: string; stock_quantity: number }>();
  if (!updated) {
    throw ApiError.badRequest(
      "O estoque disponível deste EPI é menor do que a quantidade informada. Faça a reposição antes de continuar.",
      "EPI_INSUFFICIENT_STOCK",
    );
  }
  return updated;
}

export type DiscountDemandInput = {
  workspaceId: string;
  boardId: string;
  companyId: string;
  companyName: string;
  employeeName: string;
  actorEmail: string;
  summary: string;
};

/**
 * Abre a demanda do DP para analisar um possível desconto.
 *
 * É um cartão comum do quadro — aparece no módulo de Demandas, aceita
 * comentário, anexo e checklist, e entra na trilha de atividade como qualquer
 * outro. Isso é intencional: uma fila paralela só para EPI seria uma segunda
 * caixa de entrada que ninguém abriria.
 *
 * A coluna escolhida é a de entrada e, se ela não existir, a primeira do
 * quadro — a mesma tolerância que `POST /api/cards` já aplica, porque apagar a
 * coluna "Novas demandas" é permitido e não pode quebrar a abertura automática.
 */
export async function prepareDiscountDemand(d1: Database, input: DiscountDemandInput) {
  const list = await d1.prepare(`SELECT id FROM fdp_lists WHERE board_id = ?
    ORDER BY (kind = 'new') DESC, position, id LIMIT 1`).bind(input.boardId).first<{ id: string }>();
  if (!list) {
    throw ApiError.badRequest(
      "O quadro deste grupo não tem nenhuma coluna, então a demanda de análise não pode ser aberta. Crie uma coluna em Demandas e repita a operação.",
      "EPI_DEMAND_LIST_MISSING",
    );
  }
  const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0")
    .bind(list.id).first<{ max_position: number }>();
  const cardId = crypto.randomUUID();
  const title = discountTitle(input.employeeName);
  // Statement, não execução: a demanda precisa nascer no mesmo lote da
  // devolução ou da troca que a motivou. Criá-la antes deixaria, em caso de
  // falha do resto, uma demanda no quadro sem nenhum caso por trás — e alguém
  // do DP analisando um desconto que não existe.
  const statement = d1.prepare(`INSERT INTO fdp_cards
    (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority,
     assignee_name, sla_status, position, source_type, created_by, sla_started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OUTROS', 'normal', '', 'safe', ?, 'automation', ?, CURRENT_TIMESTAMP)`)
    .bind(cardId, input.workspaceId, input.boardId, list.id, title, input.summary,
      input.companyId, input.companyName, Number(position?.max_position ?? 0) + 1000, input.actorEmail);
  return { cardId, title, listId: list.id, statement };
}

export type DiscountRequestInput = {
  workspaceId: string;
  boardId: string;
  companyId: string;
  company: { legal_name: string; trade_name: string; tax_id: string };
  employee: { id: string; full_name: string; social_name: string };
  product: { id: string; name: string; ca_number: string; size: string; unit_value: string | number };
  deliveryId: string | null;
  deliveredOn: string | null;
  occurredOn: string;
  quantity: number;
  unitValue: number;
  trigger: EpiDiscountTrigger;
  triggerLabel: string;
  note: string;
  analystUserId: string | null;
  attachments: readonly string[];
  actorUserId: string;
  actorEmail: string;
};

/**
 * Abre a análise de desconto **e** a demanda do DP, nesta ordem, sempre juntas.
 *
 * Nenhum caminho do módulo desconta nada: o máximo que uma devolução ou uma
 * troca faz é chegar aqui. A análise nasce em "Aguardando análise DP", sem
 * valor decidido, e a decisão é um ato separado, de quem tem
 * `epi.discount.analyze`.
 *
 * Devolve os statements da análise e do razão para quem chama colocá-los no
 * mesmo lote da operação de origem — assim a devolução e a demanda que ela
 * gerou nascem na mesma transação, ou nenhuma das duas nasce.
 */
export async function createDiscountRequest(d1: Database, input: DiscountRequestInput) {
  const employeeName = employeeDisplayName(input.employee);
  const companyName = input.company.trade_name || input.company.legal_name;
  const totalValue = Math.round(input.unitValue * input.quantity * 100) / 100;
  const summary = discountDemandSummary({
    employeeName, companyName, cnpj: input.company.tax_id, epiName: input.product.name,
    caNumber: input.product.ca_number, size: input.product.size, quantity: input.quantity,
    unitValue: input.unitValue, totalValue, deliveredOn: input.deliveredOn, occurredOn: input.occurredOn,
    triggerLabel: input.triggerLabel, note: input.note,
  });
  const demand = await prepareDiscountDemand(d1, {
    workspaceId: input.workspaceId, boardId: input.boardId, companyId: input.companyId,
    companyName, employeeName, actorEmail: input.actorEmail, summary,
  });
  const id = crypto.randomUUID();
  const scoped = scopedTo(input.workspaceId);
  const statement = scoped.prepare(`INSERT INTO fdp_epi_discount_requests
    (id, workspace_id, company_id, employee_id, product_id, delivery_id, card_id, title, ca_number, size,
     quantity, unit_value, total_value, delivered_on, occurred_on, trigger_reason, reason_note, analyst_user_id,
     status, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_dp_analysis', ?, ?)`)
    .bind(id, input.workspaceId, input.companyId, input.employee.id, input.product.id, input.deliveryId,
      demand.cardId, demand.title, input.product.ca_number, input.product.size, input.quantity,
      input.unitValue, totalValue, input.deliveredOn, input.occurredOn, input.trigger, input.note,
      input.analystUserId, input.actorUserId, input.actorUserId);
  const movement = prepareEpiMovement({
    workspaceId: input.workspaceId, companyId: input.companyId, cnpj: input.company.tax_id,
    movementDate: input.occurredOn, movementType: "discount_analysis", productId: input.product.id,
    epiName: input.product.name, caNumber: input.product.ca_number, size: input.product.size,
    employeeId: input.employee.id, employeeName, quantity: input.quantity, stockDelta: 0,
    unitValue: input.unitValue, reason: input.trigger, status: "awaiting_dp_analysis",
    generateDpDemand: true, demandId: demand.cardId, discountRequestId: id, sourceType: "discount",
    sourceId: id, responsibleId: input.analystUserId, attachments: input.attachments,
    notes: input.note, createdBy: input.actorUserId,
  });
  // A ordem é obrigatória: o cartão antes da análise, porque a análise aponta
  // para ele; a análise antes do razão, porque o razão aponta para os dois.
  return { id, cardId: demand.cardId, title: demand.title, totalValue, statements: [demand.statement, statement, movement] };
}

/** Resumo que vai no corpo da demanda: quem, qual EPI, quanto e por quê. */
export function discountDemandSummary(fields: {
  employeeName: string;
  companyName: string;
  cnpj: string;
  epiName: string;
  caNumber: string;
  size: string;
  quantity: number;
  unitValue: number;
  totalValue: number;
  deliveredOn: string | null;
  occurredOn: string;
  triggerLabel: string;
  note: string;
}) {
  const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
  return [
    "Análise de possível desconto de EPI aberta automaticamente pelo Controle de EPI.",
    "",
    `Colaborador: ${fields.employeeName}`,
    `Empresa: ${fields.companyName}${fields.cnpj ? ` (CNPJ ${fields.cnpj})` : ""}`,
    `EPI: ${fields.epiName}${fields.caNumber ? ` · CA ${fields.caNumber}` : ""}${fields.size ? ` · Tamanho ${fields.size}` : ""}`,
    `Quantidade: ${fields.quantity} · Valor unitário: ${money(fields.unitValue)} · Valor em análise: ${money(fields.totalValue)}`,
    `Data da entrega: ${fields.deliveredOn ?? "não informada"}`,
    `Data da ocorrência: ${fields.occurredOn}`,
    `Motivo: ${fields.triggerLabel}`,
    fields.note ? `Observação: ${fields.note}` : "",
    "",
    "O desconto não foi lançado. Esta demanda existe para o Departamento Pessoal analisar e decidir.",
  ].join("\n");
}
