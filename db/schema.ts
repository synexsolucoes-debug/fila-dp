import {
  type AnyPgColumn,
  date,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("fdp_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [uniqueIndex("fdp_users_email_uq").on(table.email)]);

export const workspaces = pgTable("fdp_workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  timezone: text("timezone").notNull().default("America/Sao_Paulo"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_workspaces_owner_uq").on(table.ownerUserId),
  uniqueIndex("fdp_workspaces_slug_uq").on(table.slug),
]);

export const companies = pgTable("fdp_companies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  parentCompanyId: text("parent_company_id").references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
  isPrincipal: integer("is_principal").notNull().default(0),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name").notNull().default(""),
  taxId: text("tax_id").notNull().default(""),
  externalCode: text("external_code").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  index("fdp_companies_workspace_name_idx").on(table.workspaceId, table.legalName),
  index("fdp_companies_workspace_tax_idx").on(table.workspaceId, table.taxId),
  index("fdp_companies_workspace_parent_idx").on(table.workspaceId, table.parentCompanyId),
]);

export const workspaceMembers = pgTable("fdp_workspace_members", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("admin"),
  joinedAt: timestamp("joined_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })]);

export const memberCompanyAccess = pgTable("fdp_member_company_access", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId, table.companyId] }),
  index("fdp_member_company_access_user_idx").on(table.workspaceId, table.userId),
]);

export const accessRecoveryTokens = pgTable("fdp_access_recovery_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdBy: text("created_by").notNull().default("system"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_access_recovery_token_hash_uq").on(table.tokenHash),
  index("fdp_access_recovery_user_expiry_idx").on(table.userId, table.expiresAt),
]);

export const authRateLimits = pgTable("fdp_auth_rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  attemptCount: integer("attempt_count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true, mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [index("fdp_auth_rate_limits_updated_idx").on(table.updatedAt)]);

export const userWorkspacePreferences = pgTable("fdp_user_workspace_preferences", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  activeWorkspaceId: text("active_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  activeBoardId: text("active_board_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const boards = pgTable("fdp_boards", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  boardType: text("board_type").notNull().default("general"),
  processVersion: integer("process_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [uniqueIndex("fdp_boards_workspace_name_uq").on(table.workspaceId, table.name)]);

export const lists = pgTable("fdp_lists", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  position: doublePrecision("position").notNull(),
  slaBehavior: text("sla_behavior").notNull().default("running"),
}, (table) => [
  uniqueIndex("fdp_lists_board_kind_uq").on(table.boardId, table.kind),
  index("fdp_lists_board_position_idx").on(table.boardId, table.position),
]);

export const cards = pgTable("fdp_cards", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
  listId: text("list_id").notNull().references(() => lists.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  companyId: text("company_id").references(() => companies.id, { onDelete: "set null" }),
  company: text("company").notNull().default(""),
  processType: text("process_type").notNull().default("OUTROS"),
  priority: text("priority").notNull().default("normal"),
  assigneeName: text("assignee_name").notNull().default(""),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }),
  slaStatus: text("sla_status").notNull().default("safe"),
  position: doublePrecision("position").notNull(),
  sourceType: text("source_type").notNull().default("manual"),
  archived: integer("archived").notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  slaTargetMinutes: integer("sla_target_minutes").notNull().default(0),
  slaStartedAt: timestamp("sla_started_at", { withTimezone: true, mode: "string" }),
  slaPausedMinutes: integer("sla_paused_minutes").notNull().default(0),
  slaPauseReason: text("sla_pause_reason").notNull().default(""),
  slaEscalationLevel: integer("sla_escalation_level").notNull().default(0),
  processVersion: integer("process_version").notNull().default(1),
}, (table) => [
  index("fdp_cards_board_list_position_idx").on(table.boardId, table.listId, table.position),
  index("fdp_cards_due_status_idx").on(table.dueAt, table.slaStatus),
]);

export const processVersions = pgTable("fdp_process_versions", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshotJson: text("snapshot_json").notNull().default("{}"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_process_versions_board_version_uq").on(table.boardId, table.version),
  index("fdp_process_versions_board_created_idx").on(table.boardId, table.createdAt),
]);

export const checklistItems = pgTable("fdp_checklist_items", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  completed: integer("completed").notNull().default(0),
  position: doublePrecision("position").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (table) => [index("fdp_checklist_card_position_idx").on(table.cardId, table.position)]);

export const cardComments = pgTable("fdp_card_comments", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  authorUserId: text("author_user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [index("fdp_comments_card_created_idx").on(table.cardId, table.createdAt)]);

export const labels = pgTable("fdp_labels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#64748b"),
  position: doublePrecision("position").notNull(),
}, (table) => [uniqueIndex("fdp_labels_workspace_name_uq").on(table.workspaceId, table.name)]);

export const cardLabels = pgTable("fdp_card_labels", {
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  labelId: text("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.cardId, table.labelId] })]);

export const cardAssignees = pgTable("fdp_card_assignees", {
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.cardId, table.userId] })]);

export const customFields = pgTable("fdp_custom_fields", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  fieldKey: text("field_key").notNull(),
  fieldType: text("field_type").notNull().default("text"),
  optionsJson: text("options_json").notNull().default("[]"),
  required: integer("required").notNull().default(0),
  position: doublePrecision("position").notNull(),
}, (table) => [uniqueIndex("fdp_custom_fields_workspace_key_uq").on(table.workspaceId, table.fieldKey)]);

export const customFieldValues = pgTable("fdp_custom_field_values", {
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  fieldId: text("field_id").notNull().references(() => customFields.id, { onDelete: "cascade" }),
  valueText: text("value_text").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.cardId, table.fieldId] })]);

export const cardAttachments = pgTable("fdp_card_attachments", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_attachments_object_key_uq").on(table.objectKey),
  index("fdp_attachments_card_created_idx").on(table.cardId, table.createdAt),
]);

export const processTemplates = pgTable("fdp_process_templates", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  processType: text("process_type").notNull(),
  description: text("description").notNull().default(""),
  checklistJson: text("checklist_json").notNull().default("[]"),
  defaultSlaDays: integer("default_sla_days").notNull().default(3),
  active: integer("active").notNull().default(1),
  position: doublePrecision("position").notNull(),
}, (table) => [uniqueIndex("fdp_templates_workspace_name_uq").on(table.workspaceId, table.name)]);

export const workspaceSettings = pgTable("fdp_workspace_settings", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  businessDaysJson: text("business_days_json").notNull().default("[1,2,3,4,5]"),
  dayStart: text("day_start").notNull().default("08:00"),
  dayEnd: text("day_end").notNull().default("18:00"),
  realtimeSeconds: integer("realtime_seconds").notNull().default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const businessHolidays = pgTable("fdp_business_holidays", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  holidayDate: date("holiday_date", { mode: "string" }).notNull(),
  name: text("name").notNull(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.holidayDate] })]);

export const slaPolicies = pgTable("fdp_sla_policies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  processType: text("process_type").notNull(),
  targetBusinessDays: integer("target_business_days").notNull().default(3),
  warningBusinessDays: integer("warning_business_days").notNull().default(1),
  active: integer("active").notNull().default(1),
}, (table) => [uniqueIndex("fdp_sla_policies_workspace_process_uq").on(table.workspaceId, table.processType)]);

export const notifications = pgTable("fdp_notifications", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  notificationType: text("notification_type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  cardId: text("card_id").references(() => cards.id, { onDelete: "cascade" }),
  readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_notifications_user_event_uq").on(table.userId, table.eventKey),
  index("fdp_notifications_user_read_created_idx").on(table.userId, table.readAt, table.createdAt),
]);

export const integrations = pgTable("fdp_integrations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("needs_credentials"),
  configJson: text("config_json").notNull().default("{}"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "string" }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [uniqueIndex("fdp_integrations_workspace_channel_uq").on(table.workspaceId, table.channel)]);

export const plannerBlocks = pgTable("fdp_planner_blocks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  cardId: text("card_id").references(() => cards.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  startAt: timestamp("start_at", { withTimezone: true, mode: "string" }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true, mode: "string" }).notNull(),
  blockType: text("block_type").notNull().default("focus"),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [index("fdp_planner_user_start_idx").on(table.userId, table.startAt)]);

export const calendarConnections = pgTable("fdp_calendar_connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("needs_credentials"),
  configJson: text("config_json").notNull().default("{}"),
  externalCalendarId: text("external_calendar_id"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "string" }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [uniqueIndex("fdp_calendar_connections_user_provider_uq").on(table.userId, table.provider)]);

export const calendarCredentials = pgTable("fdp_calendar_credentials", {
  connectionId: text("connection_id").primaryKey().references(() => calendarConnections.id, { onDelete: "cascade" }),
  encryptedPayload: text("encrypted_payload").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true, mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const calendarEventLinks = pgTable("fdp_calendar_event_links", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull().references(() => calendarConnections.id, { onDelete: "cascade" }),
  blockId: text("block_id").notNull().references(() => plannerBlocks.id, { onDelete: "cascade" }),
  externalEventId: text("external_event_id").notNull(),
  contentFingerprint: text("content_fingerprint").notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_calendar_event_links_connection_block_uq").on(table.connectionId, table.blockId),
  index("fdp_calendar_event_links_external_idx").on(table.connectionId, table.externalEventId),
]);

export const cardSlaPauses = pgTable("fdp_card_sla_pauses", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
}, (table) => [index("fdp_card_sla_pause_open_idx").on(table.cardId, table.endedAt)]);

export const inboxItems = pgTable("fdp_workspace_inbox_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("manual"),
  senderName: text("sender_name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull().default(""),
  externalId: text("external_id"),
  status: text("status").notNull().default("new"),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  convertedCardId: text("converted_card_id").references(() => cards.id),
}, (table) => [
  index("fdp_inbox_workspace_status_received_idx").on(table.workspaceId, table.status, table.receivedAt),
  uniqueIndex("fdp_inbox_workspace_channel_external_uq").on(table.workspaceId, table.channel, table.externalId),
]);

export const automationRules = pgTable("fdp_automation_rules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  boardId: text("board_id").references(() => boards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  conditionJson: text("condition_json").notNull().default("{}"),
  actionJson: text("action_json").notNull().default("{}"),
  enabled: integer("enabled").notNull().default(1),
  position: doublePrecision("position").notNull(),
}, (table) => [
  index("fdp_rules_workspace_position_idx").on(table.workspaceId, table.position),
  index("fdp_rules_workspace_board_position_idx").on(table.workspaceId, table.boardId, table.position),
]);

export const activityEvents = pgTable("fdp_activity_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cardId: text("card_id").references(() => cards.id, { onDelete: "cascade" }),
  actorEmail: text("actor_email").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [index("fdp_activity_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const hrMetrics = pgTable("fdp_hr_metrics", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  period: text("period").notNull(),
  headcount: integer("headcount").notNull().default(0),
  headcountStart: integer("headcount_start").notNull().default(0),
  headcountEnd: integer("headcount_end").notNull().default(0),
  leavesCount: integer("leaves_count").notNull().default(0),
  admissions: integer("admissions").notNull().default(0),
  terminations: integer("terminations").notNull().default(0),
  voluntaryTerminations: integer("voluntary_terminations").notNull().default(0),
  involuntaryTerminations: integer("involuntary_terminations").notNull().default(0),
  baseSalary: numeric("base_salary", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  variablePay: numeric("variable_pay", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  overtimePay: numeric("overtime_pay", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  additionalPay: numeric("additional_pay", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  vacationPay: numeric("vacation_pay", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  thirteenthPay: numeric("thirteenth_pay", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  terminationPay: numeric("termination_pay", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  grossPayroll: numeric("gross_payroll", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  employeeInss: numeric("employee_inss", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  employeeIrrf: numeric("employee_irrf", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  employeeOtherDeductions: numeric("employee_other_deductions", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  netPay: numeric("net_pay", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  employerInss: numeric("employer_inss", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  ratContribution: numeric("rat_contribution", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  thirdPartyContributions: numeric("third_party_contributions", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  fgts: numeric("fgts", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  fgtsPenalty: numeric("fgts_penalty", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  employerCharges: numeric("employer_charges", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  benefitsCost: numeric("benefits_cost", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  provisionsCost: numeric("provisions_cost", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  otherCosts: numeric("other_costs", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  payrollCost: numeric("payroll_cost", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  source: text("source").notNull().default("manual"),
  externalId: text("external_id").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_hr_metrics_workspace_company_period_uq").on(table.workspaceId, table.companyId, table.period),
  index("fdp_hr_metrics_workspace_period_idx").on(table.workspaceId, table.period),
]);
