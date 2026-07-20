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

export const workspaceMembers = sqliteTable("fdp_workspace_members", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("admin"),
  joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })]);

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
