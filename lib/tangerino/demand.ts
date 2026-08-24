import type { getD1 } from "../../db/index.ts";
import { addBusinessDays } from "../fila-dp-relations.ts";
import { workingDayMinutes } from "../fila-dp-sla.ts";
import { prepareAuditEvent } from "../fila-dp-db.ts";
import { recordIntegrationEvent } from "../integration-events.ts";
import { prepareDomainEvent } from "../outbox.ts";
import type { ParsedAdmission } from "./types.ts";
import { isContractDataStage } from "./parser.ts";

type Database = ReturnType<typeof getD1>;

const PROCESS_TYPE = "CONCILIAÇÃO CADASTRAL";
const DEFAULT_SLA_DAYS = 2;
const STALE_EVENT_MINUTES = 10;

type DemandTarget = {
  employee_id: string;
  full_name: string;
  registration_number: string;
  admission_date: string;
  company_id: string;
  company_name: string;
  board_id: string;
  list_id: string;
  sla_behavior: string;
  business_days_json: unknown;
  day_start: string;
  day_end: string;
  target_business_days: number | null;
  template_id: string | null;
  template_sla_days: number | null;
};

export type TangerinoDemandResult =
  | { status: "not_target_stage"; cardId: null }
  | { status: "created"; cardId: string }
  | { status: "already_created"; cardId: string }
  | { status: "being_created"; cardId: null };

function text(value: unknown, max = 160) {
  return value == null ? "" : String(value).trim().slice(0, max);
}

function businessDays(value: unknown) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) {
      const days = parsed.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
      if (days.length) return [...new Set(days)];
    }
  } catch { /* Configuração inválida cai no calendário comercial padrão. */ }
  return [1, 2, 3, 4, 5];
}

function safeConfig(value: unknown) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function slaStatus(dueAt: string, behavior: string) {
  if (behavior === "paused") return "paused";
  if (behavior === "completed") return "completed";
  const today = new Date().toISOString().slice(0, 10);
  if (dueAt.slice(0, 10) < today) return "overdue";
  if (dueAt.slice(0, 10) === today) return "warning";
  return "safe";
}

async function loadDemandTarget(
  d1: Database,
  workspaceId: string,
  integrationId: string,
  employeeId: string,
) {
  const integration = await d1.prepare(`SELECT config_json FROM fdp_integrations
    WHERE workspace_id = ? AND id = ? AND channel = 'tangerino_browser'`)
    .bind(workspaceId, integrationId).first<{ config_json: unknown }>();
  if (!integration) throw new Error("Integração do Agente Tangerino não encontrada.");
  const configuredBoardId = text(safeConfig(integration.config_json).boardId, 80);

  const [target, holidays] = await Promise.all([
    d1.prepare(`SELECT employee.id AS employee_id, employee.full_name, employee.registration_number,
        employee.admission_date::text, employee.company_id,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name,
        board.id AS board_id, list.id AS list_id, list.sla_behavior,
        settings.business_days_json, settings.day_start, settings.day_end,
        policy.target_business_days,
        template.id AS template_id, template.default_sla_days AS template_sla_days
      FROM fdp_employees employee
      JOIN fdp_companies company
        ON company.workspace_id = employee.workspace_id AND company.id = employee.company_id
      CROSS JOIN LATERAL (
        SELECT candidate.id FROM fdp_boards candidate
        WHERE candidate.workspace_id = employee.workspace_id
          AND (? = '' OR candidate.id = ?)
          AND EXISTS (SELECT 1 FROM fdp_lists entry
            WHERE entry.workspace_id = candidate.workspace_id AND entry.board_id = candidate.id AND entry.kind = 'new')
        ORDER BY candidate.created_at, candidate.name LIMIT 1
      ) board
      JOIN fdp_lists list
        ON list.workspace_id = employee.workspace_id AND list.board_id = board.id AND list.kind = 'new'
      LEFT JOIN fdp_workspace_settings settings ON settings.workspace_id = employee.workspace_id
      LEFT JOIN fdp_sla_policies policy
        ON policy.workspace_id = employee.workspace_id AND policy.process_type = ? AND policy.active = 1
      LEFT JOIN LATERAL (
        SELECT candidate.id, candidate.default_sla_days FROM fdp_process_templates candidate
        WHERE candidate.workspace_id = employee.workspace_id AND candidate.process_type = ? AND candidate.active = 1
        ORDER BY candidate.position LIMIT 1
      ) template ON TRUE
      WHERE employee.workspace_id = ? AND employee.id = ?`)
      .bind(configuredBoardId, configuredBoardId, PROCESS_TYPE, PROCESS_TYPE, workspaceId, employeeId)
      .first<DemandTarget>(),
    d1.prepare("SELECT holiday_date::text FROM fdp_business_holidays WHERE workspace_id = ?")
      .bind(workspaceId).all<{ holiday_date: string }>(),
  ]);
  if (!target) {
    throw new Error(configuredBoardId
      ? "O quadro configurado para o Agente Tangerino não possui uma coluna de entrada."
      : "Crie um quadro com coluna de entrada para receber as demandas do Agente Tangerino.");
  }
  return { target, holidays: new Set(holidays.results.map((row) => text(row.holiday_date, 10))) };
}

function demandDescription(target: DemandTarget, admission: ParsedAdmission, externalAdmissionId: string) {
  return [
    "A admissão chegou à etapa Dados contratuais no Tangerino e está pronta para cadastro no ERP.",
    `Colaborador: ${target.full_name}.`,
    `Data de admissão: ${admission.admissionDate || target.admission_date}.`,
    `Matrícula: ${target.registration_number || "será registrada após o cadastro no ERP"}.`,
    `Empresa: ${target.company_name}.`,
    `Processo Tangerino: ${externalAdmissionId}.`,
    `Etapa confirmada pelo agente: ${admission.stage}.`,
    "Os documentos e a ficha cadastral podem ser trazidos da Sólides pela aba Anexos, somente após autorização específica nesta demanda.",
  ].join("\n").slice(0, 4000);
}

const checklist = [
  "Conferir os dados contratuais no Tangerino",
  "Conferir empresa, cargo, salário, jornada e data de admissão",
  "Autorizar e conferir os documentos e a ficha cadastral da Sólides nos anexos",
  "Realizar a admissão no ERP",
  "Registrar no cartão a matrícula ou o código gerado pelo ERP",
  "Tratar eventuais divergências cadastrais",
  "Concluir manualmente a demanda no Vinculato",
];

/**
 * Abre uma única demanda quando a etapa visual chega a Dados contratuais.
 *
 * A chave do evento combina o processo do Tangerino e a data da admissão. Ela
 * protege tanto consultas repetidas quanto uma readmissão futura da mesma
 * pessoa. O cartão e o fechamento do evento são gravados no mesmo `batch`
 * transacional: ou os dois existem, ou nenhum existe.
 */
export async function ensureTangerinoErpDemand(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  employeeId: string;
  consultationId: string;
  externalAdmissionId: string;
  admission: ParsedAdmission;
}): Promise<TangerinoDemandResult> {
  if (!isContractDataStage(input.admission.stage)) return { status: "not_target_stage", cardId: null };

  const { target, holidays } = await loadDemandTarget(d1, input.workspaceId, input.integrationId, input.employeeId);
  const externalAdmissionId = text(input.externalAdmissionId, 120) || input.employeeId;
  const admissionDate = text(input.admission.admissionDate, 10) || text(target.admission_date, 10) || "sem-data";
  const externalEventId = `admission-contract-data:${externalAdmissionId}:${admissionDate}`;
  const event = await recordIntegrationEvent(d1, {
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    connector: "tangerino_browser",
    eventType: "admission.contract_data_ready",
    externalEventId,
    source: "polling",
    payload: {
      employeeId: input.employeeId,
      consultationId: input.consultationId,
      externalAdmissionId,
      admissionDate,
      stage: input.admission.stage,
    },
  });
  if (event.event.status === "processed" && event.event.result_id) {
    return { status: "already_created", cardId: event.event.result_id };
  }

  // Uma execução interrompida antes do batch final pode deixar o evento em
  // `processing`. Depois da janela curta ele volta a ser reivindicável; antes
  // disso outro worker não cria a mesma demanda em paralelo.
  const claimed = await d1.prepare(`UPDATE fdp_integration_events
      SET status = 'processing', updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND id = ?
      AND (status IN ('received', 'error', 'reprocessed')
        OR (status = 'processing' AND updated_at <= CURRENT_TIMESTAMP - make_interval(mins => ?)))
    RETURNING id`)
    .bind(input.workspaceId, event.event.id, STALE_EVENT_MINUTES).first<{ id: string }>();
  if (!claimed) return { status: "being_created", cardId: null };

  const days = businessDays(target.business_days_json);
  const dayStart = text(target.day_start, 5) || "08:00";
  const dayEnd = text(target.day_end, 5) || "18:00";
  const targetDays = Math.max(1, Number(target.template_sla_days ?? target.target_business_days ?? DEFAULT_SLA_DAYS));
  const dueDate = addBusinessDays(new Date().toISOString().slice(0, 10), targetDays, days, holidays);
  const dueAt = `${dueDate}T${dayEnd}`;
  const cardId = crypto.randomUUID();
  const title = `Admissão ERP — ${target.full_name}`.slice(0, 160);

  await d1.batch([
    d1.prepare(`INSERT INTO fdp_cards
        (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type,
         priority, due_at, sla_status, position, source_type, created_by, sla_target_minutes,
         sla_started_at, process_template_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?,
        COALESCE((SELECT MAX(position) FROM fdp_cards WHERE workspace_id = ? AND list_id = ? AND archived = 0), 0) + 1000,
        'integration', 'integracao:tangerino_browser', ?, CURRENT_TIMESTAMP, ?)`)
      .bind(cardId, input.workspaceId, target.board_id, target.list_id, title,
        demandDescription(target, input.admission, externalAdmissionId), target.company_id, target.company_name,
        PROCESS_TYPE, dueAt, slaStatus(dueAt, target.sla_behavior), input.workspaceId, target.list_id,
        targetDays * workingDayMinutes({ dayStart, dayEnd }), target.template_id),
    ...checklist.map((item, index) => d1.prepare(`INSERT INTO fdp_checklist_items
        (id, workspace_id, card_id, title, completed, position) VALUES (?, ?, ?, ?, 0, ?)`)
      .bind(crypto.randomUUID(), input.workspaceId, cardId, item, (index + 1) * 1000)),
    d1.prepare(`INSERT INTO fdp_activity_events
        (id, workspace_id, card_id, actor_email, event_type, payload_json)
      VALUES (?, ?, ?, 'SYSTEM', 'tangerino.erp_demand_created', ?::jsonb)`)
      .bind(crypto.randomUUID(), input.workspaceId, cardId, JSON.stringify({
        consultationId: input.consultationId, externalAdmissionId, admissionDate, stage: input.admission.stage,
      })),
    d1.prepare(`UPDATE fdp_integration_events SET status = 'processed', result_type = 'card', result_id = ?,
        error_code = '', error_message = '', processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND status = 'processing'`)
      .bind(cardId, input.workspaceId, event.event.id),
    prepareDomainEvent(d1, {
      workspaceId: input.workspaceId,
      eventType: "process.instance_started",
      entityType: "card",
      entityId: cardId,
      payload: {
        cardId, employeeId: input.employeeId, companyId: target.company_id,
        trigger: "tangerino.contract_data_ready", occurredAt: new Date().toISOString(),
      },
    }),
    prepareAuditEvent({
      workspaceId: input.workspaceId,
      actorType: "system",
      actorEmail: "SYSTEM",
      action: "tangerino.admission.erp_demand_created",
      entityType: "card",
      entityId: cardId,
      after: {
        employeeId: input.employeeId, consultationId: input.consultationId,
        externalAdmissionId, admissionDate, stage: input.admission.stage,
      },
    }),
  ]);
  return { status: "created", cardId };
}
