CREATE TABLE "fdp_audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "actor_type" text DEFAULT 'user' NOT NULL,
  "actor_user_id" text,
  "actor_email" text NOT NULL,
  "action" text NOT NULL,
  "outcome" text DEFAULT 'success' NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "before_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "after_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "request_id" text,
  "ip_hash" text,
  "user_agent_hash" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_audit_events_actor_type_check" CHECK ("actor_type" IN ('user', 'system', 'integration')),
  CONSTRAINT "fdp_audit_events_outcome_check" CHECK ("outcome" IN ('success', 'denied', 'failure')),
  CONSTRAINT "fdp_audit_events_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE RESTRICT,
  CONSTRAINT "fdp_audit_events_actor_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."fdp_users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX "fdp_audit_workspace_created_idx" ON "fdp_audit_events" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX "fdp_audit_workspace_entity_idx" ON "fdp_audit_events" USING btree ("workspace_id", "entity_type", "entity_id");
--> statement-breakpoint
CREATE INDEX "fdp_audit_workspace_actor_idx" ON "fdp_audit_events" USING btree ("workspace_id", "actor_user_id", "created_at");
--> statement-breakpoint
ALTER TABLE "fdp_audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_audit_events_workspace_isolation" ON "fdp_audit_events"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_prevent_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.audit_maintenance', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'fdp_audit_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_audit_events_append_only"
BEFORE UPDATE OR DELETE ON "fdp_audit_events"
FOR EACH ROW EXECUTE FUNCTION "fdp_prevent_audit_mutation"();
