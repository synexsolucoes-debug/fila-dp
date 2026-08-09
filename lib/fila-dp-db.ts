import { getD1 } from "../db";
import type { ChatGPTUser } from "../app/chatgpt-auth";
import type { WorkspaceRole, WorkspaceSnapshot } from "./fila-dp-types";
import { businessMinutesBetween, workingDayMinutes } from "./fila-dp-sla";
import { getTenantContext, setTenantContext } from "./tenant-context";
import { hasCapability } from "./authorization";
import { ApiError } from "./fila-dp-api";
import { safeIntegrationError } from "./integrations";


function safeJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export type CompanyAccessScope = {
  unrestricted: boolean;
  companyIds: Set<string>;
};

export async function getCompanyAccessScope(
  d1: ReturnType<typeof getD1>,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<CompanyAccessScope> {
  if (role === "admin") return { unrestricted: true, companyIds: new Set() };
  const access = await d1.prepare("SELECT company_id FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ?")
    .bind(workspaceId, userId)
    .all<{ company_id: string }>();
  return { unrestricted: false, companyIds: new Set(access.results.map((row) => String(row.company_id))) };
}

export async function requireCompanyAccess(
  d1: ReturnType<typeof getD1>,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  companyId: string | null,
) {
  if (role === "admin") return;
  if (!companyId) throw ApiError.forbidden("Selecione uma empresa à qual você tenha acesso.", "COMPANY_ACCESS_REQUIRED");
  const access = await d1.prepare("SELECT 1 FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ? AND company_id = ?")
    .bind(workspaceId, userId, companyId)
    .first();
  if (!access) throw ApiError.forbidden("Você não tem acesso a esta empresa.", "COMPANY_ACCESS_REQUIRED");
}

export async function requireCardCompanyAccess(
  d1: ReturnType<typeof getD1>,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  cardId: string,
) {
  if (role === "admin") return;
  const card = await d1.prepare(`SELECT c.company_id
    FROM fdp_cards c JOIN fdp_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.workspace_id = ?`).bind(cardId, workspaceId).first<{ company_id: string | null }>();
  if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
  await requireCompanyAccess(d1, workspaceId, userId, role, card.company_id ? String(card.company_id) : null);
}

function todayInTimezone(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function businessDaysUntil(from: string, to: string, businessDays: number[], holidays: Set<string>) {
  if (to < from) return -1;
  let count = 0;
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (businessDays.includes(cursor.getUTCDay()) && !holidays.has(iso)) count += 1;
  }
  return count;
}

const nativeTemplates = [
  { key: "conciliacao-admitido", name: "Conciliação de colaborador admitido", process: "CONCILIAÇÃO CADASTRAL", days: 2, checklist: ["Importação concluída", "Registro da Sólides vinculado ao ERP", "Divergências cadastrais tratadas", "Sincronização registrada"] },
  { key: "rescisao", name: "Rescisão", process: "RESCISÃO", days: 2, checklist: ["Desligamento registrado", "Cálculo rescisório conferido", "Documentos finais enviados", "Pagamento confirmado"] },
  { key: "ferias", name: "Programação de férias", process: "FÉRIAS", days: 5, checklist: ["Período aquisitivo validado", "Gestor confirmou as datas", "Aviso de férias emitido", "Pagamento programado"] },
  { key: "beneficios", name: "Benefícios", process: "BENEFÍCIOS", days: 3, checklist: ["Elegibilidade validada", "Documentos conferidos", "Solicitação enviada à operadora"] },
] as const;

export async function provisionWorkspaceDefaults(d1: ReturnType<typeof getD1>, workspaceId: string) {
  const defaultLabels = [
    ["critico", "Crítico", "#dc2626"],
    ["documentos", "Documentos", "#2563eb"],
    ["conferencia", "Conferência", "#7c3aed"],
    ["terceiros", "Terceiros", "#d97706"],
  ] as const;
  const defaultFields = [
    ["matricula", "Matrícula", "text", "[]"],
    ["competencia", "Competência", "text", "[]"],
    ["canal_entrada", "Canal de entrada", "select", JSON.stringify(["Manual", "E-mail", "WhatsApp", "Teams"])],
  ] as const;
  const policies = [
    ["CONCILIAÇÃO CADASTRAL", 2, 1], ["RESCISÃO", 2, 1], ["FÉRIAS", 5, 2], ["BENEFÍCIOS", 3, 1], ["FOLHA", 2, 1], ["OUTROS", 3, 1],
  ] as const;
  const integrationRows = [
    ["email", "E-mail corporativo"], ["whatsapp", "WhatsApp Business"], ["teams", "Microsoft Teams"], ["drive", "Google Drive"], ["onedrive", "Microsoft OneDrive"], ["solides", "Sólides"], ["erp", "ERP / Folha"],
  ] as const;

  await d1.batch([
    d1.prepare("INSERT INTO fdp_workspace_settings (workspace_id) VALUES (?) ON CONFLICT DO NOTHING").bind(workspaceId),
    ...defaultLabels.map(([key, name, color], index) => d1.prepare("INSERT INTO fdp_labels (id, workspace_id, name, color, position) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(`${workspaceId}:label:${key}`, workspaceId, name, color, (index + 1) * 1000)),
    ...defaultFields.map(([key, name, type, options], index) => d1.prepare("INSERT INTO fdp_custom_fields (id, workspace_id, name, field_key, field_type, options_json, position) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(`${workspaceId}:field:${key}`, workspaceId, name, key, type, options, (index + 1) * 1000)),
    ...nativeTemplates.map((template, index) => d1.prepare("INSERT INTO fdp_process_templates (id, workspace_id, name, process_type, description, checklist_json, default_sla_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(`${workspaceId}:template:${template.key}`, workspaceId, template.name, template.process, `Fluxo padrão de ${template.name.toLowerCase()} do Fila DP.`, JSON.stringify(template.checklist), template.days, (index + 1) * 1000)),
    ...policies.map(([processType, target, warning]) => d1.prepare("INSERT INTO fdp_sla_policies (id, workspace_id, process_type, target_business_days, warning_business_days) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(`${workspaceId}:sla:${processType}`, workspaceId, processType, target, warning)),
    ...integrationRows.map(([channel, displayName]) => d1.prepare("INSERT INTO fdp_integrations (id, workspace_id, channel, display_name) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(`${workspaceId}:integration:${channel}`, workspaceId, channel, displayName)),
  ]);
}

export async function getWorkspaceContext(user: ChatGPTUser) {
  const d1 = getD1();
  const normalizedEmail = user.email.trim().toLowerCase();

  const userRow = await d1.prepare("SELECT id, email, name FROM fdp_users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: string; email: string; name: string }>();
  if (!userRow) throw ApiError.forbidden("Sem permissão para acessar este grupo.", "WORKSPACE_ACCESS_DENIED");

  let workspace = await d1.prepare(
    `SELECT w.id, w.name, w.timezone, wm.role
     FROM fdp_user_workspace_preferences p
     JOIN fdp_workspaces w ON w.id = p.active_workspace_id
     JOIN fdp_workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = p.user_id
     WHERE p.user_id = ?
     LIMIT 1`,
  ).bind(userRow.id).first<{ id: string; name: string; timezone: string; role: WorkspaceRole }>();

  if (!workspace) {
    workspace = await d1.prepare(
      `SELECT w.id, w.name, w.timezone, wm.role
       FROM fdp_workspaces w
       JOIN fdp_workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = ?
       ORDER BY CASE WHEN w.owner_user_id = ? THEN 0 ELSE 1 END, wm.joined_at
       LIMIT 1`,
    ).bind(userRow.id, userRow.id).first<{ id: string; name: string; timezone: string; role: WorkspaceRole }>();
  }

  if (!workspace) throw ApiError.forbidden("Sem permissão para acessar este grupo. Peça ao administrador para liberar seu usuário.", "WORKSPACE_ACCESS_DENIED");

  setTenantContext({ workspaceId: workspace.id, userId: userRow.id });

  await d1.prepare(
    `INSERT INTO fdp_user_workspace_preferences (user_id, active_workspace_id, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = excluded.active_workspace_id, updated_at = CURRENT_TIMESTAMP`,
  ).bind(userRow.id, workspace.id).run();

  const boardPreference = await d1.prepare("SELECT active_board_id FROM fdp_user_workspace_preferences WHERE user_id = ? AND active_workspace_id = ?").bind(userRow.id, workspace.id).first<{ active_board_id: string | null }>();
  let board = boardPreference?.active_board_id
    ? await d1.prepare("SELECT id, name, description, board_type FROM fdp_boards WHERE workspace_id = ? AND id = ?").bind(workspace.id, boardPreference.active_board_id).first<{ id: string; name: string; description: string; board_type: string }>()
    : null;
  if (!board) board = await d1.prepare("SELECT id, name, description, board_type FROM fdp_boards WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspace.id).first<{ id: string; name: string; description: string; board_type: string }>();

  if (!board) throw ApiError.notFound("Este grupo ainda não possui um quadro. Peça ao administrador para concluir a configuração inicial.", "BOARD_NOT_FOUND");

  await d1.prepare("UPDATE fdp_user_workspace_preferences SET active_board_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?").bind(board.id, userRow.id, workspace.id).run();

  return { d1, user: userRow, workspace, board };
}

export async function getWorkspaceSnapshot(user: ChatGPTUser): Promise<WorkspaceSnapshot> {
  const { d1, workspace, board, user: userRow } = await getWorkspaceContext(user);
  const companyAccess = await getCompanyAccessScope(d1, workspace.id, userRow.id, workspace.role);
  const canManageMembers = hasCapability(workspace.role, "members.manage");
  const canReadHr = hasCapability(workspace.role, "hr.read");
  const canManageIntegrations = hasCapability(workspace.role, "integrations.manage");
  const [boardsResult, listsResult, allBoardListsResult, cardsResult, checklistResult, inboxResult, rulesResult, commentsResult, activitiesResult, membersResult, workspacesResult, labelsResult, cardLabelsResult, assigneesResult, customFieldsResult, customValuesResult, attachmentsResult, templatesResult, settingsRow, holidaysResult, policiesResult, integrationsResult, plannerResult, calendarsResult, companiesResult, hrMetricsResult, pausesResult] = await Promise.all([
    d1.prepare("SELECT id, name, description, board_type FROM fdp_boards WHERE workspace_id = ? ORDER BY created_at").bind(workspace.id).all(),
    d1.prepare("SELECT id, board_id, name, kind, position, sla_behavior FROM fdp_lists WHERE board_id = ? ORDER BY position").bind(board.id).all(),
    d1.prepare("SELECT l.id, l.board_id, l.name, l.kind, l.position, l.sla_behavior FROM fdp_lists l JOIN fdp_boards b ON b.id = l.board_id WHERE b.workspace_id = ? ORDER BY l.position").bind(workspace.id).all(),
    d1.prepare("SELECT * FROM fdp_cards WHERE board_id = ? ORDER BY archived, list_id, position, created_at").bind(board.id).all(),
    d1.prepare("SELECT ci.* FROM fdp_checklist_items ci JOIN fdp_cards c ON c.id = ci.card_id WHERE c.board_id = ? ORDER BY ci.position").bind(board.id).all(),
    d1.prepare("SELECT id, channel, sender_name, subject, body, status, received_at, converted_card_id FROM fdp_workspace_inbox_items WHERE workspace_id = ? ORDER BY received_at DESC").bind(workspace.id).all(),
    d1.prepare("SELECT id, name, trigger, condition_json, action_json, enabled, position FROM fdp_automation_rules WHERE workspace_id = ? ORDER BY position").bind(workspace.id).all(),
    d1.prepare(`SELECT cc.id, cc.card_id, cc.body, cc.created_at, u.name AS author_name, u.email AS author_email
      FROM fdp_card_comments cc
      JOIN fdp_users u ON u.id = cc.author_user_id
      JOIN fdp_cards c ON c.id = cc.card_id
      WHERE c.board_id = ?
      ORDER BY cc.created_at`).bind(board.id).all(),
    d1.prepare(`SELECT ae.id, ae.card_id, ae.actor_email, ae.event_type, ae.payload_json, ae.created_at,
        COALESCE(u.name, ae.actor_email) AS actor_name
      FROM fdp_activity_events ae
      LEFT JOIN fdp_users u ON u.email = ae.actor_email
      WHERE ae.workspace_id = ?
      ORDER BY ae.created_at DESC LIMIT 150`).bind(workspace.id).all(),
    d1.prepare(`SELECT u.id AS user_id, u.email, u.name, wm.role, wm.joined_at,
        CASE WHEN w.owner_user_id = u.id THEN 1 ELSE 0 END AS is_owner,
        CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS is_activated
      FROM fdp_workspace_members wm
      JOIN fdp_users u ON u.id = wm.user_id
      JOIN fdp_workspaces w ON w.id = wm.workspace_id
      WHERE wm.workspace_id = ?
      ORDER BY is_owner DESC, u.name`).bind(workspace.id).all(),
    d1.prepare(`SELECT w.id, w.name, wm.role
      FROM fdp_workspace_members wm
      JOIN fdp_workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY w.name`).bind(userRow.id).all(),
    d1.prepare("SELECT id, name, color, position FROM fdp_labels WHERE workspace_id = ? ORDER BY position").bind(workspace.id).all(),
    d1.prepare(`SELECT cl.card_id, l.id, l.name, l.color
      FROM fdp_card_labels cl JOIN fdp_labels l ON l.id = cl.label_id
      WHERE l.workspace_id = ? ORDER BY l.position`).bind(workspace.id).all(),
    d1.prepare(`SELECT ca.card_id, u.id AS user_id, u.name, u.email
      FROM fdp_card_assignees ca JOIN fdp_users u ON u.id = ca.user_id
      JOIN fdp_cards c ON c.id = ca.card_id WHERE c.board_id = ? ORDER BY u.name`).bind(board.id).all(),
    d1.prepare("SELECT id, name, field_key, field_type, options_json, required, position FROM fdp_custom_fields WHERE workspace_id = ? ORDER BY position").bind(workspace.id).all(),
    d1.prepare(`SELECT cfv.card_id, cf.field_key, cfv.value_text
      FROM fdp_custom_field_values cfv JOIN fdp_custom_fields cf ON cf.id = cfv.field_id
      WHERE cf.workspace_id = ?`).bind(workspace.id).all(),
    d1.prepare(`SELECT a.id, a.card_id, a.filename, a.content_type, a.size_bytes, a.uploaded_by, a.created_at
      FROM fdp_card_attachments a JOIN fdp_cards c ON c.id = a.card_id WHERE c.board_id = ? ORDER BY a.created_at DESC`).bind(board.id).all(),
    d1.prepare("SELECT id, name, process_type, description, checklist_json, default_sla_days, active, position FROM fdp_process_templates WHERE workspace_id = ? ORDER BY position").bind(workspace.id).all(),
    d1.prepare("SELECT business_days_json, day_start, day_end, realtime_seconds FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspace.id).first<Record<string, unknown>>(),
    d1.prepare("SELECT holiday_date, name FROM fdp_business_holidays WHERE workspace_id = ? ORDER BY holiday_date").bind(workspace.id).all(),
    d1.prepare("SELECT id, process_type, target_business_days, warning_business_days, active FROM fdp_sla_policies WHERE workspace_id = ? ORDER BY process_type").bind(workspace.id).all(),
    d1.prepare("SELECT id, channel, display_name, status, config_json, last_sync_at, last_error FROM fdp_integrations WHERE workspace_id = ? ORDER BY channel").bind(workspace.id).all(),
    d1.prepare("SELECT id, user_id, card_id, title, start_at, end_at, block_type, notes FROM fdp_planner_blocks WHERE workspace_id = ? AND user_id = ? ORDER BY start_at LIMIT 300").bind(workspace.id, userRow.id).all(),
    d1.prepare("SELECT id, provider, status, config_json, external_calendar_id, last_sync_at, last_error FROM fdp_calendar_connections WHERE workspace_id = ? AND user_id = ? ORDER BY provider").bind(workspace.id, userRow.id).all(),
    d1.prepare("SELECT id, parent_company_id, is_principal, legal_name, trade_name, tax_id, external_code, email, phone, status FROM fdp_companies WHERE workspace_id = ? ORDER BY is_principal DESC, legal_name").bind(workspace.id).all(),
    d1.prepare("SELECT id, company_id, period, headcount, headcount_start, headcount_end, leaves_count, admissions, terminations, voluntary_terminations, involuntary_terminations, base_salary, variable_pay, overtime_pay, additional_pay, vacation_pay, thirteenth_pay, termination_pay, gross_payroll, employee_inss, employee_irrf, employee_other_deductions, net_pay, employer_inss, rat_contribution, third_party_contributions, fgts, fgts_penalty, employer_charges, benefits_cost, provisions_cost, other_costs, payroll_cost, source, external_id, notes FROM fdp_hr_metrics WHERE workspace_id = ? ORDER BY period DESC, company_id").bind(workspace.id).all(),
    d1.prepare("SELECT p.card_id, p.reason FROM fdp_card_sla_pauses p JOIN fdp_cards c ON c.id = p.card_id WHERE p.workspace_id = ? AND p.ended_at IS NULL AND c.board_id = ?").bind(workspace.id, board.id).all(),
  ]);

  const checklistRows = checklistResult.results as Array<Record<string, unknown>>;
  const commentRows = commentsResult.results as Array<Record<string, unknown>>;
  const companyRows = companiesResult.results as Array<Record<string, unknown>>;
  const isVisibleCompany = (companyId: unknown) => companyAccess.unrestricted || Boolean(companyId && companyAccess.companyIds.has(String(companyId)));
  const cardRows = (cardsResult.results as Array<Record<string, unknown>>).filter((row) => isVisibleCompany(row.company_id));
  const visibleCardIds = new Set(cardRows.map((row) => String(row.id)));
  const activityRows = (activitiesResult.results as Array<Record<string, unknown>>).filter((row) => row.card_id && visibleCardIds.has(String(row.card_id)));
  const inboxRows = (inboxResult.results as Array<Record<string, unknown>>).filter((row) => companyAccess.unrestricted || Boolean(row.converted_card_id && visibleCardIds.has(String(row.converted_card_id))));
  const visibleCompanyRows = companyRows.filter((row) => isVisibleCompany(row.id));
  const visibleMetricRows = (hrMetricsResult.results as Array<Record<string, unknown>>).filter((row) => isVisibleCompany(row.company_id));
  const listRows = listsResult.results as Array<Record<string, unknown>>;
  const policyRows = policiesResult.results as Array<Record<string, unknown>>;
  const businessDays = safeArray(String(settingsRow?.business_days_json ?? "[1,2,3,4,5]")).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  const holidaySet = new Set((holidaysResult.results as Array<Record<string, unknown>>).map((row) => String(row.holiday_date)));
  const today = todayInTimezone(workspace.timezone);
  const slaCalendar = {
    businessDays: businessDays.length ? businessDays : [1, 2, 3, 4, 5],
    holidays: holidaySet,
    dayStart: String(settingsRow?.day_start ?? "08:00"),
    dayEnd: String(settingsRow?.day_end ?? "18:00"),
    timezone: workspace.timezone,
  };
  const workdayMinutes = workingDayMinutes(slaCalendar);
  const listBehavior = new Map(listRows.map((row) => [String(row.id), String(row.sla_behavior)]));
  const policyByProcess = new Map(policyRows.map((row) => [String(row.process_type), Number(row.warning_business_days ?? 1)]));
  const activePauseByCard = new Map((pausesResult.results as Array<Record<string, unknown>>).map((row) => [String(row.card_id), String(row.reason)]));
  for (const row of cardRows) {
    if (Boolean(row.archived)) continue;
    const behavior = listBehavior.get(String(row.list_id)) ?? "running";
    const dueAt = row.due_at ? String(row.due_at) : null;
    let status = "safe";
    if (activePauseByCard.has(String(row.id)) || behavior === "paused") status = "paused";
    else if (behavior === "completed") status = "completed";
    else if (Number(row.sla_target_minutes ?? 0) > 0 && row.sla_started_at) {
      const target = Number(row.sla_target_minutes);
      const elapsed = Math.max(0, businessMinutesBetween(String(row.sla_started_at), new Date(), slaCalendar) - Number(row.sla_paused_minutes ?? 0));
      const warningMinutes = Math.max(0, Number(policyByProcess.get(String(row.process_type)) ?? 1) * workdayMinutes);
      if (elapsed >= target) status = "overdue";
      else if (elapsed >= Math.max(0, target - warningMinutes)) status = "warning";
    } else if (dueAt) {
      const dueDate = dueAt.slice(0, 10);
      const remaining = businessDaysUntil(today, dueDate, slaCalendar.businessDays, holidaySet);
      if (dueDate < today) status = "overdue";
      else if (remaining <= (policyByProcess.get(String(row.process_type)) ?? 1)) status = "warning";
    }
    const shouldEscalate = status === "overdue" && Number(row.sla_escalation_level ?? 0) < 1;
    if (String(row.sla_status) !== status || shouldEscalate) {
      row.sla_status = status;
      if (shouldEscalate) row.sla_escalation_level = 1;
    }
  }

  const notificationsResult = await d1.prepare("SELECT id, notification_type, title, body, card_id, read_at, created_at FROM fdp_notifications WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50").bind(workspace.id, userRow.id).all();
  const memberCompanyAccessResult = await d1.prepare("SELECT user_id, company_id FROM fdp_member_company_access WHERE workspace_id = ?").bind(workspace.id).all<{ user_id: string; company_id: string }>();
  const memberCompanyIds = new Map<string, string[]>();
  for (const access of memberCompanyAccessResult.results) {
    const userCompanies = memberCompanyIds.get(String(access.user_id)) ?? [];
    userCompanies.push(String(access.company_id));
    memberCompanyIds.set(String(access.user_id), userCompanies);
  }
  const cardLabelRows = cardLabelsResult.results as Array<Record<string, unknown>>;
  const assigneeRows = assigneesResult.results as Array<Record<string, unknown>>;
  const customValueRows = customValuesResult.results as Array<Record<string, unknown>>;
  const attachmentRows = attachmentsResult.results as Array<Record<string, unknown>>;
  const cards = cardRows.map((row) => ({
    id: String(row.id),
    boardId: String(row.board_id),
    listId: String(row.list_id),
    title: String(row.title),
    description: String(row.description ?? ""),
    companyId: row.company_id ? String(row.company_id) : null,
    company: String(row.company ?? ""),
    processType: String(row.process_type ?? "OUTROS"),
    priority: String(row.priority ?? "normal") as "low" | "normal" | "high" | "urgent",
    assigneeName: String(row.assignee_name ?? ""),
    dueAt: row.due_at ? String(row.due_at) : null,
    slaStatus: String(row.sla_status ?? "safe") as "safe" | "warning" | "overdue" | "paused" | "completed",
    position: Number(row.position),
    sourceType: String(row.source_type ?? "manual"),
    archived: Boolean(row.archived),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    checklist: checklistRows.filter((item) => item.card_id === row.id).map((item) => ({
      id: String(item.id),
      cardId: String(item.card_id),
      title: String(item.title),
      completed: Boolean(item.completed),
      position: Number(item.position),
      completedAt: item.completed_at ? String(item.completed_at) : null,
    })),
    comments: commentRows.filter((item) => item.card_id === row.id).map((item) => ({
      id: String(item.id),
      cardId: String(item.card_id),
      authorName: String(item.author_name),
      authorEmail: String(item.author_email),
      body: String(item.body),
      createdAt: String(item.created_at),
    })),
    activities: activityRows.filter((item) => item.card_id === row.id).map((item) => ({
      id: String(item.id),
      cardId: item.card_id ? String(item.card_id) : null,
      actorEmail: String(item.actor_email),
      actorName: String(item.actor_name),
      eventType: String(item.event_type),
      payload: safeJson(String(item.payload_json)),
      createdAt: String(item.created_at),
    })),
    assignees: assigneeRows.filter((item) => item.card_id === row.id).map((item) => ({
      userId: String(item.user_id), name: String(item.name), email: String(item.email),
    })),
    labels: cardLabelRows.filter((item) => item.card_id === row.id).map((item) => ({
      id: String(item.id), name: String(item.name), color: String(item.color),
    })),
    customValues: Object.fromEntries(customValueRows.filter((item) => item.card_id === row.id).map((item) => [String(item.field_key), String(item.value_text)])),
    attachments: attachmentRows.filter((item) => item.card_id === row.id).map((item) => ({
      id: String(item.id), filename: String(item.filename), contentType: String(item.content_type), sizeBytes: Number(item.size_bytes), uploadedBy: String(item.uploaded_by), createdAt: String(item.created_at), downloadUrl: `/api/attachments/${encodeURIComponent(String(item.id))}`,
    })),
    slaPausedReason: String(row.sla_pause_reason ?? ""),
    slaTargetMinutes: Number(row.sla_target_minutes ?? 0),
    slaPausedMinutes: Number(row.sla_paused_minutes ?? 0),
    slaEscalationLevel: Number(row.sla_escalation_level ?? 0),
    competence: String(row.competence ?? ""),
    legalDueAt: row.legal_due_at ? String(row.legal_due_at) : null,
    processTemplateId: row.process_template_id ? String(row.process_template_id) : null,
    closedAt: row.closed_at ? String(row.closed_at) : null,
  }));

  const mapActivity = (row: Record<string, unknown>) => ({
    id: String(row.id),
    cardId: row.card_id ? String(row.card_id) : null,
    actorEmail: String(row.actor_email),
    actorName: String(row.actor_name),
    eventType: String(row.event_type),
    payload: safeJson(String(row.payload_json)),
    createdAt: String(row.created_at),
  });

  return {
    workspace: { ...workspace, role: workspace.role, companyScope: companyAccess.unrestricted ? "all" : "restricted" },
    board,
    boards: (boardsResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), name: String(row.name), description: String(row.description ?? ""), boardType: String(row.board_type ?? "general"),
      stages: (allBoardListsResult.results as Array<Record<string, unknown>>).filter((list) => String(list.board_id) === String(row.id)).map((list) => ({ id: String(list.id), name: String(list.name), kind: String(list.kind), slaBehavior: String(list.sla_behavior) as "running" | "paused" | "completed" })),
    })),
    lists: listRows.map((row) => ({
      id: String(row.id),
      boardId: String(row.board_id),
      name: String(row.name),
      kind: String(row.kind),
      position: Number(row.position),
      slaBehavior: String(row.sla_behavior) as "running" | "paused" | "completed",
      cards: cards.filter((card) => !card.archived && card.listId === row.id),
    })),
    inbox: inboxRows.map((row) => ({
      id: String(row.id),
      channel: String(row.channel),
      senderName: String(row.sender_name),
      subject: String(row.subject),
      body: String(row.body ?? ""),
      status: String(row.status),
      receivedAt: String(row.received_at),
      convertedCardId: row.converted_card_id ? String(row.converted_card_id) : null,
    })),
    rules: (rulesResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      trigger: String(row.trigger),
      condition: safeJson(String(row.condition_json)),
      action: safeJson(String(row.action_json)),
      enabled: Boolean(row.enabled),
      position: Number(row.position),
    })),
    members: (membersResult.results as Array<Record<string, unknown>>).map((row) => ({
      userId: String(row.user_id),
      email: canManageMembers ? String(row.email) : "",
      name: String(row.name),
      role: String(row.role) as WorkspaceRole,
      joinedAt: String(row.joined_at),
      isOwner: Boolean(row.is_owner),
      isActivated: canManageMembers ? Boolean(row.is_activated) : false,
      companyIds: canManageMembers ? (memberCompanyIds.get(String(row.user_id)) ?? []) : [],
    })),
    availableWorkspaces: (workspacesResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      role: String(row.role) as WorkspaceRole,
    })),
    archivedCards: cards.filter((card) => card.archived),
    labels: (labelsResult.results as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), name: String(row.name), color: String(row.color) })),
    customFields: (customFieldsResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), name: String(row.name), fieldKey: String(row.field_key), fieldType: String(row.field_type) as "text" | "number" | "date" | "select", options: safeArray(String(row.options_json)), required: Boolean(row.required), position: Number(row.position),
    })),
    templates: (templatesResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), name: String(row.name), processType: String(row.process_type), description: String(row.description), checklist: safeArray(String(row.checklist_json)), defaultSlaDays: Number(row.default_sla_days), active: Boolean(row.active), position: Number(row.position),
    })),
    slaPolicies: policyRows.map((row) => ({ id: String(row.id), processType: String(row.process_type), targetBusinessDays: Number(row.target_business_days), warningBusinessDays: Number(row.warning_business_days), active: Boolean(row.active) })),
    holidays: (holidaysResult.results as Array<Record<string, unknown>>).map((row) => ({ date: String(row.holiday_date), name: String(row.name) })),
    settings: { businessDays: businessDays.length ? businessDays : [1, 2, 3, 4, 5], dayStart: String(settingsRow?.day_start ?? "08:00"), dayEnd: String(settingsRow?.day_end ?? "18:00"), realtimeSeconds: Number(settingsRow?.realtime_seconds ?? 30) },
    notifications: (notificationsResult.results as Array<Record<string, unknown>>).filter((row) => companyAccess.unrestricted || Boolean(row.card_id && visibleCardIds.has(String(row.card_id)))).map((row) => ({ id: String(row.id), type: String(row.notification_type), title: String(row.title), body: String(row.body), cardId: row.card_id ? String(row.card_id) : null, readAt: row.read_at ? String(row.read_at) : null, createdAt: String(row.created_at) })),
    integrations: (integrationsResult.results as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), channel: String(row.channel), displayName: String(row.display_name), status: String(row.status) as "connected" | "needs_credentials" | "paused" | "error", config: canManageIntegrations ? publicIntegrationConfig(String(row.config_json)) : {}, lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null, lastError: canManageIntegrations && row.last_error ? safeIntegrationError(new Error(String(row.last_error))).message : null })),
    plannerBlocks: (plannerResult.results as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), userId: String(row.user_id), cardId: row.card_id ? String(row.card_id) : null, title: String(row.title), startAt: String(row.start_at), endAt: String(row.end_at), blockType: String(row.block_type), notes: String(row.notes ?? "") })),
    calendarConnections: (calendarsResult.results as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), provider: String(row.provider), status: String(row.status), config: safeJson(String(row.config_json)), externalCalendarId: row.external_calendar_id ? String(row.external_calendar_id) : null, lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null, lastError: row.last_error ? String(row.last_error) : null })),
    companies: visibleCompanyRows.map((row) => ({ id: String(row.id), parentCompanyId: row.parent_company_id ? String(row.parent_company_id) : null, isPrincipal: Boolean(row.is_principal), legalName: String(row.legal_name), tradeName: String(row.trade_name ?? ""), taxId: String(row.tax_id ?? ""), externalCode: String(row.external_code ?? ""), email: String(row.email ?? ""), phone: String(row.phone ?? ""), status: String(row.status) as "active" | "inactive" })),
    hrMetrics: canReadHr ? visibleMetricRows.map((row) => ({ id: String(row.id), companyId: String(row.company_id), period: String(row.period), headcount: Number(row.headcount ?? 0), headcountStart: Number(row.headcount_start ?? row.headcount ?? 0), headcountEnd: Number(row.headcount_end ?? row.headcount ?? 0), leavesCount: Number(row.leaves_count ?? 0), admissions: Number(row.admissions ?? 0), terminations: Number(row.terminations ?? 0), voluntaryTerminations: Number(row.voluntary_terminations ?? 0), involuntaryTerminations: Number(row.involuntary_terminations ?? 0), baseSalary: Number(row.base_salary ?? 0), variablePay: Number(row.variable_pay ?? 0), overtimePay: Number(row.overtime_pay ?? 0), additionalPay: Number(row.additional_pay ?? 0), vacationPay: Number(row.vacation_pay ?? 0), thirteenthPay: Number(row.thirteenth_pay ?? 0), terminationPay: Number(row.termination_pay ?? 0), grossPayroll: Number(row.gross_payroll ?? 0), employeeInss: Number(row.employee_inss ?? 0), employeeIrrf: Number(row.employee_irrf ?? 0), employeeOtherDeductions: Number(row.employee_other_deductions ?? 0), netPay: Number(row.net_pay ?? 0), employerInss: Number(row.employer_inss ?? 0), ratContribution: Number(row.rat_contribution ?? 0), thirdPartyContributions: Number(row.third_party_contributions ?? 0), fgts: Number(row.fgts ?? 0), fgtsPenalty: Number(row.fgts_penalty ?? 0), employerCharges: Number(row.employer_charges ?? 0), benefitsCost: Number(row.benefits_cost ?? 0), provisionsCost: Number(row.provisions_cost ?? 0), otherCosts: Number(row.other_costs ?? 0), payrollCost: Number(row.payroll_cost ?? 0), source: String(row.source ?? "manual"), externalId: String(row.external_id ?? ""), notes: String(row.notes ?? "") })) : [],
    recentActivity: activityRows.slice(0, 50).map(mapActivity),
  };
}

export function requireWorkspaceRole(role: WorkspaceRole, allowed: WorkspaceRole[]) {
  if (!allowed.includes(role)) {
    throw ApiError.forbidden();
  }
}

export async function runAutomations(
  workspaceId: string,
  boardId: string,
  cardId: string,
  trigger: string,
  actorEmail: string,
  context: Record<string, unknown> = {},
) {
  const d1 = getD1();
  const rules = await d1.prepare("SELECT id, name, condition_json, action_json FROM fdp_automation_rules WHERE workspace_id = ? AND trigger = ? AND enabled = 1 ORDER BY position").bind(workspaceId, trigger).all<Record<string, unknown>>();
  let executed = 0;
  for (const rule of rules.results) {
    const condition = safeJson(String(rule.condition_json));
    const matches = Object.entries(condition).every(([key, expected]) => expected === undefined || context[key] === expected);
    if (!matches) continue;
    const action = safeJson(String(rule.action_json));
    const statements: D1PreparedStatement[] = [];
    if (typeof action.moveTo === "string") {
      const list = await d1.prepare("SELECT id, sla_behavior FROM fdp_lists WHERE board_id = ? AND kind = ?").bind(boardId, action.moveTo).first<{ id: string; sla_behavior: string }>();
      if (list) {
        const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM fdp_cards WHERE list_id = ? AND archived = 0").bind(list.id).first<{ value: number }>();
        const status = list.sla_behavior === "paused" ? "paused" : list.sla_behavior === "completed" ? "completed" : "safe";
        statements.push(d1.prepare("UPDATE fdp_cards SET list_id = ?, position = ?, sla_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND board_id = ?").bind(list.id, Number(position?.value ?? 0) + 1000, status, cardId, boardId));
      }
    }
    if (typeof action.slaStatus === "string") {
      const status = action.slaStatus === "recalculate" ? "safe" : action.slaStatus;
      statements.push(d1.prepare("UPDATE fdp_cards SET sla_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND board_id = ?").bind(status, cardId, boardId));
    }
    if (typeof action.labelId === "string") {
      statements.push(d1.prepare("INSERT INTO fdp_card_labels (workspace_id, card_id, label_id) SELECT ?, ?, id FROM fdp_labels WHERE id = ? AND workspace_id = ? ON CONFLICT DO NOTHING").bind(workspaceId, cardId, action.labelId, workspaceId));
    }
    if (statements.length) await d1.batch(statements);
    await recordActivity(workspaceId, cardId, actorEmail, "automation.executed", { ruleId: rule.id, ruleName: rule.name, trigger });
    executed += 1;
  }
  return executed;
}

function assertTenantWorkspace(workspaceId: string) {
  if (getTenantContext()?.workspaceId !== workspaceId) {
    throw ApiError.forbidden("Contexto tenant inválido para registrar atividade.", "TENANT_CONTEXT_MISMATCH");
  }
}

function publicIntegrationConfig(value: string) {
  const config = safeJson(value);
  const endpoint = typeof config.endpoint === "string" ? config.endpoint.slice(0, 500) : undefined;
  const accountReference = typeof config.accountReference === "string" ? config.accountReference.slice(0, 160) : undefined;
  return { ...(endpoint ? { endpoint } : {}), ...(accountReference ? { accountReference } : {}) };
}

export function prepareActivity(workspaceId: string, cardId: string | null, actorEmail: string, eventType: string, payload: Record<string, unknown> = {}) {
  assertTenantWorkspace(workspaceId);
  const d1 = getD1();
  return d1.prepare("INSERT INTO fdp_activity_events (id, workspace_id, card_id, actor_email, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), workspaceId, cardId, actorEmail, eventType, JSON.stringify(payload));
}

export async function recordActivity(workspaceId: string, cardId: string | null, actorEmail: string, eventType: string, payload: Record<string, unknown> = {}) {
  await prepareActivity(workspaceId, cardId, actorEmail, eventType, payload).run();
}

type AuditEventInput = {
  workspaceId: string;
  actorUserId?: string | null;
  actorEmail: string;
  actorType?: "user" | "system" | "integration";
  action: string;
  outcome?: "success" | "denied" | "failure";
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
};

const sensitiveAuditKey = /password|token|secret|authorization|cookie|senha|chave|cpf|taxpayer/i;

function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditValue(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 2000) : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sensitiveAuditKey.test(key) ? "[redacted]" : redactAuditValue(item, depth + 1),
  ]));
}

function auditJson(value: Record<string, unknown> | null | undefined) {
  return JSON.stringify(redactAuditValue(value ?? {}));
}

export function prepareAuditEvent(input: AuditEventInput) {
  assertTenantWorkspace(input.workspaceId);
  const d1 = getD1();
  return d1.prepare(`INSERT INTO fdp_audit_events
    (id, workspace_id, actor_type, actor_user_id, actor_email, action, outcome, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?)`)
    .bind(
      crypto.randomUUID(), input.workspaceId, input.actorType ?? "user", input.actorUserId ?? null,
      input.actorEmail, input.action, input.outcome ?? "success", input.entityType, input.entityId ?? null,
      auditJson(input.before), auditJson(input.after), auditJson(input.metadata), input.requestId ?? null,
    );
}
