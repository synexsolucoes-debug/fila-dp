import { getD1 } from "../db";
import type { ChatGPTUser } from "../app/chatgpt-auth";
import type { WorkspaceRole, WorkspaceSnapshot } from "./fila-dp-types";
import { businessMinutesBetween, workingDayMinutes } from "./fila-dp-sla";

let schemaPromise: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS fdp_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT,
    password_salt TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    owner_user_id TEXT NOT NULL UNIQUE REFERENCES fdp_users(id),
    timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_companies (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    parent_company_id TEXT REFERENCES fdp_companies(id) ON DELETE SET NULL,
    is_principal INTEGER NOT NULL DEFAULT 0,
    legal_name TEXT NOT NULL,
    trade_name TEXT NOT NULL DEFAULT '',
    tax_id TEXT NOT NULL DEFAULT '',
    external_code TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_workspace_members (
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES fdp_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin',
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_member_company_access (
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES fdp_users(id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES fdp_companies(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, user_id, company_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_access_recovery_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES fdp_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_user_workspace_preferences (
    user_id TEXT PRIMARY KEY REFERENCES fdp_users(id) ON DELETE CASCADE,
    active_workspace_id TEXT REFERENCES fdp_workspaces(id) ON DELETE SET NULL,
    active_board_id TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_boards (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    board_type TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_lists (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES fdp_boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position REAL NOT NULL,
    sla_behavior TEXT NOT NULL DEFAULT 'running',
    UNIQUE (board_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_cards (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES fdp_boards(id) ON DELETE CASCADE,
    list_id TEXT NOT NULL REFERENCES fdp_lists(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    company_id TEXT REFERENCES fdp_companies(id) ON DELETE SET NULL,
    company TEXT NOT NULL DEFAULT '',
    process_type TEXT NOT NULL DEFAULT 'OUTROS',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee_name TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    sla_status TEXT NOT NULL DEFAULT 'safe',
    position REAL NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'manual',
    archived INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sla_target_minutes INTEGER NOT NULL DEFAULT 0,
    sla_started_at TEXT,
    sla_paused_minutes INTEGER NOT NULL DEFAULT 0,
    sla_pause_reason TEXT NOT NULL DEFAULT '',
    sla_escalation_level INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_checklist_items (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_card_comments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    author_user_id TEXT NOT NULL REFERENCES fdp_users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_labels (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    position REAL NOT NULL,
    UNIQUE (workspace_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_card_labels (
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES fdp_labels(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, label_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_card_assignees (
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES fdp_users(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_custom_fields (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    field_key TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'text',
    options_json TEXT NOT NULL DEFAULT '[]',
    required INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL,
    UNIQUE (workspace_id, field_key)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_custom_field_values (
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    field_id TEXT NOT NULL REFERENCES fdp_custom_fields(id) ON DELETE CASCADE,
    value_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (card_id, field_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_card_attachments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_process_templates (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    process_type TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    checklist_json TEXT NOT NULL DEFAULT '[]',
    default_sla_days INTEGER NOT NULL DEFAULT 3,
    active INTEGER NOT NULL DEFAULT 1,
    position REAL NOT NULL,
    UNIQUE (workspace_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_workspace_settings (
    workspace_id TEXT PRIMARY KEY REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    business_days_json TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
    day_start TEXT NOT NULL DEFAULT '08:00',
    day_end TEXT NOT NULL DEFAULT '18:00',
    realtime_seconds INTEGER NOT NULL DEFAULT 30,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_business_holidays (
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    holiday_date TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (workspace_id, holiday_date)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_sla_policies (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    process_type TEXT NOT NULL,
    target_business_days INTEGER NOT NULL DEFAULT 3,
    warning_business_days INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (workspace_id, process_type)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_notifications (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES fdp_users(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    notification_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    card_id TEXT REFERENCES fdp_cards(id) ON DELETE CASCADE,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, event_key)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_integrations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'needs_credentials',
    config_json TEXT NOT NULL DEFAULT '{}',
    last_sync_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, channel)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_planner_blocks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES fdp_users(id) ON DELETE CASCADE,
    card_id TEXT REFERENCES fdp_cards(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    block_type TEXT NOT NULL DEFAULT 'focus',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_calendar_connections (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES fdp_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'needs_credentials',
    config_json TEXT NOT NULL DEFAULT '{}',
    external_calendar_id TEXT,
    last_sync_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_card_sla_pauses (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_workspace_inbox_items (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'manual',
    sender_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    converted_card_id TEXT REFERENCES fdp_cards(id)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_automation_rules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    condition_json TEXT NOT NULL DEFAULT '{}',
    action_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    position REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_activity_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    card_id TEXT REFERENCES fdp_cards(id) ON DELETE CASCADE,
    actor_email TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_hr_metrics (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES fdp_companies(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    headcount INTEGER NOT NULL DEFAULT 0,
    headcount_start INTEGER NOT NULL DEFAULT 0,
    headcount_end INTEGER NOT NULL DEFAULT 0,
    leaves_count INTEGER NOT NULL DEFAULT 0,
    admissions INTEGER NOT NULL DEFAULT 0,
    terminations INTEGER NOT NULL DEFAULT 0,
    voluntary_terminations INTEGER NOT NULL DEFAULT 0,
    involuntary_terminations INTEGER NOT NULL DEFAULT 0,
    base_salary REAL NOT NULL DEFAULT 0,
    variable_pay REAL NOT NULL DEFAULT 0,
    overtime_pay REAL NOT NULL DEFAULT 0,
    additional_pay REAL NOT NULL DEFAULT 0,
    vacation_pay REAL NOT NULL DEFAULT 0,
    thirteenth_pay REAL NOT NULL DEFAULT 0,
    termination_pay REAL NOT NULL DEFAULT 0,
    gross_payroll REAL NOT NULL DEFAULT 0,
    employee_inss REAL NOT NULL DEFAULT 0,
    employee_irrf REAL NOT NULL DEFAULT 0,
    employee_other_deductions REAL NOT NULL DEFAULT 0,
    net_pay REAL NOT NULL DEFAULT 0,
    employer_inss REAL NOT NULL DEFAULT 0,
    rat_contribution REAL NOT NULL DEFAULT 0,
    third_party_contributions REAL NOT NULL DEFAULT 0,
    fgts REAL NOT NULL DEFAULT 0,
    fgts_penalty REAL NOT NULL DEFAULT 0,
    employer_charges REAL NOT NULL DEFAULT 0,
    benefits_cost REAL NOT NULL DEFAULT 0,
    provisions_cost REAL NOT NULL DEFAULT 0,
    other_costs REAL NOT NULL DEFAULT 0,
    payroll_cost REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, company_id, period)
  )`,
  "CREATE INDEX IF NOT EXISTS fdp_cards_board_list_position_idx ON fdp_cards (board_id, list_id, position)",
  "CREATE INDEX IF NOT EXISTS fdp_cards_due_status_idx ON fdp_cards (due_at, sla_status)",
  "CREATE INDEX IF NOT EXISTS fdp_checklist_card_position_idx ON fdp_checklist_items (card_id, position)",
  "CREATE INDEX IF NOT EXISTS fdp_comments_card_created_idx ON fdp_card_comments (card_id, created_at)",
  "CREATE INDEX IF NOT EXISTS fdp_attachments_card_created_idx ON fdp_card_attachments (card_id, created_at)",
  "CREATE INDEX IF NOT EXISTS fdp_planner_user_start_idx ON fdp_planner_blocks (user_id, start_at)",
  "CREATE INDEX IF NOT EXISTS fdp_card_sla_pause_open_idx ON fdp_card_sla_pauses (card_id, ended_at)",
  "CREATE INDEX IF NOT EXISTS fdp_notifications_user_read_created_idx ON fdp_notifications (user_id, read_at, created_at)",
  "CREATE INDEX IF NOT EXISTS fdp_inbox_workspace_status_received_idx ON fdp_workspace_inbox_items (workspace_id, status, received_at)",
  "CREATE INDEX IF NOT EXISTS fdp_activity_workspace_created_idx ON fdp_activity_events (workspace_id, created_at)",
  "CREATE INDEX IF NOT EXISTS fdp_companies_workspace_name_idx ON fdp_companies (workspace_id, legal_name)",
  "CREATE INDEX IF NOT EXISTS fdp_companies_workspace_tax_idx ON fdp_companies (workspace_id, tax_id)",
  "CREATE INDEX IF NOT EXISTS fdp_member_company_access_user_idx ON fdp_member_company_access (workspace_id, user_id)",
  "CREATE INDEX IF NOT EXISTS fdp_hr_metrics_workspace_period_idx ON fdp_hr_metrics (workspace_id, period)",
  "CREATE INDEX IF NOT EXISTS fdp_access_recovery_user_expiry_idx ON fdp_access_recovery_tokens (user_id, expires_at)",
];

export async function ensureSchema() {
  if (!schemaPromise) {
    const d1 = getD1();
    schemaPromise = d1.batch(schemaStatements.map((statement) => d1.prepare(statement))).then(async () => {
      const columns = await d1.prepare("PRAGMA table_info(fdp_users)").all<{ name: string }>();
      const names = new Set(columns.results.map((column) => column.name));
      const cardColumns = await d1.prepare("PRAGMA table_info(fdp_cards)").all<{ name: string }>();
      const cardNames = new Set(cardColumns.results.map((column) => column.name));
      const companyColumns = await d1.prepare("PRAGMA table_info(fdp_companies)").all<{ name: string }>();
      const companyNames = new Set(companyColumns.results.map((column) => column.name));
      const hrMetricColumns = await d1.prepare("PRAGMA table_info(fdp_hr_metrics)").all<{ name: string }>();
      const hrMetricNames = new Set(hrMetricColumns.results.map((column) => column.name));
      const compatibility = [
        !names.has("password_hash") ? d1.prepare("ALTER TABLE fdp_users ADD COLUMN password_hash TEXT") : null,
        !names.has("password_salt") ? d1.prepare("ALTER TABLE fdp_users ADD COLUMN password_salt TEXT") : null,
        !companyNames.has("parent_company_id") ? d1.prepare("ALTER TABLE fdp_companies ADD COLUMN parent_company_id TEXT REFERENCES fdp_companies(id) ON DELETE SET NULL") : null,
        !companyNames.has("is_principal") ? d1.prepare("ALTER TABLE fdp_companies ADD COLUMN is_principal INTEGER NOT NULL DEFAULT 0") : null,
        !cardNames.has("company_id") ? d1.prepare("ALTER TABLE fdp_cards ADD COLUMN company_id TEXT REFERENCES fdp_companies(id) ON DELETE SET NULL") : null,
        !cardNames.has("sla_target_minutes") ? d1.prepare("ALTER TABLE fdp_cards ADD COLUMN sla_target_minutes INTEGER NOT NULL DEFAULT 0") : null,
        !cardNames.has("sla_started_at") ? d1.prepare("ALTER TABLE fdp_cards ADD COLUMN sla_started_at TEXT") : null,
        !cardNames.has("sla_paused_minutes") ? d1.prepare("ALTER TABLE fdp_cards ADD COLUMN sla_paused_minutes INTEGER NOT NULL DEFAULT 0") : null,
        !cardNames.has("sla_pause_reason") ? d1.prepare("ALTER TABLE fdp_cards ADD COLUMN sla_pause_reason TEXT NOT NULL DEFAULT ''") : null,
        !cardNames.has("sla_escalation_level") ? d1.prepare("ALTER TABLE fdp_cards ADD COLUMN sla_escalation_level INTEGER NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("gross_payroll") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN gross_payroll REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("headcount_start") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN headcount_start INTEGER NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("headcount_end") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN headcount_end INTEGER NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("leaves_count") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN leaves_count INTEGER NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("voluntary_terminations") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN voluntary_terminations INTEGER NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("involuntary_terminations") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN involuntary_terminations INTEGER NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("base_salary") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN base_salary REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("variable_pay") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN variable_pay REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("overtime_pay") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN overtime_pay REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("additional_pay") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN additional_pay REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("vacation_pay") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN vacation_pay REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("thirteenth_pay") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN thirteenth_pay REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("termination_pay") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN termination_pay REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("employee_inss") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN employee_inss REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("employee_irrf") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN employee_irrf REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("employee_other_deductions") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN employee_other_deductions REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("net_pay") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN net_pay REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("employer_inss") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN employer_inss REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("rat_contribution") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN rat_contribution REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("third_party_contributions") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN third_party_contributions REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("fgts") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN fgts REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("fgts_penalty") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN fgts_penalty REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("employer_charges") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN employer_charges REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("benefits_cost") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN benefits_cost REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("provisions_cost") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN provisions_cost REAL NOT NULL DEFAULT 0") : null,
        !hrMetricNames.has("other_costs") ? d1.prepare("ALTER TABLE fdp_hr_metrics ADD COLUMN other_costs REAL NOT NULL DEFAULT 0") : null,
      ].filter((statement): statement is D1PreparedStatement => Boolean(statement));
      if (compatibility.length) await d1.batch(compatibility);
      await d1.prepare("CREATE INDEX IF NOT EXISTS fdp_cards_company_idx ON fdp_cards (company_id)").run();
      // Existing production databases can predate parent_company_id. Create
      // this index only after the compatibility migration above has completed.
      await d1.prepare("CREATE INDEX IF NOT EXISTS fdp_companies_workspace_parent_idx ON fdp_companies (workspace_id, parent_company_id)").run();
    });
  }
  return schemaPromise;
}

function dateOffset(days: number) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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
  if (!companyId) throw new Error("Selecione uma empresa à qual você tenha acesso.");
  const access = await d1.prepare("SELECT 1 FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ? AND company_id = ?")
    .bind(workspaceId, userId, companyId)
    .first();
  if (!access) throw new Error("Você não tem acesso a esta empresa.");
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
  if (!card) throw new Error("Demanda não encontrada.");
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
  { key: "admissao", name: "Admissão completa", process: "ADMISSÃO", days: 2, checklist: ["Documentos pessoais recebidos", "Exame admissional anexado", "Cadastro no sistema concluído", "Benefícios configurados"] },
  { key: "rescisao", name: "Rescisão", process: "RESCISÃO", days: 2, checklist: ["Desligamento registrado", "Cálculo rescisório conferido", "Documentos finais enviados", "Pagamento confirmado"] },
  { key: "ferias", name: "Programação de férias", process: "FÉRIAS", days: 5, checklist: ["Período aquisitivo validado", "Gestor confirmou as datas", "Aviso de férias emitido", "Pagamento programado"] },
  { key: "beneficios", name: "Benefícios", process: "BENEFÍCIOS", days: 3, checklist: ["Elegibilidade validada", "Documentos conferidos", "Solicitação enviada à operadora"] },
] as const;

async function ensureWorkspaceDefaults(d1: ReturnType<typeof getD1>, workspaceId: string) {
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
    ["ADMISSÃO", 2, 1], ["RESCISÃO", 2, 1], ["FÉRIAS", 5, 2], ["BENEFÍCIOS", 3, 1], ["FOLHA", 2, 1], ["OUTROS", 3, 1],
  ] as const;
  const integrationRows = [
    ["email", "E-mail corporativo"], ["whatsapp", "WhatsApp Business"], ["teams", "Microsoft Teams"], ["drive", "Google Drive"], ["onedrive", "Microsoft OneDrive"], ["erp", "ERP / Folha"],
  ] as const;

  await d1.batch([
    d1.prepare("INSERT OR IGNORE INTO fdp_workspace_settings (workspace_id) VALUES (?)").bind(workspaceId),
    ...defaultLabels.map(([key, name, color], index) => d1.prepare("INSERT OR IGNORE INTO fdp_labels (id, workspace_id, name, color, position) VALUES (?, ?, ?, ?, ?)").bind(`${workspaceId}:label:${key}`, workspaceId, name, color, (index + 1) * 1000)),
    ...defaultFields.map(([key, name, type, options], index) => d1.prepare("INSERT OR IGNORE INTO fdp_custom_fields (id, workspace_id, name, field_key, field_type, options_json, position) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(`${workspaceId}:field:${key}`, workspaceId, name, key, type, options, (index + 1) * 1000)),
    ...nativeTemplates.map((template, index) => d1.prepare("INSERT OR IGNORE INTO fdp_process_templates (id, workspace_id, name, process_type, description, checklist_json, default_sla_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(`${workspaceId}:template:${template.key}`, workspaceId, template.name, template.process, `Fluxo padrão de ${template.name.toLowerCase()} do Fila DP.`, JSON.stringify(template.checklist), template.days, (index + 1) * 1000)),
    ...policies.map(([processType, target, warning]) => d1.prepare("INSERT OR IGNORE INTO fdp_sla_policies (id, workspace_id, process_type, target_business_days, warning_business_days) VALUES (?, ?, ?, ?, ?)").bind(`${workspaceId}:sla:${processType}`, workspaceId, processType, target, warning)),
    ...integrationRows.map(([channel, displayName]) => d1.prepare("INSERT OR IGNORE INTO fdp_integrations (id, workspace_id, channel, display_name) VALUES (?, ?, ?, ?)").bind(`${workspaceId}:integration:${channel}`, workspaceId, channel, displayName)),
  ]);
}

async function removeLegacyProcessLists(d1: ReturnType<typeof getD1>, workspaceId: string) {
  const boards = await d1.prepare("SELECT id FROM fdp_boards WHERE workspace_id = ?").bind(workspaceId).all<{ id: string }>();
  for (const board of boards.results) {
    const target = await d1.prepare("SELECT id FROM fdp_lists WHERE board_id = ? AND kind = 'analysis' LIMIT 1").bind(board.id).first<{ id: string }>();
    const fallback = target ?? await d1.prepare("SELECT id FROM fdp_lists WHERE board_id = ? AND kind = 'new' LIMIT 1").bind(board.id).first<{ id: string }>();
    if (!fallback) continue;
    const legacy = await d1.prepare("SELECT id FROM fdp_lists WHERE board_id = ? AND kind IN ('waiting', 'review')").bind(board.id).all<{ id: string }>();
    for (const list of legacy.results) {
      await d1.prepare("UPDATE fdp_cards SET list_id = ?, sla_status = CASE WHEN sla_status = 'paused' THEN 'warning' ELSE sla_status END, updated_at = CURRENT_TIMESTAMP WHERE list_id = ?").bind(fallback.id, list.id).run();
      await d1.prepare("DELETE FROM fdp_lists WHERE id = ?").bind(list.id).run();
    }
  }
}

export async function getWorkspaceContext(user: ChatGPTUser) {
  await ensureSchema();
  const d1 = getD1();
  const normalizedEmail = user.email.trim().toLowerCase();

  const userRow = await d1.prepare("SELECT id, email, name FROM fdp_users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: string; email: string; name: string }>();
  if (!userRow) throw new Error("Sem permissão para acessar este grupo.");

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

  if (!workspace) throw new Error("Sem permissão para acessar este grupo. Peça ao administrador para liberar seu usuário.");

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

  if (!board) {
    const boardId = crypto.randomUUID();
    const listIds = {
      new: crypto.randomUUID(),
      analysis: crypto.randomUUID(),
      done: crypto.randomUUID(),
    };
    const cardIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const ruleRows = [
      ["Ao atribuir um analista, mover para Em análise", "assignee.added", { assignee: "present" }, { moveTo: "analysis" }],
      ["Quando o SLA vencer, marcar como Atrasado", "sla.tick", { dueAt: "past" }, { slaStatus: "overdue" }],
      ["Ao concluir o checklist, mover para Concluído", "checklist.completed", { allItems: true }, { moveTo: "done" }],
    ] as const;

    await d1.batch([
      d1.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, 'Fila geral', 'Operação central do Departamento Pessoal', 'general')")
        .bind(boardId, workspace.id),
      d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Novas demandas', 'new', 1000, 'running')").bind(listIds.new, boardId),
      d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Em análise', 'analysis', 2000, 'running')").bind(listIds.analysis, boardId),
      d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Concluído', 'done', 3000, 'completed')").bind(listIds.done, boardId),
      d1.prepare(`INSERT INTO fdp_cards (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, 'Admissão — Maria Oliveira', 'Conferir documentos e preparar cadastro de admissão.', 'Synex Soluções', 'ADMISSÃO', 'urgent', 'Ana Martins', ?, 'warning', 1000, 'email', ?)`)
        .bind(cardIds[0], boardId, listIds.new, dateOffset(0), userRow.email),
      d1.prepare(`INSERT INTO fdp_cards (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, 'Inclusão no plano de saúde', 'Validar elegibilidade e documentação do dependente.', 'Matrícula 0482', 'BENEFÍCIOS', 'normal', 'Lucas Souza', ?, 'safe', 1000, 'manual', ?)`)
        .bind(cardIds[1], boardId, listIds.analysis, dateOffset(2), userRow.email),
      d1.prepare(`INSERT INTO fdp_cards (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, 'Documentos pendentes — Ana Reis', 'Aguardando comprovante e exame admissional.', 'Synex Soluções', 'ADMISSÃO', 'high', 'Rafael Costa', ?, 'warning', 1000, 'whatsapp', ?)`)
        .bind(cardIds[2], boardId, listIds.analysis, dateOffset(1), userRow.email),
      d1.prepare(`INSERT INTO fdp_cards (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, 'Conferência de cálculo rescisório', 'Revisar verbas e documentação antes do envio.', 'Empresa Sul', 'RESCISÃO', 'high', 'Ana Martins', ?, 'safe', 1000, 'teams', ?)`)
        .bind(cardIds[3], boardId, listIds.analysis, dateOffset(3), userRow.email),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Documentos pessoais recebidos', 1, 1000)").bind(crypto.randomUUID(), cardIds[0]),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Exame admissional anexado', 0, 2000)").bind(crypto.randomUUID(), cardIds[0]),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Cadastro no sistema concluído', 0, 3000)").bind(crypto.randomUUID(), cardIds[0]),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Elegibilidade validada', 1, 1000)").bind(crypto.randomUUID(), cardIds[1]),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Inclusão enviada à operadora', 0, 2000)").bind(crypto.randomUUID(), cardIds[1]),
      d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status, received_at) VALUES (?, ?, 'whatsapp', 'Mariana — Financeiro', 'Alteração de vale-transporte', 'Solicitação recebida pelo WhatsApp para a próxima competência.', 'new', datetime('now', '-18 minutes'))").bind(crypto.randomUUID(), workspace.id),
      d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status, received_at) VALUES (?, ?, 'email', 'Carlos Mendes', 'Programação de férias', 'Solicita programação para início no próximo mês.', 'new', datetime('now', '-2 hours'))").bind(crypto.randomUUID(), workspace.id),
      d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status, received_at) VALUES (?, ?, 'teams', 'Gestora Comercial', 'Nova admissão aprovada', 'Candidata aprovada; dados iniciais enviados no Teams.', 'new', datetime('now', '-1 day'))").bind(crypto.randomUUID(), workspace.id),
      ...ruleRows.map(([name, trigger, condition, action], index) =>
        d1.prepare("INSERT INTO fdp_automation_rules (id, workspace_id, name, trigger, condition_json, action_json, enabled, position) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
          .bind(crypto.randomUUID(), workspace!.id, name, trigger, JSON.stringify(condition), JSON.stringify(action), (index + 1) * 1000)),
    ]);
    board = { id: boardId, name: "Fila geral", description: "Operação central do Departamento Pessoal", board_type: "general" };
  }

  await d1.prepare("UPDATE fdp_user_workspace_preferences SET active_board_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?").bind(board.id, userRow.id, workspace.id).run();

  await ensureWorkspaceDefaults(d1, workspace.id);
  await removeLegacyProcessLists(d1, workspace.id);

  return { d1, user: userRow, workspace, board };
}

export async function getWorkspaceSnapshot(user: ChatGPTUser): Promise<WorkspaceSnapshot> {
  const { d1, workspace, board, user: userRow } = await getWorkspaceContext(user);
  const companyAccess = await getCompanyAccessScope(d1, workspace.id, userRow.id, workspace.role);
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
  const escalationRecipients = (membersResult.results as Array<Record<string, unknown>>)
    .filter((member) => ["admin", "member"].includes(String(member.role)))
    .map((member) => String(member.user_id));
  const slaStatements: D1PreparedStatement[] = [];

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
      slaStatements.push(d1.prepare("UPDATE fdp_cards SET sla_status = ?, sla_escalation_level = CASE WHEN ? = 1 THEN 1 ELSE sla_escalation_level END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, shouldEscalate ? 1 : 0, String(row.id)));
    }
    if ((status === "warning" || status === "overdue") && dueAt) {
      slaStatements.push(d1.prepare(`INSERT OR IGNORE INTO fdp_notifications
        (id, workspace_id, user_id, event_key, notification_type, title, body, card_id)
        VALUES (?, ?, ?, ?, 'sla', ?, ?, ?)`).bind(
          crypto.randomUUID(), workspace.id, userRow.id, `sla:${row.id}:${status}:${dueAt}`,
          status === "overdue" ? "SLA atrasado" : "SLA próximo do vencimento",
          `${String(row.title)} • prazo ${dueAt.split("-").reverse().join("/")}`,
          String(row.id),
      ));
    }
    if (shouldEscalate) {
      for (const recipientId of escalationRecipients) {
        slaStatements.push(d1.prepare(`INSERT OR IGNORE INTO fdp_notifications
          (id, workspace_id, user_id, event_key, notification_type, title, body, card_id)
          VALUES (?, ?, ?, ?, 'sla_escalation', 'Escalonamento de SLA', ?, ?)`)
          .bind(crypto.randomUUID(), workspace.id, recipientId, `sla-escalation:${row.id}:1:${recipientId}`, `${String(row.title)} ultrapassou o SLA e requer ação imediata.`, String(row.id)));
      }
    }
  }
  if (slaStatements.length) await d1.batch(slaStatements);

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
      email: String(row.email),
      name: String(row.name),
      role: String(row.role) as WorkspaceRole,
      joinedAt: String(row.joined_at),
      isOwner: Boolean(row.is_owner),
      isActivated: Boolean(row.is_activated),
      companyIds: memberCompanyIds.get(String(row.user_id)) ?? [],
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
    integrations: (integrationsResult.results as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), channel: String(row.channel), displayName: String(row.display_name), status: String(row.status) as "connected" | "needs_credentials" | "paused" | "error", config: safeJson(String(row.config_json)), lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null, lastError: row.last_error ? String(row.last_error) : null })),
    plannerBlocks: (plannerResult.results as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), userId: String(row.user_id), cardId: row.card_id ? String(row.card_id) : null, title: String(row.title), startAt: String(row.start_at), endAt: String(row.end_at), blockType: String(row.block_type), notes: String(row.notes ?? "") })),
    calendarConnections: (calendarsResult.results as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), provider: String(row.provider), status: String(row.status), config: safeJson(String(row.config_json)), externalCalendarId: row.external_calendar_id ? String(row.external_calendar_id) : null, lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null, lastError: row.last_error ? String(row.last_error) : null })),
    companies: visibleCompanyRows.map((row) => ({ id: String(row.id), parentCompanyId: row.parent_company_id ? String(row.parent_company_id) : null, isPrincipal: Boolean(row.is_principal), legalName: String(row.legal_name), tradeName: String(row.trade_name ?? ""), taxId: String(row.tax_id ?? ""), externalCode: String(row.external_code ?? ""), email: String(row.email ?? ""), phone: String(row.phone ?? ""), status: String(row.status) as "active" | "inactive" })),
    hrMetrics: visibleMetricRows.map((row) => ({ id: String(row.id), companyId: String(row.company_id), period: String(row.period), headcount: Number(row.headcount ?? 0), headcountStart: Number(row.headcount_start ?? row.headcount ?? 0), headcountEnd: Number(row.headcount_end ?? row.headcount ?? 0), leavesCount: Number(row.leaves_count ?? 0), admissions: Number(row.admissions ?? 0), terminations: Number(row.terminations ?? 0), voluntaryTerminations: Number(row.voluntary_terminations ?? 0), involuntaryTerminations: Number(row.involuntary_terminations ?? 0), baseSalary: Number(row.base_salary ?? 0), variablePay: Number(row.variable_pay ?? 0), overtimePay: Number(row.overtime_pay ?? 0), additionalPay: Number(row.additional_pay ?? 0), vacationPay: Number(row.vacation_pay ?? 0), thirteenthPay: Number(row.thirteenth_pay ?? 0), terminationPay: Number(row.termination_pay ?? 0), grossPayroll: Number(row.gross_payroll ?? 0), employeeInss: Number(row.employee_inss ?? 0), employeeIrrf: Number(row.employee_irrf ?? 0), employeeOtherDeductions: Number(row.employee_other_deductions ?? 0), netPay: Number(row.net_pay ?? 0), employerInss: Number(row.employer_inss ?? 0), ratContribution: Number(row.rat_contribution ?? 0), thirdPartyContributions: Number(row.third_party_contributions ?? 0), fgts: Number(row.fgts ?? 0), fgtsPenalty: Number(row.fgts_penalty ?? 0), employerCharges: Number(row.employer_charges ?? 0), benefitsCost: Number(row.benefits_cost ?? 0), provisionsCost: Number(row.provisions_cost ?? 0), otherCosts: Number(row.other_costs ?? 0), payrollCost: Number(row.payroll_cost ?? 0), source: String(row.source ?? "manual"), externalId: String(row.external_id ?? ""), notes: String(row.notes ?? "") })),
    recentActivity: activityRows.slice(0, 50).map(mapActivity),
  };
}

export function requireWorkspaceRole(role: WorkspaceRole, allowed: WorkspaceRole[]) {
  if (!allowed.includes(role)) {
    throw new Error("Você não tem permissão para realizar esta ação.");
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
      statements.push(d1.prepare("INSERT OR IGNORE INTO fdp_card_labels (card_id, label_id) SELECT ?, id FROM fdp_labels WHERE id = ? AND workspace_id = ?").bind(cardId, action.labelId, workspaceId));
    }
    if (statements.length) await d1.batch(statements);
    await recordActivity(workspaceId, cardId, actorEmail, "automation.executed", { ruleId: rule.id, ruleName: rule.name, trigger });
    executed += 1;
  }
  return executed;
}

export async function recordActivity(workspaceId: string, cardId: string | null, actorEmail: string, eventType: string, payload: Record<string, unknown> = {}) {
  const d1 = getD1();
  await d1.prepare("INSERT INTO fdp_activity_events (id, workspace_id, card_id, actor_email, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), workspaceId, cardId, actorEmail, eventType, JSON.stringify(payload))
    .run();
}

