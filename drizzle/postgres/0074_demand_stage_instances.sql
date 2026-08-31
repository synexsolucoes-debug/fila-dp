-- Instâncias persistidas de todas as etapas da demanda (§§30, 34, 40, 106, 123).
SELECT pg_advisory_xact_lock(hashtext('0074_demand_stage_instances'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_demand_stages" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
  "card_id" text NOT NULL,
  "process_version_id" text NOT NULL,
  "process_step_config_id" text,
  "bpmn_element_id" text NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "position" double precision NOT NULL,
  "responsible_area_id" text,
  "responsible_user_id" text,
  "due_at" timestamptz,
  "snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_demand_stages_status_check"
    CHECK ("status" IN ('pending', 'in_progress', 'completed', 'skipped', 'cancelled')),
  CONSTRAINT "fdp_demand_stages_version_check" CHECK ("version" > 0),
  CONSTRAINT "fdp_demand_stages_workspace_card_fk"
    FOREIGN KEY ("workspace_id", "card_id")
    REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_demand_stages_workspace_version_fk"
    FOREIGN KEY ("workspace_id", "process_version_id")
    REFERENCES "public"."fdp_process_versions"("workspace_id", "id"),
  CONSTRAINT "fdp_demand_stages_workspace_config_fk"
    FOREIGN KEY ("workspace_id", "process_step_config_id")
    REFERENCES "public"."fdp_process_step_configs"("workspace_id", "id"),
  CONSTRAINT "fdp_demand_stages_workspace_area_fk"
    FOREIGN KEY ("workspace_id", "responsible_area_id")
    REFERENCES "public"."fdp_areas"("workspace_id", "id"),
  CONSTRAINT "fdp_demand_stages_workspace_user_fk"
    FOREIGN KEY ("workspace_id", "responsible_user_id")
    REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_demand_stages_workspace_id_uq"
  ON "fdp_demand_stages" ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_demand_stages_card_element_uq"
  ON "fdp_demand_stages" ("workspace_id", "card_id", "bpmn_element_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_stages_card_position_idx"
  ON "fdp_demand_stages" ("workspace_id", "card_id", "position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_stages_workspace_status_due_idx"
  ON "fdp_demand_stages" ("workspace_id", "status", "due_at");
--> statement-breakpoint

-- Retrocompatibilidade: demandas já ligadas a processo ganham todas as etapas
-- configuradas. A etapa corrente fica em andamento; as demais, pendentes. O
-- snapshot guarda a configuração publicada que governava a demanda.
INSERT INTO "fdp_demand_stages" (
  "id", "workspace_id", "card_id", "process_version_id",
  "process_step_config_id", "bpmn_element_id", "title", "status", "position",
  "responsible_area_id", "responsible_user_id", "due_at", "snapshot_json",
  "started_at"
)
SELECT
  'stage:' || md5(c."workspace_id" || ':' || c."id" || ':' || cfg."bpmn_element_id"),
  c."workspace_id", c."id", c."process_version_id",
  cfg."id", cfg."bpmn_element_id",
  COALESCE(NULLIF(cfg."settings_json"->>'name', ''), cfg."bpmn_element_id"),
  CASE WHEN cfg."bpmn_element_id" = c."current_step_id" THEN 'in_progress' ELSE 'pending' END,
  row_number() OVER (
    PARTITION BY c."workspace_id", c."id"
    ORDER BY cfg."bpmn_element_id"
  ) * 1000,
  COALESCE(cfg."responsible_department_id", cfg."department_id"),
  cfg."responsible_user_id",
  CASE WHEN cfg."bpmn_element_id" = c."current_step_id" THEN c."due_at" ELSE NULL END,
  jsonb_build_object(
    'stepType', cfg."step_type",
    'slaValue', cfg."sla_value",
    'slaUnit', cfg."sla_unit",
    'slaBusinessDays', cfg."sla_business_days",
    'checklist', cfg."checklist_json",
    'tasks', cfg."tasks_json",
    'requiredDocuments', cfg."required_documents_json",
    'evidenceRequired', cfg."evidence_required",
    'requiresApproval', cfg."requires_approval",
    'automations', cfg."automations_json",
    'settings', cfg."settings_json"
  ),
  CASE WHEN cfg."bpmn_element_id" = c."current_step_id"
    THEN COALESCE(c."instantiated_at", c."created_at") ELSE NULL END
FROM "fdp_cards" c
JOIN "fdp_process_step_configs" cfg
  ON cfg."workspace_id" = c."workspace_id"
 AND cfg."process_version_id" = c."process_version_id"
WHERE c."process_version_id" IS NOT NULL
ON CONFLICT ("workspace_id", "card_id", "bpmn_element_id") DO NOTHING;
--> statement-breakpoint

-- Eventos finais e gateways sem configuração também precisam existir na
-- timeline quando forem a etapa corrente.
INSERT INTO "fdp_demand_stages" (
  "id", "workspace_id", "card_id", "process_version_id",
  "bpmn_element_id", "title", "status", "position", "due_at",
  "snapshot_json", "started_at"
)
SELECT
  'stage:' || md5(c."workspace_id" || ':' || c."id" || ':' || c."current_step_id"),
  c."workspace_id", c."id", c."process_version_id",
  c."current_step_id", c."current_step_id", 'in_progress', 999999,
  c."due_at", '{}'::jsonb, COALESCE(c."instantiated_at", c."created_at")
FROM "fdp_cards" c
WHERE c."process_version_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "fdp_demand_stages" s
    WHERE s."workspace_id" = c."workspace_id"
      AND s."card_id" = c."id"
      AND s."bpmn_element_id" = c."current_step_id"
  )
ON CONFLICT ("workspace_id", "card_id", "bpmn_element_id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "fdp_demand_stages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_demand_stages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_demand_stages_workspace_isolation" ON "fdp_demand_stages"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

DROP TRIGGER IF EXISTS "fdp_demand_stages_version_bump" ON "fdp_demand_stages";
--> statement-breakpoint
CREATE TRIGGER "fdp_demand_stages_version_bump"
  BEFORE UPDATE ON "fdp_demand_stages"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();
