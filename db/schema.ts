import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["admin", "analyst"] }).notNull().default("analyst"),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdById: integer("created_by_id"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastAccessAt: text("last_access_at"),
}, (table) => [uniqueIndex("users_email_idx").on(table.email)]);

export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name").notNull(),
  cnpj: text("cnpj"),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("companies_cnpj_idx").on(table.cnpj),
  uniqueIndex("companies_trade_name_idx").on(table.tradeName),
]);

export const labels = sqliteTable("labels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  color: text("color").notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("labels_name_idx").on(table.name)]);

export const checklistTemplates = sqliteTable("checklist_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  itemText: text("item_text").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("checklist_templates_item_idx").on(table.category, table.itemText)]);

export const demands = sqliteTable("demands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull(),
  company: text("company").notNull(),
  companyId: integer("company_id").references(() => companies.id),
  employee: text("employee"),
  requester: text("requester").notNull(),
  source: text("source", { enum: ["E-mail", "Teams", "WhatsApp", "Verbal"] }).notNull(),
  priority: text("priority", { enum: ["low", "medium", "high", "urgent"] }).notNull().default("medium"),
  dueDate: text("due_date").notNull(),
  status: text("status", { enum: ["available", "in_progress", "waiting", "done"] }).notNull().default("available"),
  assigneeEmail: text("assignee_email"),
  assignee: text("assignee_name"),
  createdByEmail: text("created_by_email").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  version: integer("version").notNull().default(1),
  updatedById: integer("updated_by_id"),
  deletedAt: text("deleted_at"),
  deletedById: integer("deleted_by_id").references(() => users.id),
  deletionReason: text("deletion_reason"),
}, (table) => [
  index("demands_queue_idx").on(table.deletedAt, table.status, table.createdAt),
  index("demands_assignee_idx").on(table.assigneeEmail, table.status, table.deletedAt),
  index("demands_due_date_idx").on(table.dueDate, table.status, table.deletedAt),
  index("demands_company_idx").on(table.companyId, table.deletedAt),
]);

export const demandLabels = sqliteTable("demand_labels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  demandId: integer("demand_id").notNull().references(() => demands.id, { onDelete: "cascade" }),
  labelId: integer("label_id").notNull().references(() => labels.id),
  assignedById: integer("assigned_by_id").references(() => users.id),
  assignedAt: text("assigned_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("demand_labels_pair_idx").on(table.demandId, table.labelId)]);

export const demandChecklists = sqliteTable("demand_checklists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  demandId: integer("demand_id").notNull().references(() => demands.id, { onDelete: "cascade" }),
  itemText: text("item_text").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  completedById: integer("completed_by_id").references(() => users.id),
  completedAt: text("completed_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("demand_checklists_demand_order_idx").on(table.demandId, table.sortOrder)]);

export const demandComments = sqliteTable("demand_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  demandId: integer("demand_id").notNull().references(() => demands.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("demand_comments_demand_created_idx").on(table.demandId, table.createdAt)]);

export const inboxItems = sqliteTable("inbox_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channel: text("channel", { enum: ["email", "teams", "whatsapp", "manual"] }).notNull(),
  sender: text("sender").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull().default(""),
  externalId: text("external_id"),
  companyId: integer("company_id").references(() => companies.id),
  status: text("status", { enum: ["new", "reviewing", "converted", "archived"] }).notNull().default("new"),
  priorityHint: text("priority_hint", { enum: ["low", "medium", "high", "urgent"] }).notNull().default("medium"),
  reviewerId: integer("reviewer_id").references(() => users.id),
  demandId: integer("demand_id").references(() => demands.id),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inbox_external_id_idx").on(table.externalId),
  index("inbox_status_received_idx").on(table.status, table.receivedAt),
]);

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  demandId: integer("demand_id").references(() => demands.id, { onDelete: "cascade" }),
  inboxItemId: integer("inbox_item_id").references(() => inboxItems.id, { onDelete: "cascade" }),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("notifications_user_read_created_idx").on(table.userId, table.read, table.createdAt)]);

export const slaRules = sqliteTable("sla_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  businessDays: integer("business_days").notNull().default(3),
  defaultPriority: text("default_priority", { enum: ["low", "medium", "high", "urgent"] }).notNull().default("medium"),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("sla_rules_category_idx").on(table.category)]);

export const integrationChannels = sqliteTable("integration_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channel: text("channel", { enum: ["email", "teams", "whatsapp"] }).notNull(),
  provider: text("provider").notNull(),
  status: text("status", { enum: ["setup_required", "pending_credentials", "connected", "paused"] }).notNull().default("setup_required"),
  inboundEnabled: integer("inbound_enabled", { mode: "boolean" }).notNull().default(true),
  outboundEnabled: integer("outbound_enabled", { mode: "boolean" }).notNull().default(false),
  lastSyncAt: text("last_sync_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("integration_channels_channel_idx").on(table.channel)]);

export const integrationCredentials = sqliteTable("integration_credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channel: text("channel", { enum: ["whatsapp"] }).notNull(),
  encryptedConfig: text("encrypted_config").notNull(),
  iv: text("iv").notNull(),
  updatedById: integer("updated_by_id").notNull().references(() => users.id),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("integration_credentials_channel_idx").on(table.channel)]);

export const demandAttachments = sqliteTable("demand_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  demandId: integer("demand_id").notNull().references(() => demands.id, { onDelete: "cascade" }),
  uploaderId: integer("uploader_id").notNull().references(() => users.id),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  objectKey: text("object_key").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("demand_attachments_object_key_idx").on(table.objectKey),
  index("demand_attachments_demand_created_idx").on(table.demandId, table.createdAt),
]);

export const demandHistory = sqliteTable("demand_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  demandId: integer("demand_id").notNull().references(() => demands.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  details: text("details").notNull().default(""),
  userEmail: text("user_email").notNull(),
  userName: text("user_name").notNull(),
  userId: integer("user_id"),
  fieldChanged: text("field_changed"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  justification: text("justification"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("demand_history_demand_created_idx").on(table.demandId, table.createdAt)]);

export const userHistory = sqliteTable("user_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  targetUserId: integer("target_user_id").notNull().references(() => users.id),
  actorUserId: integer("actor_user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  fieldChanged: text("field_changed"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("user_history_target_created_idx").on(table.targetUserId, table.createdAt)]);

export type DemandRecord = typeof demands.$inferSelect;
export type UserRecord = typeof users.$inferSelect;
