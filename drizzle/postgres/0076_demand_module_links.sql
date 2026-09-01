-- Demandas orquestram módulos especializados sem duplicar suas entidades (§49).
SELECT pg_advisory_xact_lock(hashtext('0076_demand_module_links'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_demand_module_links" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT current_setting('app.workspace_id', true) NOT NULL,
  "card_id" text NOT NULL,
  "module_key" text NOT NULL,
  "entity_id" text NOT NULL,
  "label" text NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_demand_module_links_module_check"
    CHECK ("module_key" IN ('competence', 'movement', 'obligation', 'benefit', 'contractor', 'epi', 'integration')),
  CONSTRAINT "fdp_demand_module_links_label_check"
    CHECK (length(trim("label")) BETWEEN 1 AND 180),
  CONSTRAINT "fdp_demand_module_links_card_fk"
    FOREIGN KEY ("workspace_id", "card_id") REFERENCES "fdp_cards"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_demand_module_links_creator_fk"
    FOREIGN KEY ("workspace_id", "created_by") REFERENCES "fdp_workspace_members"("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_demand_module_links_workspace_id_uq"
  ON "fdp_demand_module_links" ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_demand_module_links_target_uq"
  ON "fdp_demand_module_links" ("workspace_id", "card_id", "module_key", "entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_module_links_card_idx"
  ON "fdp_demand_module_links" ("workspace_id", "card_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_demand_module_links_entity_idx"
  ON "fdp_demand_module_links" ("workspace_id", "module_key", "entity_id");
--> statement-breakpoint
ALTER TABLE "fdp_demand_module_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_demand_module_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_demand_module_links_workspace_isolation" ON "fdp_demand_module_links";
--> statement-breakpoint
CREATE POLICY "fdp_demand_module_links_workspace_isolation" ON "fdp_demand_module_links"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
