/**
 * DP Operacional, Fase 2 — grava as demandas das rotinas recorrentes.
 *
 * A regra está em `lib/dp-recurring.ts`. Aqui: carregar calendário, empresas e
 * modelos, e criar o que falta. Cada demanda nasce num lote com a ocorrência
 * que a registra; o índice único da ocorrência faz uma segunda execução
 * concorrente abortar inteira em vez de duplicar a rotina.
 */
import type { getD1 } from "../db/index.ts";
import { addDays, type BusinessCalendar } from "./dp-calendar.ts";
import {
  periodsToEnsure, planOccurrences, templateFromRow, weekMovementsText,
  type PlannedOccurrence, type RecurringCompany, type RecurringPeriod, type RecurringTemplate,
} from "./dp-recurring.ts";
import { prepareAssigneeStatements, preparePortfolioAssignment } from "./portfolio-assignment.ts";

type Database = ReturnType<typeof getD1>;
type Row = Record<string, unknown>;

export async function loadBusinessCalendar(d1: Database, workspaceId: string): Promise<BusinessCalendar & { dayEnd: string }> {
  const [settings, holidays] = await Promise.all([
    d1.prepare("SELECT business_days_json, day_end FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspaceId)
      .first<{ business_days_json: string; day_end: string }>(),
    d1.prepare("SELECT holiday_date::text AS holiday_date FROM fdp_business_holidays WHERE workspace_id = ?").bind(workspaceId)
      .all<{ holiday_date: string }>(),
  ]);
  let businessDays = [1, 2, 3, 4, 5];
  try {
    const parsed = settings?.business_days_json ? JSON.parse(settings.business_days_json) as unknown : null;
    if (Array.isArray(parsed) && parsed.every((day) => Number.isInteger(day))) businessDays = parsed as number[];
  } catch { /* configuração inválida: segunda a sexta */ }
  return {
    businessDays,
    holidays: new Set(holidays.results.map((row) => String(row.holiday_date).slice(0, 10))),
    dayEnd: /^\d{2}:\d{2}$/u.test(String(settings?.day_end ?? "")) ? String(settings?.day_end) : "18:00",
  };
}

export async function loadRecurringCompanies(d1: Database, workspaceId: string): Promise<RecurringCompany[]> {
  const rows = await d1.prepare(`SELECT id, COALESCE(NULLIF(trade_name, ''), legal_name) AS name, external_code, dp_status, status,
      cnpj_root, is_headquarters FROM fdp_companies WHERE workspace_id = ? ORDER BY external_code, legal_name`)
    .bind(workspaceId).all<Row>();
  return rows.results.map((row) => ({
    id: String(row.id), name: String(row.name ?? ""), code: String(row.external_code ?? ""),
    dpStatus: String(row.dp_status ?? "interno"), status: String(row.status ?? "active"),
    cnpjRoot: String(row.cnpj_root ?? ""), isHeadquarters: row.is_headquarters === true,
  }));
}

export async function loadRecurringTemplates(d1: Database, workspaceId: string): Promise<RecurringTemplate[]> {
  const rows = await d1.prepare(`SELECT id, code, name, description, frequency, day_start, day_end, weekday, scope,
      company_ids, process_type, list_week_movements, active
    FROM fdp_recurring_templates WHERE workspace_id = ? ORDER BY frequency, day_start, name`)
    .bind(workspaceId).all<Row>();
  return rows.results.map(templateFromRow);
}

/** O quadro e a coluna de entrada onde as rotinas nascem: o primeiro quadro do grupo. */
async function targetList(d1: Database, workspaceId: string) {
  return d1.prepare(`SELECT b.id AS board_id, l.id AS list_id FROM fdp_boards b
      JOIN fdp_lists l ON l.workspace_id = b.workspace_id AND l.board_id = b.id
    WHERE b.workspace_id = ? ORDER BY b.created_at, (l.kind = 'new') DESC, l.position LIMIT 1`)
    .bind(workspaceId).first<{ board_id: string; list_id: string }>();
}

async function weekMovements(d1: Database, workspaceId: string, companyIds: string[], monday: string) {
  if (!companyIds.length) return "";
  const sunday = addDays(monday, 6);
  const placeholders = companyIds.map(() => "?").join(",");
  const [admissions, terminations] = await Promise.all([
    d1.prepare(`SELECT full_name, admission_date::text AS day FROM fdp_employees
      WHERE workspace_id = ? AND company_id IN (${placeholders}) AND admission_date BETWEEN ?::date AND ?::date ORDER BY admission_date, full_name`)
      .bind(workspaceId, ...companyIds, monday, sunday).all<Row>(),
    d1.prepare(`SELECT full_name, termination_date::text AS day FROM fdp_employees
      WHERE workspace_id = ? AND company_id IN (${placeholders}) AND termination_date BETWEEN ?::date AND ?::date ORDER BY termination_date, full_name`)
      .bind(workspaceId, ...companyIds, monday, sunday).all<Row>(),
  ]);
  return weekMovementsText({
    admissions: admissions.results.map((row) => ({ name: String(row.full_name), date: String(row.day).slice(0, 10) })),
    terminations: terminations.results.map((row) => ({ name: String(row.full_name), date: String(row.day).slice(0, 10) })),
  });
}

export type GenerationResult = { created: number; existing: number; skipped: string[] };

/**
 * Gera as demandas que faltam nos períodos pedidos (padrão: os que o job
 * diário garante a partir de hoje). Idempotente: o que já existe é contado e
 * deixado como está.
 */
export async function generateRecurringTasks(d1: Database, input: {
  workspaceId: string; today: string; actor: string; periods?: RecurringPeriod[]; templateIds?: string[];
}): Promise<GenerationResult> {
  const result: GenerationResult = { created: 0, existing: 0, skipped: [] };
  const templates = (await loadRecurringTemplates(d1, input.workspaceId))
    .filter((template) => template.active && (!input.templateIds || input.templateIds.includes(template.id)));
  if (!templates.length) return result;
  const list = await targetList(d1, input.workspaceId);
  if (!list) { result.skipped.push("O grupo não tem quadro com coluna para receber as rotinas."); return result; }
  const [calendar, companies, settings, existing] = await Promise.all([
    loadBusinessCalendar(d1, input.workspaceId),
    loadRecurringCompanies(d1, input.workspaceId),
    d1.prepare("SELECT tenant_task_owner_user_id FROM fdp_dp_settings WHERE workspace_id = ?").bind(input.workspaceId)
      .first<{ tenant_task_owner_user_id: string | null }>(),
    d1.prepare("SELECT template_id, period_key, scope_key FROM fdp_recurring_occurrences WHERE workspace_id = ? AND created_at > now() - interval '120 days'")
      .bind(input.workspaceId).all<Row>(),
  ]);
  const done = new Set(existing.results.map((row) => `${row.template_id}|${row.period_key}|${row.scope_key}`));
  const periods = input.periods ?? periodsToEnsure(input.today);

  const planned: PlannedOccurrence[] = [];
  for (const template of templates) {
    for (const period of periods) planned.push(...planOccurrences({ template, period, companies, calendar }));
  }
  for (const occurrence of planned) {
    if (done.has(`${occurrence.templateId}|${occurrence.periodKey}|${occurrence.scopeKey}`)) { result.existing += 1; continue; }
    const template = templates.find((item) => item.id === occurrence.templateId);
    const extra = template?.listWeekMovements && occurrence.periodKey.length === 10
      ? await weekMovements(d1, input.workspaceId, occurrence.companyIds, occurrence.periodKey)
      : "";
    const cardId = crypto.randomUUID();
    const assignment = occurrence.companyId
      ? (await preparePortfolioAssignment(d1, { workspaceId: input.workspaceId, cardId, companyId: occurrence.companyId, date: occurrence.startDate < input.today ? input.today : occurrence.startDate })).statements
      : settings?.tenant_task_owner_user_id ? prepareAssigneeStatements(d1, input.workspaceId, cardId, settings.tenant_task_owner_user_id) : [];
    const company = occurrence.companyId ? companies.find((item) => item.id === occurrence.companyId) : null;
    const dueAt = `${occurrence.dueDate}T${calendar.dayEnd}`;
    try {
      await d1.batch([
        d1.prepare(`INSERT INTO fdp_cards
          (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority, assignee_name,
           due_at, sla_status, position, source_type, created_by, sla_started_at, competence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', '', ?, ?,
            COALESCE((SELECT MAX(position) FROM fdp_cards WHERE list_id = ? AND archived = 0), 0) + 1000,
            'recurring', ?, CURRENT_TIMESTAMP, ?)`)
          .bind(cardId, input.workspaceId, list.board_id, list.list_id, occurrence.title.slice(0, 180),
            [occurrence.description, extra].filter(Boolean).join("\n\n").slice(0, 4000),
            occurrence.companyId, company?.name ?? "", occurrence.processType.slice(0, 40), dueAt,
            occurrence.dueDate < input.today ? "overdue" : occurrence.dueDate === input.today ? "warning" : "safe",
            list.list_id, input.actor, occurrence.competence),
        d1.prepare(`INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position)
          VALUES (?, ?, ?, 'Executar a rotina', 0, 1000), (?, ?, ?, 'Conferir e concluir', 0, 2000)`)
          .bind(crypto.randomUUID(), input.workspaceId, cardId, crypto.randomUUID(), input.workspaceId, cardId),
        ...assignment,
        d1.prepare(`INSERT INTO fdp_recurring_occurrences
          (id, workspace_id, template_id, period_key, scope_key, company_id, card_id, due_date, start_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?::date, ?::date)`)
          .bind(crypto.randomUUID(), input.workspaceId, occurrence.templateId, occurrence.periodKey, occurrence.scopeKey,
            occurrence.companyId, cardId, occurrence.dueDate, occurrence.startDate),
        d1.prepare(`INSERT INTO fdp_activity_events (id, workspace_id, card_id, actor_email, event_type, payload_json)
          VALUES (?, ?, ?, ?, 'recurring.generated', ?::jsonb)`)
          .bind(crypto.randomUUID(), input.workspaceId, cardId, input.actor,
            JSON.stringify({ templateId: occurrence.templateId, periodKey: occurrence.periodKey, scopeKey: occurrence.scopeKey })),
      ]);
      done.add(`${occurrence.templateId}|${occurrence.periodKey}|${occurrence.scopeKey}`);
      result.created += 1;
    } catch (error) {
      // Outra execução gerou a mesma rotina entre a leitura e o lote: o índice
      // único recusou o lote inteiro, e a demanda dela vale.
      if (String((error as Error)?.message ?? "").includes("fdp_recurring_occurrences_once_uq")) { result.existing += 1; continue; }
      throw error;
    }
  }
  return result;
}
