import {
  type AnyPgColumn,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const tenantWorkspaceDefault = sql`NULLIF(current_setting('app.workspace_id', true), '')`;

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
  index("fdp_workspaces_owner_idx").on(table.ownerUserId),
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
  taxRegime: text("tax_regime").notNull().default(""),
  stateRegistration: text("state_registration").notNull().default(""),
  municipalRegistration: text("municipal_registration").notNull().default(""),
  postalCode: text("postal_code").notNull().default(""),
  street: text("street").notNull().default(""),
  streetNumber: text("street_number").notNull().default(""),
  addressComplement: text("address_complement").notNull().default(""),
  district: text("district").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  country: text("country").notNull().default("Brasil"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  index("fdp_companies_workspace_name_idx").on(table.workspaceId, table.legalName),
  index("fdp_companies_workspace_tax_idx").on(table.workspaceId, table.taxId),
  index("fdp_companies_workspace_parent_idx").on(table.workspaceId, table.parentCompanyId),
  uniqueIndex("fdp_companies_workspace_id_uq").on(table.workspaceId, table.id),
  foreignKey({
    name: "fdp_companies_workspace_parent_fk",
    columns: [table.workspaceId, table.parentCompanyId],
    foreignColumns: [table.workspaceId, table.id],
  }),
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
  foreignKey({
    name: "fdp_member_company_access_member_fk",
    columns: [table.workspaceId, table.userId],
    foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
  }).onDelete("cascade"),
  foreignKey({
    name: "fdp_member_company_access_company_fk",
    columns: [table.workspaceId, table.companyId],
    foreignColumns: [companies.workspaceId, companies.id],
  }).onDelete("cascade"),
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

export const authSessions = pgTable("fdp_auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  deviceLabel: text("device_label").notNull().default("Dispositivo desconhecido"),
  ipHash: text("ip_hash").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_auth_sessions_token_hash_uq").on(table.tokenHash),
  index("fdp_auth_sessions_user_expiry_idx").on(table.userId, table.expiresAt),
  index("fdp_auth_sessions_active_idx").on(table.expiresAt, table.revokedAt),
]);

export const authRateLimits = pgTable("fdp_auth_rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  failureCount: integer("failure_count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true, mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [index("fdp_auth_rate_limits_blocked_idx").on(table.blockedUntil)]);

export const bootstrapGuard = pgTable("fdp_bootstrap_guard", {
  id: integer("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "restrict" }),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

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
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_boards_workspace_name_uq").on(table.workspaceId, table.name),
  uniqueIndex("fdp_boards_workspace_id_uq").on(table.workspaceId, table.id),
]);

export const lists = pgTable("fdp_lists", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault),
  boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  position: doublePrecision("position").notNull(),
  slaBehavior: text("sla_behavior").notNull().default("running"),
}, (table) => [
  uniqueIndex("fdp_lists_board_kind_uq").on(table.boardId, table.kind),
  uniqueIndex("fdp_lists_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_lists_workspace_board_id_uq").on(table.workspaceId, table.boardId, table.id),
  index("fdp_lists_board_position_idx").on(table.boardId, table.position),
  foreignKey({
    name: "fdp_lists_workspace_board_fk",
    columns: [table.workspaceId, table.boardId],
    foreignColumns: [boards.workspaceId, boards.id],
  }).onDelete("cascade"),
]);

export const cards = pgTable("fdp_cards", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault),
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
  competence: text("competence").notNull().default(""),
  legalDueAt: timestamp("legal_due_at", { withTimezone: true, mode: "string" }),
  processTemplateId: text("process_template_id"),
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
}, (table) => [
  uniqueIndex("fdp_cards_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_cards_board_list_position_idx").on(table.boardId, table.listId, table.position),
  index("fdp_cards_due_status_idx").on(table.dueAt, table.slaStatus),
  foreignKey({
    name: "fdp_cards_workspace_board_list_fk",
    columns: [table.workspaceId, table.boardId, table.listId],
    foreignColumns: [lists.workspaceId, lists.boardId, lists.id],
  }),
  check("fdp_cards_competence_check", sql`${table.competence} = '' OR ${table.competence} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  foreignKey({
    name: "fdp_cards_workspace_company_fk",
    columns: [table.workspaceId, table.companyId],
    foreignColumns: [companies.workspaceId, companies.id],
  }),
]);

export const checklistItems = pgTable("fdp_checklist_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  completed: integer("completed").notNull().default(0),
  position: doublePrecision("position").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (table) => [
  index("fdp_checklist_card_position_idx").on(table.cardId, table.position),
  foreignKey({
    name: "fdp_checklist_items_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }).onDelete("cascade"),
]);

export const cardComments = pgTable("fdp_card_comments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  authorUserId: text("author_user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  index("fdp_comments_card_created_idx").on(table.cardId, table.createdAt),
  foreignKey({
    name: "fdp_card_comments_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }).onDelete("cascade"),
]);

export const labels = pgTable("fdp_labels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#64748b"),
  position: doublePrecision("position").notNull(),
}, (table) => [
  uniqueIndex("fdp_labels_workspace_name_uq").on(table.workspaceId, table.name),
  uniqueIndex("fdp_labels_workspace_id_uq").on(table.workspaceId, table.id),
]);

export const cardLabels = pgTable("fdp_card_labels", {
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  labelId: text("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.cardId, table.labelId] }),
  foreignKey({
    name: "fdp_card_labels_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "fdp_card_labels_workspace_label_fk",
    columns: [table.workspaceId, table.labelId],
    foreignColumns: [labels.workspaceId, labels.id],
  }).onDelete("cascade"),
]);

export const cardAssignees = pgTable("fdp_card_assignees", {
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.cardId, table.userId] }),
  foreignKey({
    name: "fdp_card_assignees_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "fdp_card_assignees_workspace_member_fk",
    columns: [table.workspaceId, table.userId],
    foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
  }).onDelete("cascade"),
]);

export const customFields = pgTable("fdp_custom_fields", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  fieldKey: text("field_key").notNull(),
  fieldType: text("field_type").notNull().default("text"),
  optionsJson: text("options_json").notNull().default("[]"),
  required: integer("required").notNull().default(0),
  position: doublePrecision("position").notNull(),
}, (table) => [
  uniqueIndex("fdp_custom_fields_workspace_key_uq").on(table.workspaceId, table.fieldKey),
  uniqueIndex("fdp_custom_fields_workspace_id_uq").on(table.workspaceId, table.id),
]);

export const customFieldValues = pgTable("fdp_custom_field_values", {
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  fieldId: text("field_id").notNull().references(() => customFields.id, { onDelete: "cascade" }),
  valueText: text("value_text").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.cardId, table.fieldId] }),
  foreignKey({
    name: "fdp_custom_field_values_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "fdp_custom_field_values_workspace_field_fk",
    columns: [table.workspaceId, table.fieldId],
    foreignColumns: [customFields.workspaceId, customFields.id],
  }).onDelete("cascade"),
]);

export const cardAttachments = pgTable("fdp_card_attachments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault),
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
  foreignKey({
    name: "fdp_card_attachments_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }).onDelete("cascade"),
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
}, (table) => [
  uniqueIndex("fdp_templates_workspace_name_uq").on(table.workspaceId, table.name),
  uniqueIndex("fdp_templates_workspace_id_uq").on(table.workspaceId, table.id),
]);

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
  foreignKey({
    name: "fdp_notifications_workspace_member_fk",
    columns: [table.workspaceId, table.userId],
    foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
  }).onDelete("cascade"),
  foreignKey({
    name: "fdp_notifications_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }),
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
}, (table) => [
  index("fdp_planner_user_start_idx").on(table.userId, table.startAt),
  foreignKey({
    name: "fdp_planner_blocks_workspace_member_fk",
    columns: [table.workspaceId, table.userId],
    foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
  }).onDelete("cascade"),
  foreignKey({
    name: "fdp_planner_blocks_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }),
]);

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
}, (table) => [
  uniqueIndex("fdp_calendar_connections_user_provider_uq").on(table.userId, table.provider),
  foreignKey({
    name: "fdp_calendar_connections_workspace_member_fk",
    columns: [table.workspaceId, table.userId],
    foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
  }).onDelete("cascade"),
]);

export const cardSlaPauses = pgTable("fdp_card_sla_pauses", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
}, (table) => [
  index("fdp_card_sla_pause_open_idx").on(table.cardId, table.endedAt),
  foreignKey({
    name: "fdp_card_sla_pauses_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }).onDelete("cascade"),
]);

export const inboxItems = pgTable("fdp_workspace_inbox_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("manual"),
  senderName: text("sender_name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull().default(""),
  status: text("status").notNull().default("new"),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  convertedCardId: text("converted_card_id").references(() => cards.id),
}, (table) => [
  index("fdp_inbox_workspace_status_received_idx").on(table.workspaceId, table.status, table.receivedAt),
  foreignKey({
    name: "fdp_workspace_inbox_items_workspace_card_fk",
    columns: [table.workspaceId, table.convertedCardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }),
]);

export const automationRules = pgTable("fdp_automation_rules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  conditionJson: text("condition_json").notNull().default("{}"),
  actionJson: text("action_json").notNull().default("{}"),
  enabled: integer("enabled").notNull().default(1),
  position: doublePrecision("position").notNull(),
}, (table) => [index("fdp_rules_workspace_position_idx").on(table.workspaceId, table.position)]);

export const activityEvents = pgTable("fdp_activity_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cardId: text("card_id").references(() => cards.id, { onDelete: "cascade" }),
  actorEmail: text("actor_email").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  index("fdp_activity_workspace_created_idx").on(table.workspaceId, table.createdAt),
  foreignKey({
    name: "fdp_activity_events_workspace_card_fk",
    columns: [table.workspaceId, table.cardId],
    foreignColumns: [cards.workspaceId, cards.id],
  }).onDelete("cascade"),
]);

export const auditEvents = pgTable("fdp_audit_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "restrict" }),
  actorType: text("actor_type").notNull().default("user"),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  outcome: text("outcome").notNull().default("success"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  beforeJson: jsonb("before_json").$type<Record<string, unknown>>().notNull().default({}),
  afterJson: jsonb("after_json").$type<Record<string, unknown>>().notNull().default({}),
  metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
  requestId: text("request_id"),
  ipHash: text("ip_hash"),
  userAgentHash: text("user_agent_hash"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  index("fdp_audit_workspace_created_idx").on(table.workspaceId, table.createdAt),
  index("fdp_audit_workspace_entity_idx").on(table.workspaceId, table.entityType, table.entityId),
  index("fdp_audit_workspace_actor_idx").on(table.workspaceId, table.actorUserId, table.createdAt),
  check("fdp_audit_events_actor_type_check", sql`${table.actorType} IN ('user', 'system', 'integration')`),
  check("fdp_audit_events_outcome_check", sql`${table.outcome} IN ('success', 'denied', 'failure')`),
]);

export const departments = pgTable("fdp_departments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  parentDepartmentId: text("parent_department_id"),
  code: text("code").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_departments_workspace_company_code_uq").on(table.workspaceId, table.companyId, table.code),
  uniqueIndex("fdp_departments_workspace_company_id_uq").on(table.workspaceId, table.companyId, table.id),
  foreignKey({ name: "fdp_departments_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_departments_workspace_parent_fk", columns: [table.workspaceId, table.companyId, table.parentDepartmentId], foreignColumns: [table.workspaceId, table.companyId, table.id] }),
  check("fdp_departments_status_check", sql`${table.status} IN ('active', 'inactive')`),
]);

export const positions = pgTable("fdp_positions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  cboCode: text("cbo_code").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_positions_workspace_company_code_uq").on(table.workspaceId, table.companyId, table.code),
  uniqueIndex("fdp_positions_workspace_company_id_uq").on(table.workspaceId, table.companyId, table.id),
  foreignKey({ name: "fdp_positions_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }).onDelete("cascade"),
  check("fdp_positions_status_check", sql`${table.status} IN ('active', 'inactive')`),
]);

export const costCenters = pgTable("fdp_cost_centers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_cost_centers_workspace_company_code_uq").on(table.workspaceId, table.companyId, table.code),
  uniqueIndex("fdp_cost_centers_workspace_company_id_uq").on(table.workspaceId, table.companyId, table.id),
  foreignKey({ name: "fdp_cost_centers_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }).onDelete("cascade"),
  check("fdp_cost_centers_status_check", sql`${table.status} IN ('active', 'inactive')`),
]);

export const workSchedules = pgTable("fdp_work_schedules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  weeklyHours: integer("weekly_hours").notNull().default(44),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_work_schedules_workspace_company_code_uq").on(table.workspaceId, table.companyId, table.code),
  uniqueIndex("fdp_work_schedules_workspace_company_id_uq").on(table.workspaceId, table.companyId, table.id),
  foreignKey({ name: "fdp_work_schedules_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }).onDelete("cascade"),
  check("fdp_work_schedules_weekly_hours_check", sql`${table.weeklyHours} BETWEEN 1 AND 60`),
  check("fdp_work_schedules_status_check", sql`${table.status} IN ('active', 'inactive')`),
]);

export const employees = pgTable("fdp_employees", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  departmentId: text("department_id"),
  positionId: text("position_id"),
  costCenterId: text("cost_center_id"),
  workScheduleId: text("work_schedule_id"),
  managerEmployeeId: text("manager_employee_id"),
  registrationNumber: text("registration_number").notNull(),
  fullName: text("full_name").notNull(),
  socialName: text("social_name").notNull().default(""),
  cpfHash: text("cpf_hash").notNull().default(""),
  cpfLast4: text("cpf_last4").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  birthDate: date("birth_date", { mode: "string" }),
  admissionDate: date("admission_date", { mode: "string" }).notNull(),
  terminationDate: date("termination_date", { mode: "string" }),
  employmentStatus: text("employment_status").notNull().default("active"),
  employmentType: text("employment_type").notNull().default("clt"),
  workModel: text("work_model").notNull().default("onsite"),
  sourceSystem: text("source_system").notNull().default("manual"),
  externalId: text("external_id").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_employees_workspace_company_registration_uq").on(table.workspaceId, table.companyId, table.registrationNumber),
  uniqueIndex("fdp_employees_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_employees_workspace_company_id_uq").on(table.workspaceId, table.companyId, table.id),
  uniqueIndex("fdp_employees_workspace_cpf_hash_uq").on(table.workspaceId, table.cpfHash).where(sql`${table.cpfHash} <> ''`),
  index("fdp_employees_workspace_status_name_idx").on(table.workspaceId, table.employmentStatus, table.fullName),
  foreignKey({ name: "fdp_employees_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }),
  foreignKey({ name: "fdp_employees_workspace_department_fk", columns: [table.workspaceId, table.companyId, table.departmentId], foreignColumns: [departments.workspaceId, departments.companyId, departments.id] }),
  foreignKey({ name: "fdp_employees_workspace_position_fk", columns: [table.workspaceId, table.companyId, table.positionId], foreignColumns: [positions.workspaceId, positions.companyId, positions.id] }),
  foreignKey({ name: "fdp_employees_workspace_cost_center_fk", columns: [table.workspaceId, table.companyId, table.costCenterId], foreignColumns: [costCenters.workspaceId, costCenters.companyId, costCenters.id] }),
  foreignKey({ name: "fdp_employees_workspace_work_schedule_fk", columns: [table.workspaceId, table.companyId, table.workScheduleId], foreignColumns: [workSchedules.workspaceId, workSchedules.companyId, workSchedules.id] }),
  foreignKey({ name: "fdp_employees_workspace_manager_fk", columns: [table.workspaceId, table.managerEmployeeId], foreignColumns: [table.workspaceId, table.id] }),
  check("fdp_employees_status_check", sql`${table.employmentStatus} IN ('active', 'on_leave', 'terminated')`),
  check("fdp_employees_type_check", sql`${table.employmentType} IN ('clt', 'intern', 'apprentice', 'temporary')`),
  check("fdp_employees_work_model_check", sql`${table.workModel} IN ('onsite', 'hybrid', 'remote')`),
  check("fdp_employees_source_check", sql`${table.sourceSystem} IN ('manual', 'solides')`),
]);

export const payrollCycles = pgTable("fdp_payroll_cycles", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  competence: text("competence").notNull(),
  status: text("status").notNull().default("open"),
  preClosingDueDate: date("pre_closing_due_date", { mode: "string" }),
  paymentDate: date("payment_date", { mode: "string" }),
  postClosingDueDate: date("post_closing_due_date", { mode: "string" }),
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
  notes: text("notes").notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_payroll_cycles_workspace_company_competence_uq").on(table.workspaceId, table.companyId, table.competence),
  uniqueIndex("fdp_payroll_cycles_workspace_company_id_uq").on(table.workspaceId, table.companyId, table.id),
  uniqueIndex("fdp_payroll_cycles_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_payroll_cycles_workspace_status_idx").on(table.workspaceId, table.status, table.competence),
  foreignKey({ name: "fdp_payroll_cycles_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }),
  check("fdp_payroll_cycles_competence_check", sql`${table.competence} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check("fdp_payroll_cycles_status_check", sql`${table.status} IN ('open', 'pre_closing', 'processing', 'post_closing', 'closed')`),
]);

export const employeeMovements = pgTable("fdp_employee_movements", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  employeeId: text("employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  payrollCycleId: text("payroll_cycle_id"),
  cardId: text("card_id"),
  movementType: text("movement_type").notNull(),
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),
  title: text("title").notNull(),
  detailsJson: jsonb("details_json").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("draft"),
  requestedBy: text("requested_by").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  decisionComment: text("decision_comment").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_employee_movements_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_employee_movements_workspace_status_effective_idx").on(table.workspaceId, table.status, table.effectiveDate),
  index("fdp_employee_movements_workspace_employee_idx").on(table.workspaceId, table.employeeId, table.effectiveDate),
  foreignKey({ name: "fdp_employee_movements_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }),
  foreignKey({ name: "fdp_employee_movements_workspace_employee_fk", columns: [table.workspaceId, table.companyId, table.employeeId], foreignColumns: [employees.workspaceId, employees.companyId, employees.id] }),
  foreignKey({ name: "fdp_employee_movements_workspace_cycle_fk", columns: [table.workspaceId, table.companyId, table.payrollCycleId], foreignColumns: [payrollCycles.workspaceId, payrollCycles.companyId, payrollCycles.id] }),
  foreignKey({ name: "fdp_employee_movements_workspace_card_fk", columns: [table.workspaceId, table.cardId], foreignColumns: [cards.workspaceId, cards.id] }),
  foreignKey({ name: "fdp_employee_movements_workspace_requester_fk", columns: [table.workspaceId, table.requestedBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  foreignKey({ name: "fdp_employee_movements_workspace_decider_fk", columns: [table.workspaceId, table.decidedBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_employee_movements_type_check", sql`${table.movementType} IN ('salary_change', 'vacation', 'leave', 'termination', 'transfer', 'benefit_change', 'registration_sync', 'other')`),
  check("fdp_employee_movements_status_check", sql`${table.status} IN ('draft', 'pending_approval', 'approved', 'rejected', 'applied', 'canceled')`),
]);

export const movementApprovalSteps = pgTable("fdp_movement_approval_steps", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  movementId: text("movement_id").notNull().references(() => employeeMovements.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull().default(1),
  approverUserId: text("approver_user_id").notNull(),
  status: text("status").notNull().default("pending"),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  comment: text("comment").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_movement_approval_steps_movement_sequence_uq").on(table.movementId, table.sequence),
  index("fdp_movement_approval_steps_workspace_approver_idx").on(table.workspaceId, table.approverUserId, table.status),
  foreignKey({ name: "fdp_movement_approval_steps_workspace_movement_fk", columns: [table.workspaceId, table.movementId], foreignColumns: [employeeMovements.workspaceId, employeeMovements.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_movement_approval_steps_workspace_approver_fk", columns: [table.workspaceId, table.approverUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_movement_approval_steps_status_check", sql`${table.status} IN ('pending', 'approved', 'rejected', 'skipped')`),
  check("fdp_movement_approval_steps_sequence_check", sql`${table.sequence} > 0`),
]);

export const payrollCycleItems = pgTable("fdp_payroll_cycle_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  payrollCycleId: text("payroll_cycle_id").notNull().references(() => payrollCycles.id, { onDelete: "cascade" }),
  phase: text("phase").notNull(),
  category: text("category").notNull().default("general"),
  title: text("title").notNull(),
  status: text("status").notNull().default("pending"),
  ownerUserId: text("owner_user_id"),
  dueDate: date("due_date", { mode: "string" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  notes: text("notes").notNull().default(""),
  position: doublePrecision("position").notNull().default(1000),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_payroll_cycle_items_cycle_phase_title_uq").on(table.payrollCycleId, table.phase, table.title),
  uniqueIndex("fdp_payroll_cycle_items_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_payroll_cycle_items_workspace_status_idx").on(table.workspaceId, table.status, table.dueDate),
  foreignKey({ name: "fdp_payroll_cycle_items_workspace_cycle_fk", columns: [table.workspaceId, table.companyId, table.payrollCycleId], foreignColumns: [payrollCycles.workspaceId, payrollCycles.companyId, payrollCycles.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_payroll_cycle_items_workspace_owner_fk", columns: [table.workspaceId, table.ownerUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_payroll_cycle_items_phase_check", sql`${table.phase} IN ('pre_closing', 'post_closing')`),
  check("fdp_payroll_cycle_items_status_check", sql`${table.status} IN ('pending', 'in_progress', 'blocked', 'completed')`),
]);

export const complianceObligations = pgTable("fdp_compliance_obligations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  payrollCycleId: text("payroll_cycle_id"),
  cardId: text("card_id"),
  obligationType: text("obligation_type").notNull().default("other"),
  title: text("title").notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("open"),
  ownerUserId: text("owner_user_id"),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  recurrenceKey: text("recurrence_key").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_compliance_obligations_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_compliance_obligations_workspace_recurrence_uq").on(table.workspaceId, table.recurrenceKey).where(sql`${table.recurrenceKey} <> ''`),
  index("fdp_compliance_obligations_workspace_due_status_idx").on(table.workspaceId, table.dueDate, table.status),
  foreignKey({ name: "fdp_compliance_obligations_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }),
  foreignKey({ name: "fdp_compliance_obligations_workspace_cycle_fk", columns: [table.workspaceId, table.companyId, table.payrollCycleId], foreignColumns: [payrollCycles.workspaceId, payrollCycles.companyId, payrollCycles.id] }),
  foreignKey({ name: "fdp_compliance_obligations_workspace_card_fk", columns: [table.workspaceId, table.cardId], foreignColumns: [cards.workspaceId, cards.id] }),
  foreignKey({ name: "fdp_compliance_obligations_workspace_owner_fk", columns: [table.workspaceId, table.ownerUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_compliance_obligations_type_check", sql`${table.obligationType} IN ('payroll', 'social_security', 'tax', 'reporting', 'union', 'other')`),
  check("fdp_compliance_obligations_status_check", sql`${table.status} IN ('open', 'in_progress', 'blocked', 'completed')`),
]);

export const processDefinitions = pgTable("fdp_process_definitions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull().default("general"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_process_definitions_workspace_code_uq").on(table.workspaceId, table.code),
  uniqueIndex("fdp_process_definitions_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_process_definitions_workspace_status_idx").on(table.workspaceId, table.status, table.name),
  check("fdp_process_definitions_status_check", sql`${table.status} IN ('active', 'inactive')`),
]);

export const processVersions = pgTable("fdp_process_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  definitionId: text("definition_id").notNull().references(() => processDefinitions.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").notNull().default("draft"),
  configurationJson: jsonb("configuration_json").$type<Record<string, unknown>>().notNull().default({}),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
  publishedBy: text("published_by"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_process_versions_definition_version_uq").on(table.definitionId, table.version),
  uniqueIndex("fdp_process_versions_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_process_versions_workspace_status_idx").on(table.workspaceId, table.status, table.createdAt),
  foreignKey({ name: "fdp_process_versions_workspace_definition_fk", columns: [table.workspaceId, table.definitionId], foreignColumns: [processDefinitions.workspaceId, processDefinitions.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_process_versions_workspace_publisher_fk", columns: [table.workspaceId, table.publishedBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  foreignKey({ name: "fdp_process_versions_workspace_creator_fk", columns: [table.workspaceId, table.createdBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_process_versions_version_check", sql`${table.version} > 0`),
  check("fdp_process_versions_status_check", sql`${table.status} IN ('draft', 'published', 'retired')`),
]);

export const operationalPendingItems = pgTable("fdp_operational_pending_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  payrollCycleId: text("payroll_cycle_id"),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  severity: text("severity").notNull().default("warning"),
  blocking: integer("blocking").notNull().default(0),
  title: text("title").notNull(),
  dueDate: date("due_date", { mode: "string" }),
  status: text("status").notNull().default("open"),
  ownerUserId: text("owner_user_id"),
  resolution: text("resolution").notNull().default(""),
  idempotencyKey: text("idempotency_key").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_operational_pending_items_workspace_key_uq").on(table.workspaceId, table.idempotencyKey),
  uniqueIndex("fdp_operational_pending_items_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_operational_pending_items_workspace_status_due_idx").on(table.workspaceId, table.status, table.dueDate),
  foreignKey({ name: "fdp_operational_pending_items_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }),
  foreignKey({ name: "fdp_operational_pending_items_workspace_cycle_fk", columns: [table.workspaceId, table.companyId, table.payrollCycleId], foreignColumns: [payrollCycles.workspaceId, payrollCycles.companyId, payrollCycles.id] }),
  foreignKey({ name: "fdp_operational_pending_items_workspace_owner_fk", columns: [table.workspaceId, table.ownerUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_operational_pending_items_source_check", sql`${table.sourceType} IN ('movement', 'approval', 'obligation', 'cycle', 'card')`),
  check("fdp_operational_pending_items_severity_check", sql`${table.severity} IN ('info', 'warning', 'critical')`),
  check("fdp_operational_pending_items_status_check", sql`${table.status} IN ('open', 'in_progress', 'resolved', 'waived')`),
  check("fdp_operational_pending_items_blocking_check", sql`${table.blocking} IN (0, 1)`),
]);

export const auxiliaryProviders = pgTable("fdp_auxiliary_providers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  providerType: text("provider_type").notNull(),
  code: text("code").notNull(),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name").notNull().default(""),
  taxId: text("tax_id").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_auxiliary_providers_workspace_code_uq").on(table.workspaceId, table.code),
  uniqueIndex("fdp_auxiliary_providers_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_auxiliary_providers_workspace_type_status_idx").on(table.workspaceId, table.providerType, table.status, table.legalName),
  check("fdp_auxiliary_providers_type_check", sql`${table.providerType} IN ('benefit_operator', 'psychologist', 'contractor')`),
  check("fdp_auxiliary_providers_status_check", sql`${table.status} IN ('active', 'inactive')`),
]);

export const auxiliaryExecutions = pgTable("fdp_auxiliary_executions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  payrollCycleId: text("payroll_cycle_id").notNull().references(() => payrollCycles.id, { onDelete: "restrict" }),
  providerId: text("provider_id"),
  moduleType: text("module_type").notNull(),
  referenceCode: text("reference_code").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  currentRevision: integer("current_revision").notNull().default(1),
  totalAmount: numeric("total_amount", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  dueDate: date("due_date", { mode: "string" }),
  ownerUserId: text("owner_user_id"),
  closedBy: text("closed_by"),
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_auxiliary_executions_workspace_reference_uq").on(table.workspaceId, table.referenceCode),
  uniqueIndex("fdp_auxiliary_executions_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_auxiliary_executions_workspace_cycle_module_idx").on(table.workspaceId, table.payrollCycleId, table.moduleType, table.status),
  index("fdp_auxiliary_executions_workspace_due_idx").on(table.workspaceId, table.status, table.dueDate),
  foreignKey({ name: "fdp_auxiliary_executions_workspace_company_fk", columns: [table.workspaceId, table.companyId], foreignColumns: [companies.workspaceId, companies.id] }),
  foreignKey({ name: "fdp_auxiliary_executions_workspace_cycle_fk", columns: [table.workspaceId, table.companyId, table.payrollCycleId], foreignColumns: [payrollCycles.workspaceId, payrollCycles.companyId, payrollCycles.id] }),
  foreignKey({ name: "fdp_auxiliary_executions_workspace_provider_fk", columns: [table.workspaceId, table.providerId], foreignColumns: [auxiliaryProviders.workspaceId, auxiliaryProviders.id] }),
  foreignKey({ name: "fdp_auxiliary_executions_workspace_owner_fk", columns: [table.workspaceId, table.ownerUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  foreignKey({ name: "fdp_auxiliary_executions_workspace_closer_fk", columns: [table.workspaceId, table.closedBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  foreignKey({ name: "fdp_auxiliary_executions_workspace_creator_fk", columns: [table.workspaceId, table.createdBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_auxiliary_executions_module_check", sql`${table.moduleType} IN ('benefits', 'psychology', 'contractors')`),
  check("fdp_auxiliary_executions_status_check", sql`${table.status} IN ('draft', 'pending_approval', 'approved', 'rejected', 'closed', 'canceled')`),
  check("fdp_auxiliary_executions_revision_check", sql`${table.currentRevision} > 0`),
  check("fdp_auxiliary_executions_amount_check", sql`${table.totalAmount} >= 0`),
]);

export const auxiliaryExecutionRevisions = pgTable("fdp_auxiliary_execution_revisions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  executionId: text("execution_id").notNull().references(() => auxiliaryExecutions.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  inputJson: jsonb("input_json").$type<Record<string, unknown>>().notNull().default({}),
  outputJson: jsonb("output_json").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_auxiliary_revisions_execution_revision_uq").on(table.executionId, table.revision),
  uniqueIndex("fdp_auxiliary_revisions_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_auxiliary_revisions_workspace_execution_id_uq").on(table.workspaceId, table.executionId, table.id),
  index("fdp_auxiliary_revisions_workspace_execution_idx").on(table.workspaceId, table.executionId, table.revision),
  foreignKey({ name: "fdp_auxiliary_revisions_workspace_execution_fk", columns: [table.workspaceId, table.executionId], foreignColumns: [auxiliaryExecutions.workspaceId, auxiliaryExecutions.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_auxiliary_revisions_workspace_creator_fk", columns: [table.workspaceId, table.createdBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_auxiliary_revisions_revision_check", sql`${table.revision} > 0`),
  check("fdp_auxiliary_revisions_status_check", sql`${table.status} IN ('draft', 'submitted', 'approved', 'rejected', 'superseded')`),
]);

export const auxiliaryApprovalSteps = pgTable("fdp_auxiliary_approval_steps", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  executionId: text("execution_id").notNull().references(() => auxiliaryExecutions.id, { onDelete: "cascade" }),
  revisionId: text("revision_id").notNull().references(() => auxiliaryExecutionRevisions.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull().default(1),
  approverUserId: text("approver_user_id").notNull(),
  status: text("status").notNull().default("pending"),
  comment: text("comment").notNull().default(""),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_auxiliary_approval_revision_sequence_uq").on(table.revisionId, table.sequence),
  uniqueIndex("fdp_auxiliary_approval_workspace_id_uq").on(table.workspaceId, table.id),
  index("fdp_auxiliary_approval_workspace_approver_idx").on(table.workspaceId, table.approverUserId, table.status),
  foreignKey({ name: "fdp_auxiliary_approval_workspace_execution_fk", columns: [table.workspaceId, table.executionId], foreignColumns: [auxiliaryExecutions.workspaceId, auxiliaryExecutions.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_auxiliary_approval_workspace_revision_fk", columns: [table.workspaceId, table.revisionId], foreignColumns: [auxiliaryExecutionRevisions.workspaceId, auxiliaryExecutionRevisions.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_auxiliary_approval_execution_revision_fk", columns: [table.workspaceId, table.executionId, table.revisionId], foreignColumns: [auxiliaryExecutionRevisions.workspaceId, auxiliaryExecutionRevisions.executionId, auxiliaryExecutionRevisions.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_auxiliary_approval_workspace_approver_fk", columns: [table.workspaceId, table.approverUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_auxiliary_approval_sequence_check", sql`${table.sequence} > 0`),
  check("fdp_auxiliary_approval_status_check", sql`${table.status} IN ('pending', 'approved', 'rejected', 'skipped')`),
]);

export const integrationCredentials = pgTable("fdp_integration_credentials", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
  credentialType: text("credential_type").notNull().default("provider_auth"),
  encryptedValue: text("encrypted_value").notNull(),
  initializationVector: text("initialization_vector").notNull(),
  authTag: text("auth_tag").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  fingerprint: text("fingerprint").notNull(),
  status: text("status").notNull().default("active"),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
  rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "string" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_integration_credentials_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_integration_credentials_active_uq").on(table.workspaceId, table.integrationId, table.credentialType).where(sql`${table.status} = 'active'`),
  index("fdp_integration_credentials_workspace_integration_idx").on(table.workspaceId, table.integrationId, table.status),
  foreignKey({ name: "fdp_integration_credentials_workspace_integration_fk", columns: [table.workspaceId, table.integrationId], foreignColumns: [integrations.workspaceId, integrations.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_integration_credentials_workspace_creator_fk", columns: [table.workspaceId, table.createdBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_integration_credentials_type_check", sql`${table.credentialType} IN ('provider_auth', 'webhook_signing')`),
  check("fdp_integration_credentials_status_check", sql`${table.status} IN ('active', 'revoked')`),
  check("fdp_integration_credentials_key_version_check", sql`${table.keyVersion} > 0`),
]);

export const integrationMappings = pgTable("fdp_integration_mappings", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
  resourceType: text("resource_type").notNull(),
  direction: text("direction").notNull().default("inbound"),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"),
  mappingJson: jsonb("mapping_json").$type<Record<string, unknown>>().notNull().default({}),
  checksum: text("checksum").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
  publishedBy: text("published_by"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_integration_mappings_integration_resource_version_uq").on(table.integrationId, table.resourceType, table.direction, table.version),
  uniqueIndex("fdp_integration_mappings_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_integration_mappings_workspace_integration_id_uq").on(table.workspaceId, table.integrationId, table.id),
  index("fdp_integration_mappings_workspace_status_idx").on(table.workspaceId, table.integrationId, table.status),
  foreignKey({ name: "fdp_integration_mappings_workspace_integration_fk", columns: [table.workspaceId, table.integrationId], foreignColumns: [integrations.workspaceId, integrations.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_integration_mappings_workspace_creator_fk", columns: [table.workspaceId, table.createdBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  foreignKey({ name: "fdp_integration_mappings_workspace_publisher_fk", columns: [table.workspaceId, table.publishedBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_integration_mappings_resource_check", sql`${table.resourceType} IN ('inbox', 'employees', 'hr_metrics', 'files')`),
  check("fdp_integration_mappings_direction_check", sql`${table.direction} IN ('inbound', 'outbound', 'bidirectional')`),
  check("fdp_integration_mappings_status_check", sql`${table.status} IN ('draft', 'active', 'archived')`),
  check("fdp_integration_mappings_version_check", sql`${table.version} > 0`),
]);

export const integrationSyncRuns = pgTable("fdp_integration_sync_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
  mappingId: text("mapping_id"),
  triggerType: text("trigger_type").notNull().default("manual"),
  status: text("status").notNull().default("queued"),
  idempotencyKey: text("idempotency_key").notNull(),
  cursor: text("cursor").notNull().default(""),
  attempt: integer("attempt").notNull().default(0),
  receivedCount: integer("received_count").notNull().default(0),
  processedCount: integer("processed_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  conflictCount: integer("conflict_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  errorCode: text("error_code").notNull().default(""),
  errorMessage: text("error_message").notNull().default(""),
  requestedBy: text("requested_by"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_integration_sync_runs_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_integration_sync_runs_idempotency_uq").on(table.workspaceId, table.integrationId, table.idempotencyKey),
  uniqueIndex("fdp_integration_sync_runs_workspace_integration_id_uq").on(table.workspaceId, table.integrationId, table.id),
  index("fdp_integration_sync_runs_workspace_status_idx").on(table.workspaceId, table.status, table.createdAt),
  foreignKey({ name: "fdp_integration_sync_runs_workspace_integration_fk", columns: [table.workspaceId, table.integrationId], foreignColumns: [integrations.workspaceId, integrations.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_integration_sync_runs_workspace_mapping_fk", columns: [table.workspaceId, table.integrationId, table.mappingId], foreignColumns: [integrationMappings.workspaceId, integrationMappings.integrationId, integrationMappings.id] }),
  foreignKey({ name: "fdp_integration_sync_runs_workspace_requester_fk", columns: [table.workspaceId, table.requestedBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_integration_sync_runs_trigger_check", sql`${table.triggerType} IN ('manual', 'scheduled', 'webhook', 'retry')`),
  check("fdp_integration_sync_runs_status_check", sql`${table.status} IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'canceled')`),
  check("fdp_integration_sync_runs_counts_check", sql`${table.attempt} >= 0 AND ${table.receivedCount} >= 0 AND ${table.processedCount} >= 0 AND ${table.skippedCount} >= 0 AND ${table.conflictCount} >= 0 AND ${table.failedCount} >= 0`),
]);

export const integrationSyncItems = pgTable("fdp_integration_sync_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => integrationSyncRuns.id, { onDelete: "cascade" }),
  mappingId: text("mapping_id"),
  itemKey: text("item_key").notNull(),
  externalId: text("external_id").notNull().default(""),
  direction: text("direction").notNull().default("inbound"),
  status: text("status").notNull().default("pending"),
  payloadHash: text("payload_hash").notNull(),
  targetType: text("target_type").notNull().default(""),
  targetId: text("target_id").notNull().default(""),
  metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
  errorCode: text("error_code").notNull().default(""),
  errorMessage: text("error_message").notNull().default(""),
  processedAt: timestamp("processed_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_integration_sync_items_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_integration_sync_items_run_key_uq").on(table.runId, table.itemKey),
  uniqueIndex("fdp_integration_sync_items_payload_uq").on(table.workspaceId, table.integrationId, table.mappingId, table.externalId, table.payloadHash),
  index("fdp_integration_sync_items_workspace_run_status_idx").on(table.workspaceId, table.runId, table.status),
  foreignKey({ name: "fdp_integration_sync_items_workspace_run_fk", columns: [table.workspaceId, table.integrationId, table.runId], foreignColumns: [integrationSyncRuns.workspaceId, integrationSyncRuns.integrationId, integrationSyncRuns.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_integration_sync_items_workspace_mapping_fk", columns: [table.workspaceId, table.integrationId, table.mappingId], foreignColumns: [integrationMappings.workspaceId, integrationMappings.integrationId, integrationMappings.id] }),
  check("fdp_integration_sync_items_direction_check", sql`${table.direction} IN ('inbound', 'outbound')`),
  check("fdp_integration_sync_items_status_check", sql`${table.status} IN ('pending', 'processed', 'skipped', 'conflict', 'failed')`),
]);

export const integrationJobs = pgTable("fdp_integration_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => integrationSyncRuns.id, { onDelete: "cascade" }),
  jobType: text("job_type").notNull().default("sync"),
  status: text("status").notNull().default("queued"),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  availableAt: timestamp("available_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  leaseToken: text("lease_token").notNull().default(""),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
  lastErrorCode: text("last_error_code").notNull().default(""),
  lastErrorMessage: text("last_error_message").notNull().default(""),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_integration_jobs_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_integration_jobs_idempotency_uq").on(table.workspaceId, table.integrationId, table.idempotencyKey),
  index("fdp_integration_jobs_claim_idx").on(table.workspaceId, table.status, table.availableAt, table.leaseExpiresAt),
  foreignKey({ name: "fdp_integration_jobs_workspace_run_fk", columns: [table.workspaceId, table.integrationId, table.runId], foreignColumns: [integrationSyncRuns.workspaceId, integrationSyncRuns.integrationId, integrationSyncRuns.id] }).onDelete("cascade"),
  check("fdp_integration_jobs_type_check", sql`${table.jobType} IN ('sync', 'retry', 'reconcile')`),
  check("fdp_integration_jobs_status_check", sql`${table.status} IN ('queued', 'leased', 'succeeded', 'failed', 'dead_letter', 'canceled')`),
  check("fdp_integration_jobs_attempt_check", sql`${table.attempt} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 12 AND ${table.attempt} <= ${table.maxAttempts}`),
]);

export const integrationReconciliations = pgTable("fdp_integration_reconciliations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(tenantWorkspaceDefault).references(() => workspaces.id, { onDelete: "cascade" }),
  integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => integrationSyncRuns.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull().references(() => integrationSyncItems.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  externalId: text("external_id").notNull().default(""),
  internalId: text("internal_id").notNull().default(""),
  status: text("status").notNull().default("unmatched"),
  differencesJson: jsonb("differences_json").$type<Record<string, unknown>>().notNull().default({}),
  resolution: text("resolution").notNull().default(""),
  resolutionNote: text("resolution_note").notNull().default(""),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("fdp_integration_reconciliations_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("fdp_integration_reconciliations_item_uq").on(table.itemId),
  index("fdp_integration_reconciliations_workspace_status_idx").on(table.workspaceId, table.integrationId, table.status, table.createdAt),
  foreignKey({ name: "fdp_integration_reconciliations_workspace_run_fk", columns: [table.workspaceId, table.integrationId, table.runId], foreignColumns: [integrationSyncRuns.workspaceId, integrationSyncRuns.integrationId, integrationSyncRuns.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_integration_reconciliations_workspace_item_fk", columns: [table.workspaceId, table.itemId], foreignColumns: [integrationSyncItems.workspaceId, integrationSyncItems.id] }).onDelete("cascade"),
  foreignKey({ name: "fdp_integration_reconciliations_workspace_resolver_fk", columns: [table.workspaceId, table.resolvedBy], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId] }),
  check("fdp_integration_reconciliations_entity_check", sql`${table.entityType} IN ('inbox', 'employee', 'hr_metric', 'file')`),
  check("fdp_integration_reconciliations_status_check", sql`${table.status} IN ('matched', 'unmatched', 'conflict', 'ignored', 'resolved')`),
  check("fdp_integration_reconciliations_resolution_check", sql`${table.resolution} IN ('', 'link', 'accept_external', 'keep_internal', 'ignore')`),
]);

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
  foreignKey({
    name: "fdp_hr_metrics_workspace_company_fk",
    columns: [table.workspaceId, table.companyId],
    foreignColumns: [companies.workspaceId, companies.id],
  }).onDelete("cascade"),
]);
