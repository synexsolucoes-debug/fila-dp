-- Controle de pagamento de psicólogos e prestadores PJ.
-- Migration aditiva: nenhuma tabela existente é removida ou reescrita.
CREATE TABLE "fdp_psychologist_profiles" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"default_session_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"payout_encrypted" text DEFAULT '' NOT NULL,
	"payout_iv" text DEFAULT '' NOT NULL,
	"payout_tag" text DEFAULT '' NOT NULL,
	"payout_key_version" integer DEFAULT 0 NOT NULL,
	"administrative_notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_psychologist_profiles_amount_check" CHECK ("fdp_psychologist_profiles"."default_session_amount" >= 0),
	CONSTRAINT "fdp_psychologist_profiles_status_check" CHECK ("fdp_psychologist_profiles"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "fdp_psychology_closings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"competence" text NOT NULL,
	"entries_count" integer DEFAULT 0 NOT NULL,
	"sessions_count" integer DEFAULT 0 NOT NULL,
	"employees_count" integer DEFAULT 0 NOT NULL,
	"gross_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"adjustments_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"net_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"calc_version" text NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"reopen_reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_psychology_closings_competence_check" CHECK ("fdp_psychology_closings"."competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_psychology_closings_status_check" CHECK ("fdp_psychology_closings"."status" IN ('open', 'review', 'approval', 'scheduled', 'paid', 'closed', 'reopened')),
	CONSTRAINT "fdp_psychology_closings_amount_check" CHECK ("fdp_psychology_closings"."gross_amount" >= 0 AND "fdp_psychology_closings"."net_amount" >= 0),
	CONSTRAINT "fdp_psychology_closings_count_check" CHECK ("fdp_psychology_closings"."entries_count" >= 0 AND "fdp_psychology_closings"."sessions_count" >= 0 AND "fdp_psychology_closings"."employees_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_psychology_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"closing_id" text,
	"competence" text NOT NULL,
	"session_date" date NOT NULL,
	"session_quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount" numeric(18, 2) NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"administrative_note" text DEFAULT '' NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"canceled_reason" text DEFAULT '' NOT NULL,
	"canceled_by" text,
	"canceled_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_psychology_sessions_competence_check" CHECK ("fdp_psychology_sessions"."competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_psychology_sessions_quantity_check" CHECK ("fdp_psychology_sessions"."session_quantity" > 0 AND "fdp_psychology_sessions"."session_quantity" <= 10000),
	CONSTRAINT "fdp_psychology_sessions_amount_check" CHECK ("fdp_psychology_sessions"."unit_amount" >= 0 AND "fdp_psychology_sessions"."total_amount" >= 0),
	CONSTRAINT "fdp_psychology_sessions_total_check" CHECK ("fdp_psychology_sessions"."total_amount" = "fdp_psychology_sessions"."unit_amount" * "fdp_psychology_sessions"."session_quantity"),
	CONSTRAINT "fdp_psychology_sessions_origin_check" CHECK ("fdp_psychology_sessions"."origin" IN ('manual', 'import', 'integration')),
	CONSTRAINT "fdp_psychology_sessions_status_check" CHECK ("fdp_psychology_sessions"."status" IN ('registered', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "fdp_psychology_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"closing_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"reason" text NOT NULL,
	"previous_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"new_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_psychology_adjustments_kind_check" CHECK ("fdp_psychology_adjustments"."kind" IN ('inclusion', 'cancellation', 'correction', 'discount', 'complement')),
	CONSTRAINT "fdp_psychology_adjustments_amount_check" CHECK ("fdp_psychology_adjustments"."amount" >= 0),
	CONSTRAINT "fdp_psychology_adjustments_reason_check" CHECK (length("fdp_psychology_adjustments"."reason") >= 5)
);
--> statement-breakpoint
CREATE TABLE "fdp_psychology_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"closing_id" text NOT NULL,
	"amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"method" text DEFAULT 'pix' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_date" date,
	"paid_date" date,
	"invoice_number" text DEFAULT '' NOT NULL,
	"invoice_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"invoice_issue_date" date,
	"invoice_status" text DEFAULT 'not_required' NOT NULL,
	"receipt_reference" text DEFAULT '' NOT NULL,
	"responsible_user_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_psychology_payments_method_check" CHECK ("fdp_psychology_payments"."method" IN ('pix', 'bank_transfer', 'invoice_payment', 'other')),
	CONSTRAINT "fdp_psychology_payments_status_check" CHECK ("fdp_psychology_payments"."status" IN ('pending', 'scheduled', 'paid', 'canceled')),
	CONSTRAINT "fdp_psychology_payments_invoice_status_check" CHECK ("fdp_psychology_payments"."invoice_status" IN ('not_required', 'pending', 'received', 'validated', 'divergent')),
	CONSTRAINT "fdp_psychology_payments_amount_check" CHECK ("fdp_psychology_payments"."amount" >= 0 AND "fdp_psychology_payments"."invoice_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_contractor_profiles" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"contract_reference" text DEFAULT '' NOT NULL,
	"role_title" text DEFAULT '' NOT NULL,
	"department_id" text,
	"cost_center_id" text,
	"responsible_user_id" text,
	"contract_start" date,
	"contract_end" date,
	"base_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"invoice_limit_override" numeric(18, 2),
	"complement_method" text DEFAULT 'none' NOT NULL,
	"complement_platform" text DEFAULT '' NOT NULL,
	"complement_external_id" text DEFAULT '' NOT NULL,
	"payout_encrypted" text DEFAULT '' NOT NULL,
	"payout_iv" text DEFAULT '' NOT NULL,
	"payout_tag" text DEFAULT '' NOT NULL,
	"payout_key_version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_contractor_profiles_base_check" CHECK ("fdp_contractor_profiles"."base_amount" >= 0),
	CONSTRAINT "fdp_contractor_profiles_limit_check" CHECK ("fdp_contractor_profiles"."invoice_limit_override" IS NULL OR "fdp_contractor_profiles"."invoice_limit_override" >= 0),
	CONSTRAINT "fdp_contractor_profiles_complement_check" CHECK ("fdp_contractor_profiles"."complement_method" IN ('none', 'caju_saldo_livre', 'other_benefit_card', 'manual_transfer')),
	CONSTRAINT "fdp_contractor_profiles_status_check" CHECK ("fdp_contractor_profiles"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "fdp_invoice_limit_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"scope" text NOT NULL,
	"company_id" text,
	"provider_id" text,
	"contract_reference" text DEFAULT '' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_invoice_limit_policies_scope_check" CHECK ("fdp_invoice_limit_policies"."scope" IN ('workspace', 'company', 'contract', 'provider')),
	CONSTRAINT "fdp_invoice_limit_policies_amount_check" CHECK ("fdp_invoice_limit_policies"."amount" >= 0),
	CONSTRAINT "fdp_invoice_limit_policies_target_check" CHECK (
		("fdp_invoice_limit_policies"."scope" = 'workspace' AND "fdp_invoice_limit_policies"."company_id" IS NULL AND "fdp_invoice_limit_policies"."provider_id" IS NULL)
		OR ("fdp_invoice_limit_policies"."scope" = 'company' AND "fdp_invoice_limit_policies"."company_id" IS NOT NULL AND "fdp_invoice_limit_policies"."provider_id" IS NULL)
		OR ("fdp_invoice_limit_policies"."scope" = 'contract' AND "fdp_invoice_limit_policies"."company_id" IS NOT NULL AND "fdp_invoice_limit_policies"."contract_reference" <> '')
		OR ("fdp_invoice_limit_policies"."scope" = 'provider' AND "fdp_invoice_limit_policies"."provider_id" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE TABLE "fdp_contractor_closings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"competence" text NOT NULL,
	"base_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"credits_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"debits_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"net_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"invoice_limit_amount" numeric(18, 2),
	"invoice_limit_source" text DEFAULT 'none' NOT NULL,
	"invoice_limit_policy_id" text,
	"invoice_expected_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"complement_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"complement_method" text DEFAULT 'none' NOT NULL,
	"caju_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"invoice_number" text DEFAULT '' NOT NULL,
	"invoice_received_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"invoice_issue_date" date,
	"invoice_status" text DEFAULT 'pending' NOT NULL,
	"invoice_attachment_reference" text DEFAULT '' NOT NULL,
	"caju_status" text DEFAULT 'not_required' NOT NULL,
	"caju_batch_reference" text DEFAULT '' NOT NULL,
	"caju_external_id" text DEFAULT '' NOT NULL,
	"caju_error" text DEFAULT '' NOT NULL,
	"complement_paid_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"reconciliation_status" text DEFAULT 'pending' NOT NULL,
	"reconciliation_difference" numeric(18, 2) DEFAULT 0 NOT NULL,
	"calc_version" text NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"reopen_reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_contractor_closings_competence_check" CHECK ("fdp_contractor_closings"."competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_contractor_closings_status_check" CHECK ("fdp_contractor_closings"."status" IN ('open', 'review', 'approval', 'approved', 'invoice_pending', 'ready_to_pay', 'paid', 'closed', 'reopened')),
	CONSTRAINT "fdp_contractor_closings_invoice_status_check" CHECK ("fdp_contractor_closings"."invoice_status" IN ('not_required', 'pending', 'received', 'validated', 'divergent')),
	CONSTRAINT "fdp_contractor_closings_caju_status_check" CHECK ("fdp_contractor_closings"."caju_status" IN ('not_required', 'pending', 'approved', 'sent', 'processed', 'error', 'canceled')),
	CONSTRAINT "fdp_contractor_closings_reconciliation_check" CHECK ("fdp_contractor_closings"."reconciliation_status" IN ('pending', 'reconciled', 'divergent')),
	CONSTRAINT "fdp_contractor_closings_limit_source_check" CHECK ("fdp_contractor_closings"."invoice_limit_source" IN ('none', 'workspace', 'company', 'contract', 'provider')),
	CONSTRAINT "fdp_contractor_closings_complement_check" CHECK ("fdp_contractor_closings"."complement_method" IN ('none', 'caju_saldo_livre', 'other_benefit_card', 'manual_transfer')),
	CONSTRAINT "fdp_contractor_closings_amount_check" CHECK ("fdp_contractor_closings"."base_amount" >= 0 AND "fdp_contractor_closings"."credits_amount" >= 0 AND "fdp_contractor_closings"."debits_amount" >= 0 AND "fdp_contractor_closings"."net_amount" >= 0 AND "fdp_contractor_closings"."invoice_expected_amount" >= 0 AND "fdp_contractor_closings"."complement_amount" >= 0 AND "fdp_contractor_closings"."caju_amount" >= 0 AND "fdp_contractor_closings"."invoice_received_amount" >= 0 AND "fdp_contractor_closings"."complement_paid_amount" >= 0),
	CONSTRAINT "fdp_contractor_closings_split_check" CHECK ("fdp_contractor_closings"."invoice_expected_amount" + "fdp_contractor_closings"."complement_amount" = "fdp_contractor_closings"."net_amount"),
	CONSTRAINT "fdp_contractor_closings_limit_cap_check" CHECK ("fdp_contractor_closings"."invoice_limit_amount" IS NULL OR "fdp_contractor_closings"."invoice_expected_amount" <= "fdp_contractor_closings"."invoice_limit_amount")
);
--> statement-breakpoint
CREATE TABLE "fdp_contractor_components" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"closing_id" text,
	"competence" text NOT NULL,
	"direction" text NOT NULL,
	"component_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"component_quantity" numeric(18, 4) DEFAULT 1 NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"document_reference" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"canceled_reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_contractor_components_competence_check" CHECK ("fdp_contractor_components"."competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_contractor_components_direction_check" CHECK ("fdp_contractor_components"."direction" IN ('credit', 'debit')),
	CONSTRAINT "fdp_contractor_components_status_check" CHECK ("fdp_contractor_components"."status" IN ('active', 'canceled')),
	CONSTRAINT "fdp_contractor_components_origin_check" CHECK ("fdp_contractor_components"."origin" IN ('manual', 'import', 'integration')),
	CONSTRAINT "fdp_contractor_components_amount_check" CHECK ("fdp_contractor_components"."amount" >= 0),
	CONSTRAINT "fdp_contractor_components_type_check" CHECK (
		("fdp_contractor_components"."direction" = 'credit' AND "fdp_contractor_components"."component_type" IN ('base', 'commission', 'bonus', 'award', 'reimbursement', 'additional', 'positive_adjustment', 'other_credit'))
		OR ("fdp_contractor_components"."direction" = 'debit' AND "fdp_contractor_components"."component_type" IN ('health_plan', 'dental_plan', 'benefit', 'coparticipation', 'equipment', 'advance', 'absence', 'loan', 'negative_adjustment', 'other_debit'))
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_psychologist_profiles_workspace_provider_uq" ON "fdp_psychologist_profiles" USING btree ("workspace_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_psychology_closings_workspace_provider_cycle_uq" ON "fdp_psychology_closings" USING btree ("workspace_id","provider_id","payroll_cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_psychology_closings_workspace_id_uq" ON "fdp_psychology_closings" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_psychology_closings_workspace_competence_idx" ON "fdp_psychology_closings" USING btree ("workspace_id","competence","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_psychology_sessions_workspace_id_uq" ON "fdp_psychology_sessions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_psychology_sessions_workspace_external_uq" ON "fdp_psychology_sessions" USING btree ("workspace_id","external_id") WHERE "fdp_psychology_sessions"."external_id" <> '';--> statement-breakpoint
CREATE INDEX "fdp_psychology_sessions_workspace_cycle_provider_idx" ON "fdp_psychology_sessions" USING btree ("workspace_id","payroll_cycle_id","provider_id","status");--> statement-breakpoint
CREATE INDEX "fdp_psychology_sessions_workspace_employee_idx" ON "fdp_psychology_sessions" USING btree ("workspace_id","employee_id","competence");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_psychology_adjustments_workspace_id_uq" ON "fdp_psychology_adjustments" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_psychology_adjustments_workspace_closing_idx" ON "fdp_psychology_adjustments" USING btree ("workspace_id","closing_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_psychology_payments_workspace_closing_uq" ON "fdp_psychology_payments" USING btree ("workspace_id","closing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_psychology_payments_workspace_id_uq" ON "fdp_psychology_payments" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_contractor_profiles_workspace_provider_uq" ON "fdp_contractor_profiles" USING btree ("workspace_id","provider_id");--> statement-breakpoint
CREATE INDEX "fdp_contractor_profiles_workspace_company_idx" ON "fdp_contractor_profiles" USING btree ("workspace_id","company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_invoice_limit_policies_workspace_id_uq" ON "fdp_invoice_limit_policies" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_invoice_limit_policies_workspace_scope_idx" ON "fdp_invoice_limit_policies" USING btree ("workspace_id","scope","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_contractor_closings_workspace_provider_cycle_uq" ON "fdp_contractor_closings" USING btree ("workspace_id","provider_id","payroll_cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_contractor_closings_workspace_id_uq" ON "fdp_contractor_closings" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_contractor_closings_workspace_competence_idx" ON "fdp_contractor_closings" USING btree ("workspace_id","competence","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_contractor_components_workspace_id_uq" ON "fdp_contractor_components" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_contractor_components_workspace_external_uq" ON "fdp_contractor_components" USING btree ("workspace_id","external_id") WHERE "fdp_contractor_components"."external_id" <> '';--> statement-breakpoint
CREATE INDEX "fdp_contractor_components_workspace_cycle_provider_idx" ON "fdp_contractor_components" USING btree ("workspace_id","payroll_cycle_id","provider_id","status");
--> statement-breakpoint
ALTER TABLE "fdp_psychologist_profiles" ADD CONSTRAINT "fdp_psychologist_profiles_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychologist_profiles" ADD CONSTRAINT "fdp_psychologist_profiles_provider_id_fdp_auxiliary_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."fdp_auxiliary_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychologist_profiles" ADD CONSTRAINT "fdp_psychologist_profiles_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ADD CONSTRAINT "fdp_psychology_closings_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ADD CONSTRAINT "fdp_psychology_closings_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ADD CONSTRAINT "fdp_psychology_closings_provider_id_fdp_auxiliary_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."fdp_auxiliary_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ADD CONSTRAINT "fdp_psychology_closings_payroll_cycle_id_fdp_payroll_cycles_id_fk" FOREIGN KEY ("payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ADD CONSTRAINT "fdp_psychology_closings_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ADD CONSTRAINT "fdp_psychology_closings_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ADD CONSTRAINT "fdp_psychology_closings_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ADD CONSTRAINT "fdp_psychology_closings_workspace_approver_fk" FOREIGN KEY ("workspace_id","approved_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_provider_id_fdp_auxiliary_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."fdp_auxiliary_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_employee_id_fdp_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."fdp_employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_payroll_cycle_id_fdp_payroll_cycles_id_fk" FOREIGN KEY ("payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_workspace_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ADD CONSTRAINT "fdp_psychology_sessions_workspace_closing_fk" FOREIGN KEY ("workspace_id","closing_id") REFERENCES "public"."fdp_psychology_closings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_adjustments" ADD CONSTRAINT "fdp_psychology_adjustments_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_adjustments" ADD CONSTRAINT "fdp_psychology_adjustments_closing_id_fdp_psychology_closings_id_fk" FOREIGN KEY ("closing_id") REFERENCES "public"."fdp_psychology_closings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_adjustments" ADD CONSTRAINT "fdp_psychology_adjustments_workspace_closing_fk" FOREIGN KEY ("workspace_id","closing_id") REFERENCES "public"."fdp_psychology_closings"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_adjustments" ADD CONSTRAINT "fdp_psychology_adjustments_workspace_author_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_payments" ADD CONSTRAINT "fdp_psychology_payments_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_payments" ADD CONSTRAINT "fdp_psychology_payments_closing_id_fdp_psychology_closings_id_fk" FOREIGN KEY ("closing_id") REFERENCES "public"."fdp_psychology_closings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_payments" ADD CONSTRAINT "fdp_psychology_payments_workspace_closing_fk" FOREIGN KEY ("workspace_id","closing_id") REFERENCES "public"."fdp_psychology_closings"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychology_payments" ADD CONSTRAINT "fdp_psychology_payments_workspace_responsible_fk" FOREIGN KEY ("workspace_id","responsible_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_provider_id_fdp_auxiliary_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."fdp_auxiliary_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_workspace_department_fk" FOREIGN KEY ("workspace_id","company_id","department_id") REFERENCES "public"."fdp_departments"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_workspace_cost_center_fk" FOREIGN KEY ("workspace_id","company_id","cost_center_id") REFERENCES "public"."fdp_cost_centers"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_workspace_responsible_fk" FOREIGN KEY ("workspace_id","responsible_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_invoice_limit_policies" ADD CONSTRAINT "fdp_invoice_limit_policies_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_invoice_limit_policies" ADD CONSTRAINT "fdp_invoice_limit_policies_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_invoice_limit_policies" ADD CONSTRAINT "fdp_invoice_limit_policies_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_provider_id_fdp_auxiliary_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."fdp_auxiliary_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_payroll_cycle_id_fdp_payroll_cycles_id_fk" FOREIGN KEY ("payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_workspace_limit_policy_fk" FOREIGN KEY ("workspace_id","invoice_limit_policy_id") REFERENCES "public"."fdp_invoice_limit_policies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_workspace_approver_fk" FOREIGN KEY ("workspace_id","approved_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_provider_id_fdp_auxiliary_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."fdp_auxiliary_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_payroll_cycle_id_fdp_payroll_cycles_id_fk" FOREIGN KEY ("payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_workspace_closing_fk" FOREIGN KEY ("workspace_id","closing_id") REFERENCES "public"."fdp_contractor_closings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_psychologist_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychologist_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychology_closings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychology_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychology_adjustments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychology_adjustments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychology_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_psychology_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_invoice_limit_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_invoice_limit_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_psychologist_profiles_workspace_isolation" ON "fdp_psychologist_profiles"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_psychology_closings_workspace_isolation" ON "fdp_psychology_closings"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_psychology_sessions_workspace_isolation" ON "fdp_psychology_sessions"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_psychology_adjustments_workspace_isolation" ON "fdp_psychology_adjustments"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_psychology_payments_workspace_isolation" ON "fdp_psychology_payments"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_contractor_profiles_workspace_isolation" ON "fdp_contractor_profiles"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_invoice_limit_policies_workspace_isolation" ON "fdp_invoice_limit_policies"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_contractor_closings_workspace_isolation" ON "fdp_contractor_closings"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_contractor_components_workspace_isolation" ON "fdp_contractor_components"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
-- Fechamentos concluídos preservam o histórico: o snapshot e os valores apurados
-- só voltam a ser editáveis depois de uma reabertura justificada.
CREATE OR REPLACE FUNCTION "fdp_payment_closing_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('paid', 'closed') THEN
      RAISE EXCEPTION 'closed payment closing is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('paid', 'closed') THEN
    -- Valores apurados e identidade do fechamento congelam a partir do pagamento.
    -- Somente colunas presentes nos dois fechamentos: a função é compartilhada.
    IF NEW.net_amount IS DISTINCT FROM OLD.net_amount
      OR NEW.calc_version IS DISTINCT FROM OLD.calc_version
      OR NEW.competence IS DISTINCT FROM OLD.competence
      OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
      OR NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.payroll_cycle_id IS DISTINCT FROM OLD.payroll_cycle_id THEN
      RAISE EXCEPTION 'closed payment closing is immutable';
    END IF;
    -- O snapshot é escrito uma única vez, no fechamento definitivo.
    IF OLD.status = 'closed' AND NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json THEN
      RAISE EXCEPTION 'closed payment closing is immutable';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'paid' AND NEW.status = 'closed')
      OR (NEW.status = 'reopened' AND length(coalesce(NEW.reopen_reason, '')) >= 5)
    ) THEN
      RAISE EXCEPTION 'reopening a closed payment closing requires a justification';
    END IF;
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_psychology_closings_guard"
BEFORE UPDATE OR DELETE ON "fdp_psychology_closings"
FOR EACH ROW EXECUTE FUNCTION "fdp_payment_closing_guard"();
--> statement-breakpoint
CREATE TRIGGER "fdp_contractor_closings_guard"
BEFORE UPDATE OR DELETE ON "fdp_contractor_closings"
FOR EACH ROW EXECUTE FUNCTION "fdp_payment_closing_guard"();
--> statement-breakpoint
-- Lançamentos vinculados a um fechamento concluído não podem ser alterados:
-- o valor histórico da consulta e dos componentes PJ é preservado.
CREATE OR REPLACE FUNCTION "fdp_payment_entry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked boolean;
  target text;
BEGIN
  target := coalesce(CASE WHEN TG_OP = 'DELETE' THEN OLD.closing_id ELSE NEW.closing_id END, OLD.closing_id);
  IF target IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    NEW.updated_at = now();
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'fdp_psychology_sessions' THEN
    SELECT status IN ('paid', 'closed') INTO locked FROM fdp_psychology_closings WHERE id = target;
  ELSE
    SELECT status IN ('paid', 'closed') INTO locked FROM fdp_contractor_closings WHERE id = target;
  END IF;

  IF coalesce(locked, false) THEN
    RAISE EXCEPTION 'payment entry of a closed closing is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_psychology_sessions_guard"
BEFORE UPDATE OR DELETE ON "fdp_psychology_sessions"
FOR EACH ROW EXECUTE FUNCTION "fdp_payment_entry_guard"();
--> statement-breakpoint
CREATE TRIGGER "fdp_contractor_components_guard"
BEFORE UPDATE OR DELETE ON "fdp_contractor_components"
FOR EACH ROW EXECUTE FUNCTION "fdp_payment_entry_guard"();
--> statement-breakpoint
-- Ajustes de psicólogos são append-only: correções entram como novo registro.
CREATE OR REPLACE FUNCTION "fdp_psychology_adjustments_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'psychology adjustments are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_psychology_adjustments_append_only"
BEFORE UPDATE OR DELETE ON "fdp_psychology_adjustments"
FOR EACH ROW EXECUTE FUNCTION "fdp_psychology_adjustments_append_only"();
