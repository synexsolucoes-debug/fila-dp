CREATE TABLE IF NOT EXISTS "fdp_people" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  "full_name" text NOT NULL,
  "preferred_name" text DEFAULT '' NOT NULL,
  "email" text DEFAULT '' NOT NULL,
  "phone" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "fdp_people_workspace_name_idx" ON "fdp_people" ("workspace_id", "full_name");
CREATE INDEX IF NOT EXISTS "fdp_people_workspace_email_idx" ON "fdp_people" ("workspace_id", "email");

CREATE TABLE IF NOT EXISTS "fdp_employments" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  "person_id" text NOT NULL REFERENCES "fdp_people"("id") ON DELETE cascade,
  "company_id" text NOT NULL REFERENCES "fdp_companies"("id") ON DELETE cascade,
  "employee_code" text DEFAULT '' NOT NULL,
  "regime" text DEFAULT 'clt' NOT NULL,
  "job_title" text DEFAULT '' NOT NULL,
  "department" text DEFAULT '' NOT NULL,
  "cost_center" text DEFAULT '' NOT NULL,
  "manager_name" text DEFAULT '' NOT NULL,
  "start_date" date,
  "end_date" date,
  "monthly_value" numeric(18,2) DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "external_id" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "fdp_employments_workspace_company_status_idx" ON "fdp_employments" ("workspace_id", "company_id", "status");
CREATE INDEX IF NOT EXISTS "fdp_employments_workspace_regime_idx" ON "fdp_employments" ("workspace_id", "regime");
CREATE INDEX IF NOT EXISTS "fdp_employments_person_idx" ON "fdp_employments" ("person_id");

CREATE TABLE IF NOT EXISTS "fdp_benefit_policies" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  "company_id" text NOT NULL REFERENCES "fdp_companies"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "benefit_type" text NOT NULL,
  "eligible_regime" text DEFAULT 'all' NOT NULL,
  "monthly_value" numeric(18,2) DEFAULT 0 NOT NULL,
  "employee_discount" numeric(18,2) DEFAULT 0 NOT NULL,
  "channel" text DEFAULT 'payroll' NOT NULL,
  "effective_from" date,
  "effective_to" date,
  "active" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "fdp_benefit_policies_workspace_company_idx" ON "fdp_benefit_policies" ("workspace_id", "company_id", "active");

CREATE TABLE IF NOT EXISTS "fdp_benefit_movements" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  "policy_id" text NOT NULL REFERENCES "fdp_benefit_policies"("id") ON DELETE cascade,
  "employment_id" text NOT NULL REFERENCES "fdp_employments"("id") ON DELETE cascade,
  "company_id" text NOT NULL REFERENCES "fdp_companies"("id") ON DELETE cascade,
  "period" text NOT NULL,
  "amount" numeric(18,2) DEFAULT 0 NOT NULL,
  "employee_discount" numeric(18,2) DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'calculated' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_benefit_movements_employment_policy_period_uq" UNIQUE("employment_id", "policy_id", "period")
);
CREATE INDEX IF NOT EXISTS "fdp_benefit_movements_workspace_company_period_idx" ON "fdp_benefit_movements" ("workspace_id", "company_id", "period");

CREATE TABLE IF NOT EXISTS "fdp_pj_closings" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  "employment_id" text NOT NULL REFERENCES "fdp_employments"("id") ON DELETE cascade,
  "company_id" text NOT NULL REFERENCES "fdp_companies"("id") ON DELETE cascade,
  "period" text NOT NULL,
  "contract_amount" numeric(18,2) DEFAULT 0 NOT NULL,
  "variable_amount" numeric(18,2) DEFAULT 0 NOT NULL,
  "reimbursement_amount" numeric(18,2) DEFAULT 0 NOT NULL,
  "deductions_amount" numeric(18,2) DEFAULT 0 NOT NULL,
  "invoice_limit" numeric(18,2) DEFAULT 0 NOT NULL,
  "invoice_amount" numeric(18,2) DEFAULT 0 NOT NULL,
  "caju_excess" numeric(18,2) DEFAULT 0 NOT NULL,
  "net_amount" numeric(18,2) DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_pj_closings_employment_period_uq" UNIQUE("employment_id", "period")
);
CREATE INDEX IF NOT EXISTS "fdp_pj_closings_workspace_company_period_idx" ON "fdp_pj_closings" ("workspace_id", "company_id", "period");
