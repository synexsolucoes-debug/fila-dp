-- Tarefas operacionais de uma demanda são instâncias próprias: a lista de
-- conferência continua simples, mas uma tarefa pode ter responsável, prazo,
-- evidência e histórico de conclusão independentes.
SELECT pg_advisory_xact_lock(hashtext('0079_demand_task_instances'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_demand_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
  "card_id" text NOT NULL,
  "stage_instance_id" text NOT NULL,
  "process_version_id" text NOT NULL,
  "bpmn_element_id" text NOT NULL,
  "title" text NOT NULL,
  "instructions" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'in_progress',
  "responsibility_mode" text NOT NULL DEFAULT 'INHERIT',
  "responsible_user_id" text,
  "responsible_area_id" text,
  "started_at" timestamptz,
  "due_at" timestamptz,
  "completed_at" timestamptz,
  "completed_by" text,
  "completion_note" text NOT NULL DEFAULT '',
  "evidence_required" integer NOT NULL DEFAULT 0,
  "position" double precision NOT NULL DEFAULT 1000,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "fdp_demand_tasks_status_check"
    CHECK ("status" IN ('pending', 'in_progress', 'completed', 'skipped', 'cancelled')),
  CONSTRAINT "fdp_demand_tasks_version_check" CHECK ("version" > 0),
  CONSTRAINT "fdp_demand_tasks_evidence_required_check" CHECK ("evidence_required" IN (0, 1)),
  CONSTRAINT "fdp_demand_tasks_workspace_card_fk"
    FOREIGN KEY ("workspace_id", "card_id")
    REFERENCES "public"."fdp_cards" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_demand_tasks_workspace_stage_fk"
    FOREIGN KEY ("workspace_id", "stage_instance_id")
    REFERENCES "public"."fdp_demand_stages" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_demand_tasks_workspace_version_fk"
    FOREIGN KEY ("workspace_id", "process_version_id")
    REFERENCES "public"."fdp_process_versions" ("workspace_id", "id"),
  CONSTRAINT "fdp_demand_tasks_workspace_area_fk"
    FOREIGN KEY ("workspace_id", "responsible_area_id")
    REFERENCES "public"."fdp_areas" ("workspace_id", "id"),
  CONSTRAINT "fdp_demand_tasks_workspace_user_fk"
    FOREIGN KEY ("workspace_id", "responsible_user_id")
    REFERENCES "public"."fdp_workspace_members" ("workspace_id", "user_id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fdp_demand_tasks_workspace_id_uq"
  ON "fdp_demand_tasks" ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_tasks_card_stage_position_idx"
  ON "fdp_demand_tasks" ("workspace_id", "card_id", "stage_instance_id", "position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_tasks_open_due_idx"
  ON "fdp_demand_tasks" ("workspace_id", "responsible_user_id", "due_at")
  WHERE "status" IN ('pending', 'in_progress') AND "due_at" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "fdp_card_comments" ADD COLUMN IF NOT EXISTS "task_instance_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "task_instance_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD COLUMN IF NOT EXISTS "task_instance_id" text;
--> statement-breakpoint

ALTER TABLE "fdp_card_comments" DROP CONSTRAINT IF EXISTS "fdp_card_comments_task_instance_fk";
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ADD CONSTRAINT "fdp_card_comments_task_instance_fk"
  FOREIGN KEY ("workspace_id", "task_instance_id")
  REFERENCES "public"."fdp_demand_tasks" ("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" DROP CONSTRAINT IF EXISTS "fdp_checklist_items_task_instance_fk";
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD CONSTRAINT "fdp_checklist_items_task_instance_fk"
  FOREIGN KEY ("workspace_id", "task_instance_id")
  REFERENCES "public"."fdp_demand_tasks" ("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" DROP CONSTRAINT IF EXISTS "fdp_card_attachments_task_instance_fk";
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD CONSTRAINT "fdp_card_attachments_task_instance_fk"
  FOREIGN KEY ("workspace_id", "task_instance_id")
  REFERENCES "public"."fdp_demand_tasks" ("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fdp_card_comments_task_instance_idx"
  ON "fdp_card_comments" ("workspace_id", "task_instance_id", "created_at")
  WHERE "task_instance_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_checklist_items_task_instance_idx"
  ON "fdp_checklist_items" ("workspace_id", "task_instance_id")
  WHERE "task_instance_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_attachments_task_instance_idx"
  ON "fdp_card_attachments" ("workspace_id", "card_id", "task_instance_id")
  WHERE "task_instance_id" IS NOT NULL;
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
CREATE TRIGGER "fdp_demand_tasks_version_bump"
  BEFORE UPDATE ON "fdp_demand_tasks"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();
