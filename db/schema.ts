import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const demands = sqliteTable("demands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull(),
  company: text("company").notNull(),
  employee: text("employee"),
  requester: text("requester").notNull(),
  source: text("source", { enum: ["E-mail", "WhatsApp", "Verbal"] }).notNull(),
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
});

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
});

export const userHistory = sqliteTable("user_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  targetUserId: integer("target_user_id").notNull().references(() => users.id),
  actorUserId: integer("actor_user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  fieldChanged: text("field_changed"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type DemandRecord = typeof demands.$inferSelect;
export type UserRecord = typeof users.$inferSelect;
