CREATE TABLE "fdp_compliance_obligations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"payroll_cycle_id" text,
	"card_id" text,
	"obligation_type" text DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_user_id" text,
	"completed_at" timestamp with time zone,
	"recurrence_key" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_compliance_obligations_type_check" CHECK ("fdp_compliance_obligations"."obligation_type" IN ('payroll', 'social_security', 'tax', 'reporting', 'union', 'other')),
	CONSTRAINT "fdp_compliance_obligations_status_check" CHECK ("fdp_compliance_obligations"."status" IN ('open', 'in_progress', 'blocked', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "fdp_employee_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"payroll_cycle_id" text,
	"card_id" text,
	"movement_type" text NOT NULL,
	"effective_date" date NOT NULL,
	"title" text NOT NULL,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_employee_movements_type_check" CHECK ("fdp_employee_movements"."movement_type" IN ('salary_change', 'vacation', 'leave', 'termination', 'transfer', 'benefit_change', 'registration_sync', 'other')),
	CONSTRAINT "fdp_employee_movements_status_check" CHECK ("fdp_employee_movements"."status" IN ('draft', 'pending_approval', 'approved', 'rejected', 'applied', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "fdp_movement_approval_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"movement_id" text NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"approver_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_movement_approval_steps_status_check" CHECK ("fdp_movement_approval_steps"."status" IN ('pending', 'approved', 'rejected', 'skipped')),
	CONSTRAINT "fdp_movement_approval_steps_sequence_check" CHECK ("fdp_movement_approval_steps"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_operational_pending_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"payroll_cycle_id" text,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"blocking" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_user_id" text,
	"resolution" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_operational_pending_items_source_check" CHECK ("fdp_operational_pending_items"."source_type" IN ('movement', 'approval', 'obligation', 'cycle', 'card')),
	CONSTRAINT "fdp_operational_pending_items_severity_check" CHECK ("fdp_operational_pending_items"."severity" IN ('info', 'warning', 'critical')),
	CONSTRAINT "fdp_operational_pending_items_status_check" CHECK ("fdp_operational_pending_items"."status" IN ('open', 'in_progress', 'resolved', 'waived')),
	CONSTRAINT "fdp_operational_pending_items_blocking_check" CHECK ("fdp_operational_pending_items"."blocking" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "fdp_payroll_cycle_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"phase" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"owner_user_id" text,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"position" double precision DEFAULT 1000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_payroll_cycle_items_phase_check" CHECK ("fdp_payroll_cycle_items"."phase" IN ('pre_closing', 'post_closing')),
	CONSTRAINT "fdp_payroll_cycle_items_status_check" CHECK ("fdp_payroll_cycle_items"."status" IN ('pending', 'in_progress', 'blocked', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "fdp_payroll_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"competence" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"pre_closing_due_date" date,
	"payment_date" date,
	"post_closing_due_date" date,
	"closed_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_payroll_cycles_competence_check" CHECK ("fdp_payroll_cycles"."competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_payroll_cycles_status_check" CHECK ("fdp_payroll_cycles"."status" IN ('open', 'pre_closing', 'processing', 'post_closing', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "fdp_process_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_process_definitions_status_check" CHECK ("fdp_process_definitions"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "fdp_process_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"definition_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"configuration_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_process_versions_version_check" CHECK ("fdp_process_versions"."version" > 0),
	CONSTRAINT "fdp_process_versions_status_check" CHECK ("fdp_process_versions"."status" IN ('draft', 'published', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN "competence" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN "legal_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN "process_template_id" text;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ADD CONSTRAINT "fdp_compliance_obligations_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ADD CONSTRAINT "fdp_compliance_obligations_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ADD CONSTRAINT "fdp_compliance_obligations_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ADD CONSTRAINT "fdp_compliance_obligations_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ADD CONSTRAINT "fdp_compliance_obligations_workspace_card_fk" FOREIGN KEY ("workspace_id","card_id") REFERENCES "public"."fdp_cards"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ADD CONSTRAINT "fdp_compliance_obligations_workspace_owner_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_employee_id_fdp_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."fdp_employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_workspace_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_workspace_card_fk" FOREIGN KEY ("workspace_id","card_id") REFERENCES "public"."fdp_cards"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_workspace_requester_fk" FOREIGN KEY ("workspace_id","requested_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_workspace_decider_fk" FOREIGN KEY ("workspace_id","decided_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_movement_approval_steps" ADD CONSTRAINT "fdp_movement_approval_steps_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_movement_approval_steps" ADD CONSTRAINT "fdp_movement_approval_steps_movement_id_fdp_employee_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."fdp_employee_movements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_movement_approval_steps" ADD CONSTRAINT "fdp_movement_approval_steps_workspace_movement_fk" FOREIGN KEY ("workspace_id","movement_id") REFERENCES "public"."fdp_employee_movements"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_movement_approval_steps" ADD CONSTRAINT "fdp_movement_approval_steps_workspace_approver_fk" FOREIGN KEY ("workspace_id","approver_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_operational_pending_items" ADD CONSTRAINT "fdp_operational_pending_items_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_operational_pending_items" ADD CONSTRAINT "fdp_operational_pending_items_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_operational_pending_items" ADD CONSTRAINT "fdp_operational_pending_items_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_operational_pending_items" ADD CONSTRAINT "fdp_operational_pending_items_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_operational_pending_items" ADD CONSTRAINT "fdp_operational_pending_items_workspace_owner_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" ADD CONSTRAINT "fdp_payroll_cycle_items_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" ADD CONSTRAINT "fdp_payroll_cycle_items_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" ADD CONSTRAINT "fdp_payroll_cycle_items_payroll_cycle_id_fdp_payroll_cycles_id_fk" FOREIGN KEY ("payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" ADD CONSTRAINT "fdp_payroll_cycle_items_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" ADD CONSTRAINT "fdp_payroll_cycle_items_workspace_owner_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycles" ADD CONSTRAINT "fdp_payroll_cycles_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycles" ADD CONSTRAINT "fdp_payroll_cycles_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycles" ADD CONSTRAINT "fdp_payroll_cycles_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_definition_id_fdp_process_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."fdp_process_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_workspace_definition_fk" FOREIGN KEY ("workspace_id","definition_id") REFERENCES "public"."fdp_process_definitions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_workspace_publisher_fk" FOREIGN KEY ("workspace_id","published_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_compliance_obligations_workspace_id_uq" ON "fdp_compliance_obligations" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_compliance_obligations_workspace_recurrence_uq" ON "fdp_compliance_obligations" USING btree ("workspace_id","recurrence_key") WHERE "fdp_compliance_obligations"."recurrence_key" <> '';--> statement-breakpoint
CREATE INDEX "fdp_compliance_obligations_workspace_due_status_idx" ON "fdp_compliance_obligations" USING btree ("workspace_id","due_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employee_movements_workspace_id_uq" ON "fdp_employee_movements" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_employee_movements_workspace_status_effective_idx" ON "fdp_employee_movements" USING btree ("workspace_id","status","effective_date");--> statement-breakpoint
CREATE INDEX "fdp_employee_movements_workspace_employee_idx" ON "fdp_employee_movements" USING btree ("workspace_id","employee_id","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_movement_approval_steps_movement_sequence_uq" ON "fdp_movement_approval_steps" USING btree ("movement_id","sequence");--> statement-breakpoint
CREATE INDEX "fdp_movement_approval_steps_workspace_approver_idx" ON "fdp_movement_approval_steps" USING btree ("workspace_id","approver_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_operational_pending_items_workspace_key_uq" ON "fdp_operational_pending_items" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_operational_pending_items_workspace_id_uq" ON "fdp_operational_pending_items" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_operational_pending_items_workspace_status_due_idx" ON "fdp_operational_pending_items" USING btree ("workspace_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_cycle_items_cycle_phase_title_uq" ON "fdp_payroll_cycle_items" USING btree ("payroll_cycle_id","phase","title");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_cycle_items_workspace_id_uq" ON "fdp_payroll_cycle_items" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_payroll_cycle_items_workspace_status_idx" ON "fdp_payroll_cycle_items" USING btree ("workspace_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_cycles_workspace_company_competence_uq" ON "fdp_payroll_cycles" USING btree ("workspace_id","company_id","competence");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_cycles_workspace_company_id_uq" ON "fdp_payroll_cycles" USING btree ("workspace_id","company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_cycles_workspace_id_uq" ON "fdp_payroll_cycles" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_payroll_cycles_workspace_status_idx" ON "fdp_payroll_cycles" USING btree ("workspace_id","status","competence");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_process_definitions_workspace_code_uq" ON "fdp_process_definitions" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_process_definitions_workspace_id_uq" ON "fdp_process_definitions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_process_definitions_workspace_status_idx" ON "fdp_process_definitions" USING btree ("workspace_id","status","name");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_process_versions_definition_version_uq" ON "fdp_process_versions" USING btree ("definition_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_process_versions_workspace_id_uq" ON "fdp_process_versions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_process_versions_workspace_status_idx" ON "fdp_process_versions" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employees_workspace_company_id_uq" ON "fdp_employees" USING btree ("workspace_id","company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_templates_workspace_id_uq" ON "fdp_process_templates" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_competence_check" CHECK ("fdp_cards"."competence" = '' OR "fdp_cards"."competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_movement_approval_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_movement_approval_steps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_operational_pending_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_operational_pending_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_process_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_compliance_obligations_workspace_isolation" ON "fdp_compliance_obligations" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_employee_movements_workspace_isolation" ON "fdp_employee_movements" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_movement_approval_steps_workspace_isolation" ON "fdp_movement_approval_steps" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_operational_pending_items_workspace_isolation" ON "fdp_operational_pending_items" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_payroll_cycle_items_workspace_isolation" ON "fdp_payroll_cycle_items" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_payroll_cycles_workspace_isolation" ON "fdp_payroll_cycles" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_process_definitions_workspace_isolation" ON "fdp_process_definitions" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_process_versions_workspace_isolation" ON "fdp_process_versions" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_protect_published_process_version"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'published process versions are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND (
    NEW.configuration_json IS DISTINCT FROM OLD.configuration_json OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.definition_id IS DISTINCT FROM OLD.definition_id
  ) THEN
    RAISE EXCEPTION 'published process versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_process_versions_immutable_published"
BEFORE UPDATE OR DELETE ON "fdp_process_versions"
FOR EACH ROW EXECUTE FUNCTION "fdp_protect_published_process_version"();
