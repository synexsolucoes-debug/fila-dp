-- Materializa o processo inteiro na demanda: etapas futuras e tarefas ricas.
SELECT pg_advisory_xact_lock(hashtext('0072_demand_stage_and_task_instances'));
--> statement-breakpoint

ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "employee_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "requester_user_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_workspace_employee_fk";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_workspace_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_workspace_requester_user_fk";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_workspace_requester_user_fk"
  FOREIGN KEY ("workspace_id", "requester_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_cards_workspace_employee_idx" ON "fdp_cards" ("workspace_id", "employee_id", "created_at") WHERE "employee_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_cards_workspace_requester_user_idx" ON "fdp_cards" ("workspace_id", "requester_user_id", "created_at") WHERE "requester_user_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_demand_stages" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT current_setting('app.workspace_id', true) NOT NULL,
  "card_id" text NOT NULL,
  "process_version_id" text NOT NULL,
  "process_step_config_id" text,
  "bpmn_element_id" text NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "position" double precision NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_demand_stages_status_check" CHECK ("status" IN ('pending', 'in_progress', 'completed', 'skipped', 'cancelled')),
  CONSTRAINT "fdp_demand_stages_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_demand_stages_workspace_version_fk" FOREIGN KEY ("workspace_id", "process_version_id") REFERENCES "public"."fdp_process_versions"("workspace_id", "id"),
  CONSTRAINT "fdp_demand_stages_workspace_config_fk" FOREIGN KEY ("workspace_id", "process_step_config_id") REFERENCES "public"."fdp_process_step_configs"("workspace_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_demand_stages_workspace_id_uq" ON "fdp_demand_stages" ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_demand_stages_card_element_uq" ON "fdp_demand_stages" ("workspace_id", "card_id", "bpmn_element_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_stages_card_position_idx" ON "fdp_demand_stages" ("workspace_id", "card_id", "position");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_demand_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT current_setting('app.workspace_id', true) NOT NULL,
  "card_id" text NOT NULL,
  "stage_instance_id" text NOT NULL,
  "process_version_id" text NOT NULL,
  "process_step_config_id" text,
  "bpmn_element_id" text NOT NULL,
  "title" text NOT NULL,
  "instructions" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "responsibility_mode" text DEFAULT 'DEPARTMENT' NOT NULL,
  "responsible_user_id" text,
  "responsible_area_id" text,
  "started_at" timestamptz,
  "due_at" timestamptz,
  "completed_at" timestamptz,
  "completed_by" text,
  "completion_note" text DEFAULT '' NOT NULL,
  "evidence_required" integer DEFAULT 0 NOT NULL,
  "position" double precision NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_demand_tasks_status_check" CHECK ("status" IN ('pending', 'in_progress', 'completed', 'skipped', 'cancelled')),
  CONSTRAINT "fdp_demand_tasks_version_check" CHECK ("version" > 0),
  CONSTRAINT "fdp_demand_tasks_evidence_check" CHECK ("evidence_required" IN (0, 1)),
  CONSTRAINT "fdp_demand_tasks_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_demand_tasks_workspace_stage_fk" FOREIGN KEY ("workspace_id", "stage_instance_id") REFERENCES "public"."fdp_demand_stages"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_demand_tasks_workspace_version_fk" FOREIGN KEY ("workspace_id", "process_version_id") REFERENCES "public"."fdp_process_versions"("workspace_id", "id"),
  CONSTRAINT "fdp_demand_tasks_workspace_config_fk" FOREIGN KEY ("workspace_id", "process_step_config_id") REFERENCES "public"."fdp_process_step_configs"("workspace_id", "id"),
  CONSTRAINT "fdp_demand_tasks_workspace_user_fk" FOREIGN KEY ("workspace_id", "responsible_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id"),
  CONSTRAINT "fdp_demand_tasks_workspace_area_fk" FOREIGN KEY ("workspace_id", "responsible_area_id") REFERENCES "public"."fdp_areas"("workspace_id", "id"),
  CONSTRAINT "fdp_demand_tasks_workspace_completed_by_fk" FOREIGN KEY ("workspace_id", "completed_by") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_demand_tasks_workspace_id_uq" ON "fdp_demand_tasks" ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_tasks_card_status_idx" ON "fdp_demand_tasks" ("workspace_id", "card_id", "status", "position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_tasks_stage_position_idx" ON "fdp_demand_tasks" ("workspace_id", "stage_instance_id", "position");
--> statement-breakpoint

ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "task_instance_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" DROP CONSTRAINT IF EXISTS "fdp_checklist_items_workspace_task_fk";
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD CONSTRAINT "fdp_checklist_items_workspace_task_fk"
  FOREIGN KEY ("workspace_id", "task_instance_id") REFERENCES "public"."fdp_demand_tasks"("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ADD COLUMN IF NOT EXISTS "task_instance_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" DROP CONSTRAINT IF EXISTS "fdp_card_comments_workspace_task_fk";
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ADD CONSTRAINT "fdp_card_comments_workspace_task_fk"
  FOREIGN KEY ("workspace_id", "task_instance_id") REFERENCES "public"."fdp_demand_tasks"("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD COLUMN IF NOT EXISTS "task_instance_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" DROP CONSTRAINT IF EXISTS "fdp_card_attachments_workspace_task_fk";
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD CONSTRAINT "fdp_card_attachments_workspace_task_fk"
  FOREIGN KEY ("workspace_id", "task_instance_id") REFERENCES "public"."fdp_demand_tasks"("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "fdp_demand_stages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_demand_stages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_demand_stages_workspace_isolation" ON "fdp_demand_stages"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_demand_tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_demand_tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_demand_tasks_workspace_isolation" ON "fdp_demand_tasks"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

DROP TRIGGER IF EXISTS "fdp_demand_tasks_version_bump" ON "fdp_demand_tasks";
--> statement-breakpoint
CREATE TRIGGER "fdp_demand_tasks_version_bump" BEFORE UPDATE ON "fdp_demand_tasks"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();

