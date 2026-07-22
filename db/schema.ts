import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("fdp_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("fdp_users_email_uq").on(table.email)]);

export const workspaces = sqliteTable("fdp_workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  timezone: text("timezone").notNull().default("America/Sao_Paulo"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("fdp_workspaces_owner_uq").on(table.ownerUserId),
  uniqueIndex("fdp_workspaces_slug_uq").on(table.slug),
]);

export const companies = sqliteTable("fdp_companies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name").notNull().default(""),
  taxId: text("tax_id").notNull().default(""),
  externalCode: text("external_code").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("fdp_companies_workspace_name_idx").on(table.workspaceId, table.legalName),
  index("fdp_companies_workspace_tax_idx").on(table.workspaceId, table.taxId),
]);

export const workspaceMembers = sqliteTable("fdp_workspace_members", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("admin"),
  joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })]);

export const userWorkspacePreferences = sqliteTable("fdp_user_workspace_preferences", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  activeWorkspaceId: text("active_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  activeBoardId: text("active_board_id"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const boards = sqliteTable("fdp_boards", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  boardType: text("board_type").notNull().default("general"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("fdp_boards_workspace_name_uq").on(table.workspaceId, table.name)]);

export const lists = sqliteTable("fdp_lists", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  position: real("position").notNull(),
  slaBehavior: text("sla_behavior").notNull().default("running"),
}, (table) => [
  uniqueIndex("fdp_lists_board_kind_uq").on(table.boardId, table.kind),
  index("fdp_lists_board_position_idx").on(table.boardId, table.position),
]);

export const cards = sqliteTable("fdp_cards", {
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
  dueAt: text("due_at"),
  slaStatus: text("sla_status").notNull().default("safe"),
  position: real("position").notNull(),
  sourceType: text("source_type").notNull().default("manual"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  slaTargetMinutes: integer("sla_target_minutes").notNull().default(0),
  slaStartedAt: text("sla_started_at"),
  slaPausedMinutes: integer("sla_paused_minutes").notNull().default(0),
  slaPauseReason: text("sla_pause_reason").notNull().default(""),
  slaEscalationLevel: integer("sla_escalation_level").notNull().default(0),
}, (table) => [
  index("fdp_cards_board_list_position_idx").on(table.boardId, table.listId, table.position),
  index("fdp_cards_due_status_idx").on(table.dueAt, table.slaStatus),
]);

export const checklistItems = sqliteTable("fdp_checklist_items", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  position: real("position").notNull(),
  completedAt: text("completed_at"),
}, (table) => [index("fdp_checklist_card_position_idx").on(table.cardId, table.position)]);

export const cardComments = sqliteTable("fdp_card_comments", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  authorUserId: text("author_user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("fdp_comments_card_created_idx").on(table.cardId, table.createdAt)]);

export const labels = sqliteTable("fdp_labels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#64748b"),
  position: real("position").notNull(),
}, (table) => [uniqueIndex("fdp_labels_workspace_name_uq").on(table.workspaceId, table.name)]);

export const cardLabels = sqliteTable("fdp_card_labels", {
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  labelId: text("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.cardId, table.labelId] })]);

export const cardAssignees = sqliteTable("fdp_card_assignees", {
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.cardId, table.userId] })]);

export const customFields = sqliteTable("fdp_custom_fields", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  fieldKey: text("field_key").notNull(),
  fieldType: text("field_type").notNull().default("text"),
  optionsJson: text("options_json").notNull().default("[]"),
  required: integer("required", { mode: "boolean" }).notNull().default(false),
  position: real("position").notNull(),
}, (table) => [uniqueIndex("fdp_custom_fields_workspace_key_uq").on(table.workspaceId, table.fieldKey)]);

export const customFieldValues = sqliteTable("fdp_custom_field_values", {
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  fieldId: text("field_id").notNull().references(() => customFields.id, { onDelete: "cascade" }),
  valueText: text("value_text").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.cardId, table.fieldId] })]);

export const cardAttachments = sqliteTable("fdp_card_attachments", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("fdp_attachments_object_key_uq").on(table.objectKey),
  index("fdp_attachments_card_created_idx").on(table.cardId, table.createdAt),
]);

export const processTemplates = sqliteTable("fdp_process_templates", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  processType: text("process_type").notNull(),
  description: text("description").notNull().default(""),
  checklistJson: text("checklist_json").notNull().default("[]"),
  defaultSlaDays: integer("default_sla_days").notNull().default(3),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  position: real("position").notNull(),
}, (table) => [uniqueIndex("fdp_templates_workspace_name_uq").on(table.workspaceId, table.name)]);

export const workspaceSettings = sqliteTable("fdp_workspace_settings", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  businessDaysJson: text("business_days_json").notNull().default("[1,2,3,4,5]"),
  dayStart: text("day_start").notNull().default("08:00"),
  dayEnd: text("day_end").notNull().default("18:00"),
  realtimeSeconds: integer("realtime_seconds").notNull().default(30),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const businessHolidays = sqliteTable("fdp_business_holidays", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  holidayDate: text("holiday_date").notNull(),
  name: text("name").notNull(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.holidayDate] })]);

export const slaPolicies = sqliteTable("fdp_sla_policies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  processType: text("process_type").notNull(),
  targetBusinessDays: integer("target_business_days").notNull().default(3),
  warningBusinessDays: integer("warning_business_days").notNull().default(1),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [uniqueIndex("fdp_sla_policies_workspace_process_uq").on(table.workspaceId, table.processType)]);

export const notifications = sqliteTable("fdp_notifications", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  notificationType: text("notification_type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  cardId: text("card_id").references(() => cards.id, { onDelete: "cascade" }),
  readAt: text("read_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("fdp_notifications_user_event_uq").on(table.userId, table.eventKey),
  index("fdp_notifications_user_read_created_idx").on(table.userId, table.readAt, table.createdAt),
]);

export const integrations = sqliteTable("fdp_integrations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("needs_credentials"),
  configJson: text("config_json").notNull().default("{}"),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("fdp_integrations_workspace_channel_uq").on(table.workspaceId, table.channel)]);

export const plannerBlocks = sqliteTable("fdp_planner_blocks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  cardId: text("card_id").references(() => cards.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  blockType: text("block_type").notNull().default("focus"),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("fdp_planner_user_start_idx").on(table.userId, table.startAt)]);

export const calendarConnections = sqliteTable("fdp_calendar_connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("needs_credentials"),
  configJson: text("config_json").notNull().default("{}"),
  externalCalendarId: text("external_calendar_id"),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("fdp_calendar_connections_user_provider_uq").on(table.userId, table.provider)]);

export const cardSlaPauses = sqliteTable("fdp_card_sla_pauses", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  endedAt: text("ended_at"),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
}, (table) => [index("fdp_card_sla_pause_open_idx").on(table.cardId, table.endedAt)]);

export const inboxItems = sqliteTable("fdp_workspace_inbox_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("manual"),
  senderName: text("sender_name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull().default(""),
  status: text("status").notNull().default("new"),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  convertedCardId: text("converted_card_id").references(() => cards.id),
}, (table) => [index("fdp_inbox_workspace_status_received_idx").on(table.workspaceId, table.status, table.receivedAt)]);

export const automationRules = sqliteTable("fdp_automation_rules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  conditionJson: text("condition_json").notNull().default("{}"),
  actionJson: text("action_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  position: real("position").notNull(),
}, (table) => [index("fdp_rules_workspace_position_idx").on(table.workspaceId, table.position)]);

export const activityEvents = sqliteTable("fdp_activity_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cardId: text("card_id").references(() => cards.id, { onDelete: "cascade" }),
  actorEmail: text("actor_email").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("fdp_activity_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const hrMetrics = sqliteTable("fdp_hr_metrics", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  period: text("period").notNull(),
  headcount: integer("headcount").notNull().default(0),
  admissions: integer("admissions").notNull().default(0),
  terminations: integer("terminations").notNull().default(0),
  payrollCost: real("payroll_cost").notNull().default(0),
  source: text("source").notNull().default("manual"),
  externalId: text("external_id").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("fdp_hr_metrics_workspace_company_period_uq").on(table.workspaceId, table.companyId, table.period),
  index("fdp_hr_metrics_workspace_period_idx").on(table.workspaceId, table.period),
]);
