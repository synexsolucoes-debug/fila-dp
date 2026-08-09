CREATE TABLE "fdp_auxiliary_approval_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"execution_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"approver_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_auxiliary_approval_sequence_check" CHECK ("fdp_auxiliary_approval_steps"."sequence" > 0),
	CONSTRAINT "fdp_auxiliary_approval_status_check" CHECK ("fdp_auxiliary_approval_steps"."status" IN ('pending', 'approved', 'rejected', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "fdp_auxiliary_execution_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"execution_id" text NOT NULL,
	"revision" integer NOT NULL,
	"input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_auxiliary_revisions_revision_check" CHECK ("fdp_auxiliary_execution_revisions"."revision" > 0),
	CONSTRAINT "fdp_auxiliary_revisions_status_check" CHECK ("fdp_auxiliary_execution_revisions"."status" IN ('draft', 'submitted', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "fdp_auxiliary_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"provider_id" text,
	"module_type" text NOT NULL,
	"reference_code" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"total_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"due_date" date,
	"owner_user_id" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_auxiliary_executions_module_check" CHECK ("fdp_auxiliary_executions"."module_type" IN ('benefits', 'psychology', 'contractors')),
	CONSTRAINT "fdp_auxiliary_executions_status_check" CHECK ("fdp_auxiliary_executions"."status" IN ('draft', 'pending_approval', 'approved', 'rejected', 'closed', 'canceled')),
	CONSTRAINT "fdp_auxiliary_executions_revision_check" CHECK ("fdp_auxiliary_executions"."current_revision" > 0),
	CONSTRAINT "fdp_auxiliary_executions_amount_check" CHECK ("fdp_auxiliary_executions"."total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_auxiliary_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"provider_type" text NOT NULL,
	"code" text NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text DEFAULT '' NOT NULL,
	"tax_id" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_auxiliary_providers_type_check" CHECK ("fdp_auxiliary_providers"."provider_type" IN ('benefit_operator', 'psychologist', 'contractor')),
	CONSTRAINT "fdp_auxiliary_providers_status_check" CHECK ("fdp_auxiliary_providers"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" ADD CONSTRAINT "fdp_auxiliary_approval_steps_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" ADD CONSTRAINT "fdp_auxiliary_approval_steps_execution_id_fdp_auxiliary_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."fdp_auxiliary_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" ADD CONSTRAINT "fdp_auxiliary_approval_steps_revision_id_fdp_auxiliary_execution_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."fdp_auxiliary_execution_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" ADD CONSTRAINT "fdp_auxiliary_approval_workspace_execution_fk" FOREIGN KEY ("workspace_id","execution_id") REFERENCES "public"."fdp_auxiliary_executions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" ADD CONSTRAINT "fdp_auxiliary_approval_workspace_revision_fk" FOREIGN KEY ("workspace_id","revision_id") REFERENCES "public"."fdp_auxiliary_execution_revisions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" ADD CONSTRAINT "fdp_auxiliary_approval_execution_revision_fk" FOREIGN KEY ("workspace_id","execution_id","revision_id") REFERENCES "public"."fdp_auxiliary_execution_revisions"("workspace_id","execution_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" ADD CONSTRAINT "fdp_auxiliary_approval_workspace_approver_fk" FOREIGN KEY ("workspace_id","approver_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_execution_revisions" ADD CONSTRAINT "fdp_auxiliary_execution_revisions_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_execution_revisions" ADD CONSTRAINT "fdp_auxiliary_execution_revisions_execution_id_fdp_auxiliary_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."fdp_auxiliary_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_execution_revisions" ADD CONSTRAINT "fdp_auxiliary_revisions_workspace_execution_fk" FOREIGN KEY ("workspace_id","execution_id") REFERENCES "public"."fdp_auxiliary_executions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_execution_revisions" ADD CONSTRAINT "fdp_auxiliary_revisions_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_payroll_cycle_id_fdp_payroll_cycles_id_fk" FOREIGN KEY ("payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_workspace_owner_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_workspace_closer_fk" FOREIGN KEY ("workspace_id","closed_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ADD CONSTRAINT "fdp_auxiliary_executions_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_providers" ADD CONSTRAINT "fdp_auxiliary_providers_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_approval_revision_sequence_uq" ON "fdp_auxiliary_approval_steps" USING btree ("revision_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_approval_workspace_id_uq" ON "fdp_auxiliary_approval_steps" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_auxiliary_approval_workspace_approver_idx" ON "fdp_auxiliary_approval_steps" USING btree ("workspace_id","approver_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_revisions_execution_revision_uq" ON "fdp_auxiliary_execution_revisions" USING btree ("execution_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_revisions_workspace_id_uq" ON "fdp_auxiliary_execution_revisions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_revisions_workspace_execution_id_uq" ON "fdp_auxiliary_execution_revisions" USING btree ("workspace_id","execution_id","id");--> statement-breakpoint
CREATE INDEX "fdp_auxiliary_revisions_workspace_execution_idx" ON "fdp_auxiliary_execution_revisions" USING btree ("workspace_id","execution_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_executions_workspace_reference_uq" ON "fdp_auxiliary_executions" USING btree ("workspace_id","reference_code");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_executions_workspace_id_uq" ON "fdp_auxiliary_executions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_auxiliary_executions_workspace_cycle_module_idx" ON "fdp_auxiliary_executions" USING btree ("workspace_id","payroll_cycle_id","module_type","status");--> statement-breakpoint
CREATE INDEX "fdp_auxiliary_executions_workspace_due_idx" ON "fdp_auxiliary_executions" USING btree ("workspace_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_providers_workspace_code_uq" ON "fdp_auxiliary_providers" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auxiliary_providers_workspace_id_uq" ON "fdp_auxiliary_providers" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_auxiliary_providers_workspace_type_status_idx" ON "fdp_auxiliary_providers" USING btree ("workspace_id","provider_type","status","legal_name");
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_approval_steps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_execution_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_execution_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_executions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_providers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_auxiliary_providers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_auxiliary_approval_workspace_isolation" ON "fdp_auxiliary_approval_steps"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_auxiliary_revisions_workspace_isolation" ON "fdp_auxiliary_execution_revisions"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_auxiliary_executions_workspace_isolation" ON "fdp_auxiliary_executions"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_auxiliary_providers_workspace_isolation" ON "fdp_auxiliary_providers"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_auxiliary_revisions_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'submitted auxiliary revision is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
    NEW.execution_id IS DISTINCT FROM OLD.execution_id OR
    NEW.revision IS DISTINCT FROM OLD.revision OR
    NEW.input_json IS DISTINCT FROM OLD.input_json OR
    NEW.output_json IS DISTINCT FROM OLD.output_json OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'submitted auxiliary revision is immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'submitted') OR
    (OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected')) OR
    (OLD.status IN ('approved', 'rejected') AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'invalid auxiliary revision status transition';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_auxiliary_revisions_guard"
BEFORE UPDATE OR DELETE ON "fdp_auxiliary_execution_revisions"
FOR EACH ROW EXECUTE FUNCTION "fdp_auxiliary_revisions_guard"();
