/**
 * Admissões abertas na Sólides viram demanda no Vinculato.
 *
 * ## O sentido do fluxo, que estava invertido
 *
 * O agente sabia fazer uma coisa só: pegar um colaborador que **já existe** no
 * Vinculato e conferir a admissão dele na origem. Isso serve para conciliar
 * cadastro — e não serve para o trabalho que o DP realmente faz.
 *
 * Quem aparece em "Dados contratuais" na Sólides é exatamente quem **ainda não
 * foi cadastrado no ERP**. Essa pessoa nunca esteve no Sankhya, logo nunca
 * esteve em `fdp_employees`, logo a varredura antiga não tinha por onde
 * começar. O agente subia, funcionava, e não encontrava ninguém — que foi o que
 * aconteceu em produção.
 *
 * Aqui o sentido é o certo: a admissão aberta na origem é descoberta, vira um
 * cartão na fila e alguém a assume, confere a ficha e cadastra no ERP.
 *
 * ## O que este módulo não faz
 *
 * Não cria colaborador. A lista de colaboradores é o espelho do ERP, e encher
 * ela de gente que ainda não está lá transformaria toda conferência entre os
 * dois sistemas em divergência falsa. A admissão vive como o que é — processo
 * em aberto na origem — até o cadastro acontecer de verdade.
 */
import type { getD1 } from "../../db/index.ts";
import { addBusinessDays } from "../fila-dp-relations.ts";
import { workingDayMinutes } from "../fila-dp-sla.ts";
import { prepareAuditEvent } from "../fila-dp-db.ts";
import { recordIntegrationEvent } from "../integration-events.ts";
import { prepareDomainEvent } from "../outbox.ts";
import { isContractDataStage } from "./parser.ts";
import type { ParsedAdmission } from "./types.ts";

type Database = ReturnType<typeof getD1>;

const PROCESS_TYPE = "CONCILIAÇÃO CADASTRAL";
const DEFAULT_SLA_DAYS = 2;
const STALE_EVENT_MINUTES = 10;

/** O que o DP precisa fazer, na ordem em que faz. */
const checklist = [
  "Assumir a demanda",
  "Conferir a ficha de contratação preparada pelo agente",
  "Conferir empresa, cargo, salário, jornada e data de admissão",
  "Cadastrar a admissão no ERP a partir da ficha",
  "Registrar no cartão a matrícula gerada pelo ERP",
  "Tratar divergências entre a ficha e os documentos",
  "Concluir a demanda",
];

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

export type OpenAdmissionRecord = {
  id: string;
  externalAdmissionId: string;
  displayName: string;
  stage: string;
  cardId: string | null;
};

/**
 * Guarda a admissão vista na origem, sem duplicar quem já foi visto.
 *
 * `ON CONFLICT` sobre o índice do processo é o que permite a descoberta rodar
 * de novo a cada ciclo: reencontrar a mesma admissão atualiza o que mudou (a
 * etapa, sobretudo) em vez de abrir uma segunda demanda para a mesma pessoa.
 */
export async function recordOpenAdmission(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  externalAdmissionId: string;
  displayName: string;
  roleTitle?: string;
  admission: ParsedAdmission;
}): Promise<OpenAdmissionRecord | null> {
  const externalAdmissionId = text(input.externalAdmissionId, 120);
  const displayName = text(input.displayName, 200);
  if (!externalAdmissionId || !displayName) return null;

  const row = await d1.prepare(`INSERT INTO fdp_tangerino_open_admissions
      (id, workspace_id, integration_id, external_admission_id, display_name, role_title,
       raw_status, normalized_status, stage, admission_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT ("workspace_id", "integration_id", "external_admission_id") DO UPDATE SET
      display_name = EXCLUDED.display_name,
      role_title = EXCLUDED.role_title,
      raw_status = EXCLUDED.raw_status,
      normalized_status = EXCLUDED.normalized_status,
      stage = EXCLUDED.stage,
      admission_date = EXCLUDED.admission_date,
      last_seen_at = CURRENT_TIMESTAMP,
      closed_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, external_admission_id, display_name, stage, card_id`)
    .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, externalAdmissionId,
      displayName, text(input.roleTitle, 160), text(input.admission.rawStatus, 120),
      text(input.admission.normalizedStatus, 40) || "UNKNOWN", text(input.admission.stage, 160),
      text(input.admission.admissionDate, 10))
    .first<{ id: string; external_admission_id: string; display_name: string; stage: string; card_id: string | null }>();

  return row
    ? {
      id: String(row.id),
      externalAdmissionId: String(row.external_admission_id),
      displayName: String(row.display_name),
      stage: String(row.stage),
      cardId: row.card_id ? String(row.card_id) : null,
    }
    : null;
}

type DemandPlacement = {
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

async function loadPlacement(d1: Database, workspaceId: string, integrationId: string) {
  const integration = await d1.prepare(`SELECT config_json FROM fdp_integrations
    WHERE workspace_id = ? AND id = ? AND channel = 'tangerino_browser'`)
    .bind(workspaceId, integrationId).first<{ config_json: unknown }>();
  if (!integration) throw new Error("Integração do Agente Tangerino não encontrada.");
  const config = safeConfig(integration.config_json);
  const configuredBoardId = text(config.boardId, 80);
  const configuredCompanyId = text(config.companyId, 80);

  const [placement, holidays, company] = await Promise.all([
    d1.prepare(`SELECT board.id AS board_id, list.id AS list_id, list.sla_behavior,
        settings.business_days_json, settings.day_start, settings.day_end,
        policy.target_business_days,
        template.id AS template_id, template.default_sla_days AS template_sla_days
      FROM (SELECT ?::text AS workspace_id) base
      CROSS JOIN LATERAL (
        SELECT candidate.id FROM fdp_boards candidate
        WHERE candidate.workspace_id = base.workspace_id
          AND (? = '' OR candidate.id = ?)
          AND EXISTS (SELECT 1 FROM fdp_lists entry
            WHERE entry.workspace_id = candidate.workspace_id AND entry.board_id = candidate.id AND entry.kind = 'new')
        ORDER BY candidate.created_at, candidate.name LIMIT 1
      ) board
      JOIN fdp_lists list
        ON list.workspace_id = base.workspace_id AND list.board_id = board.id AND list.kind = 'new'
      LEFT JOIN fdp_workspace_settings settings ON settings.workspace_id = base.workspace_id
      LEFT JOIN fdp_sla_policies policy
        ON policy.workspace_id = base.workspace_id AND policy.process_type = ? AND policy.active = 1
      LEFT JOIN LATERAL (
        SELECT candidate.id, candidate.default_sla_days FROM fdp_process_templates candidate
        WHERE candidate.workspace_id = base.workspace_id AND candidate.process_type = ? AND candidate.active = 1
        ORDER BY candidate.position LIMIT 1
      ) template ON TRUE`)
      .bind(workspaceId, configuredBoardId, configuredBoardId, PROCESS_TYPE, PROCESS_TYPE)
      .first<DemandPlacement>(),
    d1.prepare("SELECT holiday_date::text FROM fdp_business_holidays WHERE workspace_id = ?")
      .bind(workspaceId).all<{ holiday_date: string }>(),
    /* A empresa só é preenchida quando não há dúvida: a configurada na
       integração, ou a única do grupo. Com duas ou mais e nenhuma escolhida,
       o cartão nasce sem empresa — quem assume preenche. Chutar aqui colocaria
       o CNPJ errado numa admissão, que é pior do que deixar em branco. */
    d1.prepare(`SELECT id, COALESCE(NULLIF(trade_name, ''), legal_name) AS name
      FROM fdp_companies WHERE workspace_id = ? AND (? = '' OR id = ?)
      ORDER BY created_at LIMIT 2`)
      .bind(workspaceId, configuredCompanyId, configuredCompanyId).all<{ id: string; name: string }>(),
  ]);

  if (!placement) {
    throw new Error(configuredBoardId
      ? "O quadro configurado para o Agente Tangerino não possui uma coluna de entrada."
      : "Crie um quadro com coluna de entrada para receber as demandas do Agente Tangerino.");
  }
  const companies = company.results ?? [];
  const resolved = companies.length === 1 ? companies[0] : null;
  return {
    placement,
    holidays: new Set((holidays.results ?? []).map((row) => text(row.holiday_date, 10))),
    companyId: resolved ? String(resolved.id) : null,
    companyName: resolved ? text(resolved.name, 160) : "",
  };
}

function demandDescription(input: {
  displayName: string;
  roleTitle: string;
  admissionDate: string;
  companyName: string;
  externalAdmissionId: string;
  stage: string;
}) {
  return [
    "Admissão aberta na Sólides, na etapa Dados contratuais: está pronta para ser cadastrada no ERP.",
    `Pessoa: ${input.displayName}.`,
    input.roleTitle ? `Função: ${input.roleTitle}.` : "",
    `Data de admissão: ${input.admissionDate || "não informada na origem"}.`,
    `Empresa: ${input.companyName || "a definir por quem assumir"}.`,
    `Processo na origem: ${input.externalAdmissionId}.`,
    `Etapa confirmada pelo agente: ${input.stage}.`,
    "",
    "Esta pessoa ainda NÃO existe no ERP — é por isso que a demanda existe.",
    "A ficha de contratação e os documentos são trazidos da Sólides pela aba Anexos,",
    "após autorização específica nesta demanda, e é de lá que se copia para o ERP.",
  ].filter(Boolean).join("\n").slice(0, 4000);
}

/**
 * Abre uma demanda para uma admissão que ainda não existe no ERP.
 *
 * A idempotência é a mesma do resto do conector: um evento de integração com
 * chave derivada do processo e da data. Dois workers na mesma varredura, ou a
 * mesma varredura repetida, encontram o evento já processado e devolvem o
 * cartão existente em vez de abrir outro.
 */
export async function ensureOpenAdmissionDemand(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  openAdmissionId: string;
  externalAdmissionId: string;
  displayName: string;
  roleTitle?: string;
  admission: ParsedAdmission;
}): Promise<{ status: "not_target_stage" | "created" | "already_created" | "being_created"; cardId: string | null }> {
  if (!isContractDataStage(input.admission.stage)) return { status: "not_target_stage", cardId: null };

  const { placement, holidays, companyId, companyName } = await loadPlacement(d1, input.workspaceId, input.integrationId);
  const externalAdmissionId = text(input.externalAdmissionId, 120);
  const admissionDate = text(input.admission.admissionDate, 10) || "sem-data";
  const externalEventId = `open-admission-contract-data:${externalAdmissionId}:${admissionDate}`;

  const event = await recordIntegrationEvent(d1, {
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    connector: "tangerino_browser",
    eventType: "admission.open_contract_data_ready",
    externalEventId,
    source: "polling",
    payload: {
      openAdmissionId: input.openAdmissionId,
      externalAdmissionId,
      admissionDate,
      stage: input.admission.stage,
    },
  });
  if (event.event.status === "processed" && event.event.result_id) {
    return { status: "already_created", cardId: String(event.event.result_id) };
  }

  const claimed = await d1.prepare(`UPDATE fdp_integration_events
      SET status = 'processing', updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND id = ?
      AND (status IN ('received', 'error', 'reprocessed')
        OR (status = 'processing' AND updated_at <= CURRENT_TIMESTAMP - make_interval(mins => ?)))
    RETURNING id`)
    .bind(input.workspaceId, event.event.id, STALE_EVENT_MINUTES).first<{ id: string }>();
  if (!claimed) return { status: "being_created", cardId: null };

  const days = businessDays(placement.business_days_json);
  const dayStart = text(placement.day_start, 5) || "08:00";
  const dayEnd = text(placement.day_end, 5) || "18:00";
  const targetDays = Math.max(1, Number(placement.template_sla_days ?? placement.target_business_days ?? DEFAULT_SLA_DAYS));
  const dueDate = addBusinessDays(new Date().toISOString().slice(0, 10), targetDays, days, holidays);
  const dueAt = `${dueDate}T${dayEnd}`;
  const cardId = crypto.randomUUID();
  const authorizationId = crypto.randomUUID();
  const title = `Admissão ERP — ${input.displayName}`.slice(0, 160);
  const description = demandDescription({
    displayName: input.displayName,
    roleTitle: text(input.roleTitle, 160),
    admissionDate: text(input.admission.admissionDate, 10),
    companyName,
    externalAdmissionId,
    stage: input.admission.stage,
  });

  await d1.batch([
    /* `employee_id` e `company_id` ficam nulos de propósito: a pessoa ainda não
       é colaborador em lugar nenhum, e inventar um vínculo aqui seria escrever
       no Vinculato algo que o ERP não confirma. */
    d1.prepare(`INSERT INTO fdp_cards
        (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type,
         priority, due_at, sla_status, position, source_type, created_by, sla_target_minutes,
         sla_started_at, process_template_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?,
        COALESCE((SELECT MAX(position) FROM fdp_cards WHERE workspace_id = ? AND list_id = ? AND archived = 0), 0) + 1000,
        'integration', 'integracao:tangerino_browser', ?, CURRENT_TIMESTAMP, ?)`)
      .bind(cardId, input.workspaceId, placement.board_id, placement.list_id, title, description,
        companyId, companyName, PROCESS_TYPE, dueAt, slaStatus(dueAt, placement.sla_behavior),
        input.workspaceId, placement.list_id,
        targetDays * workingDayMinutes({ dayStart, dayEnd }), placement.template_id),
    ...checklist.map((item, index) => d1.prepare(`INSERT INTO fdp_checklist_items
        (id, workspace_id, card_id, title, completed, position) VALUES (?, ?, ?, ?, 0, ?)`)
      .bind(crypto.randomUUID(), input.workspaceId, cardId, item, (index + 1) * 1000)),
    d1.prepare(`UPDATE fdp_tangerino_open_admissions SET card_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND card_id IS NULL`)
      .bind(cardId, input.workspaceId, input.openAdmissionId),
    /* O DP pediu para não precisar clicar em "Autorizar anexos da Sólides"
       nesta demanda: ela nasce autorizada. employee_id e authorized_by_user_id
       ficam nulos pelo mesmo motivo do cartão — não há colaborador nem uma
       pessoa clicando neste instante, e a tela já trata os dois casos
       (`solidesAttachments` só lê `state`, nunca quem autorizou). O worker de
       anexos já sabe seguir sem colaborador desde a PR #168. */
    d1.prepare(`INSERT INTO fdp_tangerino_attachment_authorizations
        (id, workspace_id, card_id, employee_id, integration_id, external_admission_id, authorized_by_user_id)
      VALUES (?, ?, ?, NULL, ?, ?, NULL)`)
      .bind(authorizationId, input.workspaceId, cardId, input.integrationId, externalAdmissionId),
    d1.prepare(`INSERT INTO fdp_activity_events
        (id, workspace_id, card_id, actor_email, event_type, payload_json)
      VALUES (?, ?, ?, 'SYSTEM', 'tangerino.open_admission_demand_created', ?::jsonb)`)
      .bind(crypto.randomUUID(), input.workspaceId, cardId, JSON.stringify({
        openAdmissionId: input.openAdmissionId, externalAdmissionId, admissionDate, stage: input.admission.stage,
      })),
    d1.prepare(`INSERT INTO fdp_activity_events
        (id, workspace_id, card_id, actor_email, event_type, payload_json)
      VALUES (?, ?, ?, 'SYSTEM', 'tangerino.attachments.auto_authorized', ?::jsonb)`)
      .bind(crypto.randomUUID(), input.workspaceId, cardId, JSON.stringify({ authorizationId, expiresInHours: 24 })),
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
        cardId, openAdmissionId: input.openAdmissionId, companyId,
        trigger: "tangerino.open_admission_discovered", occurredAt: new Date().toISOString(),
      },
    }),
    prepareAuditEvent({
      workspaceId: input.workspaceId,
      actorType: "system",
      actorEmail: "SYSTEM",
      action: "tangerino.admission.open_demand_created",
      entityType: "card",
      entityId: cardId,
      after: { openAdmissionId: input.openAdmissionId, externalAdmissionId, admissionDate, stage: input.admission.stage },
    }),
    prepareAuditEvent({
      workspaceId: input.workspaceId,
      actorType: "system",
      actorEmail: "SYSTEM",
      action: "tangerino.attachments.authorized",
      entityType: "card",
      entityId: cardId,
      after: { authorizationId, auto: true, expiresInHours: 24 },
    }),
  ]);
  return { status: "created", cardId };
}
