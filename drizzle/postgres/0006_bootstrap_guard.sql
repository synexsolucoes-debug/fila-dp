CREATE TABLE "fdp_bootstrap_guard" (
	"id" integer PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_bootstrap_guard_singleton_ck" CHECK ("id" = 1)
);
--> statement-breakpoint
ALTER TABLE "fdp_bootstrap_guard" ADD CONSTRAINT "fdp_bootstrap_guard_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
--> statement-breakpoint
INSERT INTO "fdp_bootstrap_guard" ("id", "workspace_id")
SELECT 1, "id" FROM "fdp_workspaces" ORDER BY "id" LIMIT 1
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "fdp_bootstrap_guard" ("id")
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM "fdp_bootstrap_guard")
ON CONFLICT ("id") DO NOTHING;
