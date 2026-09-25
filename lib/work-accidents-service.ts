import { getD1 } from "../db";
import { ApiError } from "./api-errors.ts";
import { resolveAreaModule } from "./areas.ts";
import { cleanText } from "./clean-text.ts";
import { dateFromDatabase, optionalDate } from "./registrations.ts";
import {
  accidentBodyParts, accidentGenders, accidentShifts, accidentTypes, investigationDemandTitle,
  type AccidentBodyPart, type AccidentGender, type AccidentShift, type AccidentType,
  type WorkAccidentRecord,
} from "./work-accidents.ts";

type Database = ReturnType<typeof getD1>;

/**
 * A porta de entrada do lançamento de acidente.
 *
 * O vocabulário é o mesmo de `work-accidents.ts` — este arquivo só decide o que
 * o servidor aceita gravar. Ele existe separado porque aquele é puro e roda no
 * navegador; aqui entram `ApiError` e a recusa com código, que é coisa de
 * servidor.
 *
 * Criar e corrigir usam a **mesma** validação. Se a correção fosse mais frouxa
 * que o cadastro, bastaria lançar certo e editar depois para gravar um turno
 * que não existe — e o dashboard mostraria uma fatia que o CHECK do banco
 * recusaria em qualquer outro caminho.
 */
export type WorkAccidentInput = {
  companyId: string;
  occurredOn: string;
  accidentType: AccidentType;
  bodyPart: AccidentBodyPart;
  sector: string;
  workShift: AccidentShift;
  gender: AccidentGender;
  employeeLabel: string;
  leaveDays: number;
  expenseAmount: number;
  catIssued: boolean;
  catNumber: string;
  description: string;
};

function accidentEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, code: string): T {
  const candidate = cleanText(value, 60);
  if (!allowed.includes(candidate as T)) {
    throw ApiError.badRequest(`${field} inválido.`, code);
  }
  return candidate as T;
}

/** Dias de afastamento: inteiro, nunca negativo, e com teto que denuncia digitação. */
function leaveDaysOf(value: unknown) {
  const days = Number(value ?? 0);
  if (!Number.isFinite(days) || !Number.isInteger(days) || days < 0 || days > 3650) {
    throw ApiError.badRequest("Dias afastados deve ser um número inteiro entre 0 e 3650.", "SAFETY_INVALID_LEAVE_DAYS");
  }
  return days;
}

function expenseOf(value: unknown) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) {
    throw ApiError.badRequest("Despesa informada é inválida.", "SAFETY_INVALID_EXPENSE");
  }
  return Math.round(amount * 100) / 100;
}

export function parseWorkAccidentInput(body: Record<string, unknown>): WorkAccidentInput {
  const companyId = cleanText(body.companyId, 120);
  if (!companyId) throw ApiError.badRequest("Selecione a empresa do acidente.", "SAFETY_COMPANY_REQUIRED");
  const occurredOn = optionalDate(body.occurredOn, true);
  if (!occurredOn) throw ApiError.badRequest("Informe a data do acidente.", "SAFETY_DATE_REQUIRED");
  /* Acidente com data futura é digitação, não fato: ele entraria no gráfico do
     ano num mês que ainda não aconteceu e ninguém saberia de onde veio. A
     margem de um dia existe porque o servidor conta em UTC e o Brasil inteiro
     está atrás dele — sem ela, lançar um acidente da noite de hoje seria
     recusado como se fosse de amanhã. */
  const limit = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (occurredOn > limit) {
    throw ApiError.badRequest("A data do acidente não pode estar no futuro.", "SAFETY_DATE_IN_FUTURE");
  }

  const catIssued = body.catIssued === true || body.catIssued === 1 || body.catIssued === "1";
  const catNumber = cleanText(body.catNumber, 60);
  if (catNumber && !catIssued) {
    throw ApiError.badRequest(
      "O número da CAT só pode ser informado quando a CAT foi emitida.",
      "SAFETY_CAT_NUMBER_WITHOUT_ISSUE",
    );
  }

  return {
    companyId,
    occurredOn,
    accidentType: accidentEnum<AccidentType>(body.accidentType, accidentTypes, "Tipo do acidente", "SAFETY_INVALID_TYPE"),
    bodyPart: accidentEnum<AccidentBodyPart>(body.bodyPart, accidentBodyParts, "Parte do corpo atingida", "SAFETY_INVALID_BODY_PART"),
    sector: cleanText(body.sector, 120),
    workShift: accidentEnum<AccidentShift>(body.workShift, accidentShifts, "Turno", "SAFETY_INVALID_SHIFT"),
    gender: accidentEnum<AccidentGender>(body.gender ?? "not_informed", accidentGenders, "Gênero", "SAFETY_INVALID_GENDER"),
    employeeLabel: cleanText(body.employeeLabel, 160),
    leaveDays: leaveDaysOf(body.leaveDays),
    expenseAmount: expenseOf(body.expenseAmount),
    catIssued,
    catNumber,
    description: cleanText(body.description, 2000),
  };
}

const asText = (value: unknown) => value == null ? "" : String(value);

/**
 * Linha do banco para o registro que a tela e a apuração compartilham.
 *
 * A data passa por `dateFromDatabase`, e não por `String(...).slice(0, 10)`: o
 * driver PostgreSQL direto devolve `date` como objeto `Date`, e o corte cego
 * produziria "Thu Sep 1" em vez de "2026-09-10". O dashboard inteiro filtra por
 * essa string — com ela quebrada, todo acidente cai fora de todo período e a
 * tela abre vazia com o banco cheio.
 */
export function workAccidentFromRow(row: Record<string, unknown>): WorkAccidentRecord {
  return {
    id: asText(row.id),
    companyId: asText(row.company_id),
    companyName: asText(row.company_name),
    occurredOn: dateFromDatabase(row.occurred_on, "Data do acidente") ?? "",
    accidentType: asText(row.accident_type) as AccidentType,
    bodyPart: asText(row.body_part) as AccidentBodyPart,
    sector: asText(row.sector),
    shift: asText(row.work_shift) as AccidentShift,
    gender: asText(row.gender) as AccidentGender,
    employeeLabel: asText(row.employee_label),
    leaveDays: Number(row.leave_days) || 0,
    expenseAmount: Number(row.expense_amount) || 0,
    catNumber: asText(row.cat_number),
    catIssued: Number(row.cat_issued) === 1,
    description: asText(row.description),
    investigationCardId: row.investigation_card_id ? asText(row.investigation_card_id) : null,
  };
}

export type AccidentInvestigationDemandInput = {
  workspaceId: string;
  boardId: string;
  companyId: string;
  companyName: string;
  sector: string;
  occurredOn: string;
  actorEmail: string;
};

/**
 * Abre a demanda de investigação do acidente — plano de ação, passo 1 (§4.14).
 *
 * Mesmo raciocínio de `prepareDiscountDemand` (lib/epi-service.ts): é um
 * cartão comum do quadro, não um objeto novo. Checklist, comentário e anexo
 * já existem em Demandas; uma fila paralela só para investigação de acidente
 * seria uma segunda caixa de entrada que ninguém abriria.
 *
 * Diferente do desconto de EPI — que separa quem pede (SESMT) de quem decide
 * (DP) —, aqui as duas pontas são a mesma área: quem apura o acidente é quem
 * investiga. Por isso `safety.investigation` resolve as duas.
 *
 * Quem chama decide quando: não há gatilho automático por gravidade. É o
 * SESMT, no momento em que apura, que decide se este acidente precisa de
 * investigação — uma regra automática estaria adivinhando o que só uma pessoa
 * sabe.
 */
export async function prepareAccidentInvestigationDemand(d1: Database, input: AccidentInvestigationDemandInput) {
  const area = await resolveAreaModule(d1, input.workspaceId, "safety.investigation");
  const list = await d1.prepare(`SELECT id FROM fdp_lists WHERE board_id = ?
    ORDER BY (kind = 'new') DESC, position, id LIMIT 1`).bind(input.boardId).first<{ id: string }>();
  if (!list) {
    throw ApiError.badRequest(
      "O quadro deste grupo não tem nenhuma coluna, então o plano de ação não pode ser aberto. Crie uma coluna em Demandas e repita a operação.",
      "SAFETY_INVESTIGATION_LIST_MISSING",
    );
  }
  const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0")
    .bind(list.id).first<{ max_position: number }>();
  const cardId = crypto.randomUUID();
  const title = investigationDemandTitle(input.sector, input.occurredOn);
  const statement = d1.prepare(`INSERT INTO fdp_cards
    (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority,
     assignee_name, sla_status, position, source_type, created_by, sla_started_at, requester_area_id, responsible_area_id)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, 'OUTROS', 'high', '', 'safe', ?, 'automation', ?, CURRENT_TIMESTAMP, ?, ?)`)
    .bind(cardId, input.workspaceId, input.boardId, list.id, title,
      input.companyId, input.companyName, Number(position?.max_position ?? 0) + 1000, input.actorEmail,
      area.id, area.id);
  return { cardId, title, listId: list.id, statement, area };
}
