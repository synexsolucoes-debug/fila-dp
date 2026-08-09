ALTER TABLE "fdp_companies" ADD COLUMN "tax_regime" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "state_registration" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "municipal_registration" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "postal_code" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "street" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "street_number" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "address_complement" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "district" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "city" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "state" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN "country" text DEFAULT 'Brasil' NOT NULL;
--> statement-breakpoint
CREATE TABLE "fdp_departments" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
  "company_id" text NOT NULL,
  "parent_department_id" text,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_departments_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_departments_workspace_company_fk" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_departments_status_check" CHECK ("status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_departments_workspace_company_code_uq" ON "fdp_departments" ("workspace_id", "company_id", "code");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_departments_workspace_company_id_uq" ON "fdp_departments" ("workspace_id", "company_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_departments" ADD CONSTRAINT "fdp_departments_workspace_parent_fk" FOREIGN KEY ("workspace_id", "company_id", "parent_department_id") REFERENCES "public"."fdp_departments"("workspace_id", "company_id", "id");
--> statement-breakpoint
CREATE TABLE "fdp_positions" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
  "company_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "cbo_code" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_positions_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_positions_workspace_company_fk" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_positions_status_check" CHECK ("status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_positions_workspace_company_code_uq" ON "fdp_positions" ("workspace_id", "company_id", "code");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_positions_workspace_company_id_uq" ON "fdp_positions" ("workspace_id", "company_id", "id");
--> statement-breakpoint
CREATE TABLE "fdp_cost_centers" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
  "company_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_cost_centers_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_cost_centers_workspace_company_fk" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_cost_centers_status_check" CHECK ("status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_cost_centers_workspace_company_code_uq" ON "fdp_cost_centers" ("workspace_id", "company_id", "code");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_cost_centers_workspace_company_id_uq" ON "fdp_cost_centers" ("workspace_id", "company_id", "id");
--> statement-breakpoint
CREATE TABLE "fdp_work_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
  "company_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "weekly_hours" integer DEFAULT 44 NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_work_schedules_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_work_schedules_workspace_company_fk" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_work_schedules_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "fdp_work_schedules_weekly_hours_check" CHECK ("weekly_hours" BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_work_schedules_workspace_company_code_uq" ON "fdp_work_schedules" ("workspace_id", "company_id", "code");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_work_schedules_workspace_company_id_uq" ON "fdp_work_schedules" ("workspace_id", "company_id", "id");
--> statement-breakpoint
CREATE TABLE "fdp_employees" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
  "company_id" text NOT NULL,
  "department_id" text,
  "position_id" text,
  "cost_center_id" text,
  "work_schedule_id" text,
  "manager_employee_id" text,
  "registration_number" text NOT NULL,
  "full_name" text NOT NULL,
  "social_name" text DEFAULT '' NOT NULL,
  "cpf_hash" text DEFAULT '' NOT NULL,
  "cpf_last4" text DEFAULT '' NOT NULL,
  "email" text DEFAULT '' NOT NULL,
  "phone" text DEFAULT '' NOT NULL,
  "birth_date" date,
  "admission_date" date NOT NULL,
  "termination_date" date,
  "employment_status" text DEFAULT 'active' NOT NULL,
  "employment_type" text DEFAULT 'clt' NOT NULL,
  "work_model" text DEFAULT 'onsite' NOT NULL,
  "source_system" text DEFAULT 'manual' NOT NULL,
  "external_id" text DEFAULT '' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_employees_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_employees_workspace_company_fk" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "fdp_employees_workspace_department_fk" FOREIGN KEY ("workspace_id", "company_id", "department_id") REFERENCES "public"."fdp_departments"("workspace_id", "company_id", "id"),
  CONSTRAINT "fdp_employees_workspace_position_fk" FOREIGN KEY ("workspace_id", "company_id", "position_id") REFERENCES "public"."fdp_positions"("workspace_id", "company_id", "id"),
  CONSTRAINT "fdp_employees_workspace_cost_center_fk" FOREIGN KEY ("workspace_id", "company_id", "cost_center_id") REFERENCES "public"."fdp_cost_centers"("workspace_id", "company_id", "id"),
  CONSTRAINT "fdp_employees_workspace_work_schedule_fk" FOREIGN KEY ("workspace_id", "company_id", "work_schedule_id") REFERENCES "public"."fdp_work_schedules"("workspace_id", "company_id", "id"),
  CONSTRAINT "fdp_employees_status_check" CHECK ("employment_status" IN ('active', 'on_leave', 'terminated')),
  CONSTRAINT "fdp_employees_type_check" CHECK ("employment_type" IN ('clt', 'intern', 'apprentice', 'temporary')),
  CONSTRAINT "fdp_employees_work_model_check" CHECK ("work_model" IN ('onsite', 'hybrid', 'remote')),
  CONSTRAINT "fdp_employees_source_check" CHECK ("source_system" IN ('manual', 'solides'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employees_workspace_company_registration_uq" ON "fdp_employees" ("workspace_id", "company_id", "registration_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employees_workspace_id_uq" ON "fdp_employees" ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employees_workspace_cpf_hash_uq" ON "fdp_employees" ("workspace_id", "cpf_hash") WHERE "cpf_hash" <> '';
--> statement-breakpoint
CREATE INDEX "fdp_employees_workspace_status_name_idx" ON "fdp_employees" ("workspace_id", "employment_status", "full_name");
--> statement-breakpoint
ALTER TABLE "fdp_employees" ADD CONSTRAINT "fdp_employees_workspace_manager_fk" FOREIGN KEY ("workspace_id", "manager_employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_departments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_departments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_positions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_positions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_cost_centers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_cost_centers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_work_schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_work_schedules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employees" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employees" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_departments_workspace_isolation" ON "fdp_departments" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_positions_workspace_isolation" ON "fdp_positions" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_cost_centers_workspace_isolation" ON "fdp_cost_centers" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_work_schedules_workspace_isolation" ON "fdp_work_schedules" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_employees_workspace_isolation" ON "fdp_employees" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
