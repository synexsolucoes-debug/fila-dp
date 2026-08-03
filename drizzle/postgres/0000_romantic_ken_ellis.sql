CREATE TABLE "fdp_access_recovery_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_activity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"card_id" text,
	"actor_email" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_automation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"condition_json" text DEFAULT '{}' NOT NULL,
	"action_json" text DEFAULT '{}' NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"position" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_boards" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"board_type" text DEFAULT 'general' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_business_holidays" (
	"workspace_id" text NOT NULL,
	"holiday_date" date NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "fdp_business_holidays_workspace_id_holiday_date_pk" PRIMARY KEY("workspace_id","holiday_date")
);
--> statement-breakpoint
CREATE TABLE "fdp_calendar_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'needs_credentials' NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"external_calendar_id" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_card_assignees" (
	"card_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "fdp_card_assignees_card_id_user_id_pk" PRIMARY KEY("card_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "fdp_card_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_card_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_card_labels" (
	"card_id" text NOT NULL,
	"label_id" text NOT NULL,
	CONSTRAINT "fdp_card_labels_card_id_label_id_pk" PRIMARY KEY("card_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "fdp_card_sla_pauses" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"card_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"reason" text NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"list_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"company_id" text,
	"company" text DEFAULT '' NOT NULL,
	"process_type" text DEFAULT 'OUTROS' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_name" text DEFAULT '' NOT NULL,
	"due_at" timestamp with time zone,
	"sla_status" text DEFAULT 'safe' NOT NULL,
	"position" double precision NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"archived" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sla_target_minutes" integer DEFAULT 0 NOT NULL,
	"sla_started_at" timestamp with time zone,
	"sla_paused_minutes" integer DEFAULT 0 NOT NULL,
	"sla_pause_reason" text DEFAULT '' NOT NULL,
	"sla_escalation_level" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_checklist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"title" text NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"position" double precision NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fdp_companies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_company_id" text,
	"is_principal" integer DEFAULT 0 NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text DEFAULT '' NOT NULL,
	"tax_id" text DEFAULT '' NOT NULL,
	"external_code" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_custom_field_values" (
	"card_id" text NOT NULL,
	"field_id" text NOT NULL,
	"value_text" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_custom_field_values_card_id_field_id_pk" PRIMARY KEY("card_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "fdp_custom_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"field_key" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"options_json" text DEFAULT '[]' NOT NULL,
	"required" integer DEFAULT 0 NOT NULL,
	"position" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_hr_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"company_id" text NOT NULL,
	"period" text NOT NULL,
	"headcount" integer DEFAULT 0 NOT NULL,
	"headcount_start" integer DEFAULT 0 NOT NULL,
	"headcount_end" integer DEFAULT 0 NOT NULL,
	"leaves_count" integer DEFAULT 0 NOT NULL,
	"admissions" integer DEFAULT 0 NOT NULL,
	"terminations" integer DEFAULT 0 NOT NULL,
	"voluntary_terminations" integer DEFAULT 0 NOT NULL,
	"involuntary_terminations" integer DEFAULT 0 NOT NULL,
	"base_salary" numeric(18, 2) DEFAULT 0 NOT NULL,
	"variable_pay" numeric(18, 2) DEFAULT 0 NOT NULL,
	"overtime_pay" numeric(18, 2) DEFAULT 0 NOT NULL,
	"additional_pay" numeric(18, 2) DEFAULT 0 NOT NULL,
	"vacation_pay" numeric(18, 2) DEFAULT 0 NOT NULL,
	"thirteenth_pay" numeric(18, 2) DEFAULT 0 NOT NULL,
	"termination_pay" numeric(18, 2) DEFAULT 0 NOT NULL,
	"gross_payroll" numeric(18, 2) DEFAULT 0 NOT NULL,
	"employee_inss" numeric(18, 2) DEFAULT 0 NOT NULL,
	"employee_irrf" numeric(18, 2) DEFAULT 0 NOT NULL,
	"employee_other_deductions" numeric(18, 2) DEFAULT 0 NOT NULL,
	"net_pay" numeric(18, 2) DEFAULT 0 NOT NULL,
	"employer_inss" numeric(18, 2) DEFAULT 0 NOT NULL,
	"rat_contribution" numeric(18, 2) DEFAULT 0 NOT NULL,
	"third_party_contributions" numeric(18, 2) DEFAULT 0 NOT NULL,
	"fgts" numeric(18, 2) DEFAULT 0 NOT NULL,
	"fgts_penalty" numeric(18, 2) DEFAULT 0 NOT NULL,
	"employer_charges" numeric(18, 2) DEFAULT 0 NOT NULL,
	"benefits_cost" numeric(18, 2) DEFAULT 0 NOT NULL,
	"provisions_cost" numeric(18, 2) DEFAULT 0 NOT NULL,
	"other_costs" numeric(18, 2) DEFAULT 0 NOT NULL,
	"payroll_cost" numeric(18, 2) DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_workspace_inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" text DEFAULT 'manual' NOT NULL,
	"sender_name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"converted_card_id" text
);
--> statement-breakpoint
CREATE TABLE "fdp_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'needs_credentials' NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"position" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"position" double precision NOT NULL,
	"sla_behavior" text DEFAULT 'running' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_member_company_access" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_member_company_access_workspace_id_user_id_company_id_pk" PRIMARY KEY("workspace_id","user_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "fdp_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_key" text NOT NULL,
	"notification_type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"card_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_planner_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"card_id" text,
	"title" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"block_type" text DEFAULT 'focus' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_process_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"process_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"checklist_json" text DEFAULT '[]' NOT NULL,
	"default_sla_days" integer DEFAULT 3 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"position" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_sla_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"process_type" text NOT NULL,
	"target_business_days" integer DEFAULT 3 NOT NULL,
	"warning_business_days" integer DEFAULT 1 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_user_workspace_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"active_workspace_id" text,
	"active_board_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"password_salt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "fdp_workspace_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"business_days_json" text DEFAULT '[1,2,3,4,5]' NOT NULL,
	"day_start" text DEFAULT '08:00' NOT NULL,
	"day_end" text DEFAULT '18:00' NOT NULL,
	"realtime_seconds" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fdp_access_recovery_tokens" ADD CONSTRAINT "fdp_access_recovery_tokens_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_activity_events" ADD CONSTRAINT "fdp_activity_events_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_activity_events" ADD CONSTRAINT "fdp_activity_events_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_automation_rules" ADD CONSTRAINT "fdp_automation_rules_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_boards" ADD CONSTRAINT "fdp_boards_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_business_holidays" ADD CONSTRAINT "fdp_business_holidays_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_calendar_connections" ADD CONSTRAINT "fdp_calendar_connections_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_calendar_connections" ADD CONSTRAINT "fdp_calendar_connections_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_assignees" ADD CONSTRAINT "fdp_card_assignees_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_assignees" ADD CONSTRAINT "fdp_card_assignees_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD CONSTRAINT "fdp_card_attachments_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ADD CONSTRAINT "fdp_card_comments_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ADD CONSTRAINT "fdp_card_comments_author_user_id_fdp_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."fdp_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_labels" ADD CONSTRAINT "fdp_card_labels_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_labels" ADD CONSTRAINT "fdp_card_labels_label_id_fdp_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."fdp_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_sla_pauses" ADD CONSTRAINT "fdp_card_sla_pauses_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_card_sla_pauses" ADD CONSTRAINT "fdp_card_sla_pauses_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_board_id_fdp_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."fdp_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_list_id_fdp_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."fdp_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD CONSTRAINT "fdp_checklist_items_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD CONSTRAINT "fdp_companies_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD CONSTRAINT "fdp_companies_parent_company_id_fdp_companies_id_fk" FOREIGN KEY ("parent_company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_custom_field_values" ADD CONSTRAINT "fdp_custom_field_values_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_custom_field_values" ADD CONSTRAINT "fdp_custom_field_values_field_id_fdp_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fdp_custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_custom_fields" ADD CONSTRAINT "fdp_custom_fields_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_hr_metrics" ADD CONSTRAINT "fdp_hr_metrics_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_hr_metrics" ADD CONSTRAINT "fdp_hr_metrics_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" ADD CONSTRAINT "fdp_workspace_inbox_items_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" ADD CONSTRAINT "fdp_workspace_inbox_items_converted_card_id_fdp_cards_id_fk" FOREIGN KEY ("converted_card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integrations" ADD CONSTRAINT "fdp_integrations_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_labels" ADD CONSTRAINT "fdp_labels_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_lists" ADD CONSTRAINT "fdp_lists_board_id_fdp_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."fdp_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_member_company_access" ADD CONSTRAINT "fdp_member_company_access_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_member_company_access" ADD CONSTRAINT "fdp_member_company_access_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_member_company_access" ADD CONSTRAINT "fdp_member_company_access_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_notifications" ADD CONSTRAINT "fdp_notifications_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_notifications" ADD CONSTRAINT "fdp_notifications_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_notifications" ADD CONSTRAINT "fdp_notifications_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_planner_blocks" ADD CONSTRAINT "fdp_planner_blocks_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_planner_blocks" ADD CONSTRAINT "fdp_planner_blocks_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_planner_blocks" ADD CONSTRAINT "fdp_planner_blocks_card_id_fdp_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."fdp_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_process_templates" ADD CONSTRAINT "fdp_process_templates_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_sla_policies" ADD CONSTRAINT "fdp_sla_policies_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_user_workspace_preferences" ADD CONSTRAINT "fdp_user_workspace_preferences_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_user_workspace_preferences" ADD CONSTRAINT "fdp_user_workspace_preferences_active_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("active_workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_members" ADD CONSTRAINT "fdp_workspace_members_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_members" ADD CONSTRAINT "fdp_workspace_members_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings" ADD CONSTRAINT "fdp_workspace_settings_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD CONSTRAINT "fdp_workspaces_owner_user_id_fdp_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."fdp_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_access_recovery_token_hash_uq" ON "fdp_access_recovery_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "fdp_access_recovery_user_expiry_idx" ON "fdp_access_recovery_tokens" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "fdp_activity_workspace_created_idx" ON "fdp_activity_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "fdp_rules_workspace_position_idx" ON "fdp_automation_rules" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_boards_workspace_name_uq" ON "fdp_boards" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_calendar_connections_user_provider_uq" ON "fdp_calendar_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_attachments_object_key_uq" ON "fdp_card_attachments" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "fdp_attachments_card_created_idx" ON "fdp_card_attachments" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "fdp_comments_card_created_idx" ON "fdp_card_comments" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "fdp_card_sla_pause_open_idx" ON "fdp_card_sla_pauses" USING btree ("card_id","ended_at");--> statement-breakpoint
CREATE INDEX "fdp_cards_board_list_position_idx" ON "fdp_cards" USING btree ("board_id","list_id","position");--> statement-breakpoint
CREATE INDEX "fdp_cards_due_status_idx" ON "fdp_cards" USING btree ("due_at","sla_status");--> statement-breakpoint
CREATE INDEX "fdp_checklist_card_position_idx" ON "fdp_checklist_items" USING btree ("card_id","position");--> statement-breakpoint
CREATE INDEX "fdp_companies_workspace_name_idx" ON "fdp_companies" USING btree ("workspace_id","legal_name");--> statement-breakpoint
CREATE INDEX "fdp_companies_workspace_tax_idx" ON "fdp_companies" USING btree ("workspace_id","tax_id");--> statement-breakpoint
CREATE INDEX "fdp_companies_workspace_parent_idx" ON "fdp_companies" USING btree ("workspace_id","parent_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_custom_fields_workspace_key_uq" ON "fdp_custom_fields" USING btree ("workspace_id","field_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_hr_metrics_workspace_company_period_uq" ON "fdp_hr_metrics" USING btree ("workspace_id","company_id","period");--> statement-breakpoint
CREATE INDEX "fdp_hr_metrics_workspace_period_idx" ON "fdp_hr_metrics" USING btree ("workspace_id","period");--> statement-breakpoint
CREATE INDEX "fdp_inbox_workspace_status_received_idx" ON "fdp_workspace_inbox_items" USING btree ("workspace_id","status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integrations_workspace_channel_uq" ON "fdp_integrations" USING btree ("workspace_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_labels_workspace_name_uq" ON "fdp_labels" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_lists_board_kind_uq" ON "fdp_lists" USING btree ("board_id","kind");--> statement-breakpoint
CREATE INDEX "fdp_lists_board_position_idx" ON "fdp_lists" USING btree ("board_id","position");--> statement-breakpoint
CREATE INDEX "fdp_member_company_access_user_idx" ON "fdp_member_company_access" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_notifications_user_event_uq" ON "fdp_notifications" USING btree ("user_id","event_key");--> statement-breakpoint
CREATE INDEX "fdp_notifications_user_read_created_idx" ON "fdp_notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "fdp_planner_user_start_idx" ON "fdp_planner_blocks" USING btree ("user_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_templates_workspace_name_uq" ON "fdp_process_templates" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_sla_policies_workspace_process_uq" ON "fdp_sla_policies" USING btree ("workspace_id","process_type");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_users_email_uq" ON "fdp_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspaces_owner_uq" ON "fdp_workspaces" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspaces_slug_uq" ON "fdp_workspaces" USING btree ("slug");