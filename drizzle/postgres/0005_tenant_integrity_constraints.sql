DROP INDEX IF EXISTS "fdp_workspaces_owner_uq";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_workspaces_owner_idx" ON "fdp_workspaces" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_companies_workspace_id_uq" ON "fdp_companies" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_boards_workspace_id_uq" ON "fdp_boards" USING btree ("workspace_id", "id");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "fdp_companies" child
    LEFT JOIN "fdp_companies" parent
      ON parent."id" = child."parent_company_id"
    WHERE child."parent_company_id" IS NOT NULL
      AND (parent."id" IS NULL OR parent."workspace_id" <> child."workspace_id")
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_companies.parent_company_id';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "fdp_member_company_access" access
    LEFT JOIN "fdp_workspace_members" member
      ON member."workspace_id" = access."workspace_id"
     AND member."user_id" = access."user_id"
    LEFT JOIN "fdp_companies" company
      ON company."workspace_id" = access."workspace_id"
     AND company."id" = access."company_id"
    WHERE member."user_id" IS NULL OR company."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_member_company_access';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "fdp_hr_metrics" metrics
    LEFT JOIN "fdp_companies" company
      ON company."workspace_id" = metrics."workspace_id"
     AND company."id" = metrics."company_id"
    WHERE company."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_hr_metrics.company_id';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD CONSTRAINT "fdp_companies_workspace_parent_fk"
  FOREIGN KEY ("workspace_id", "parent_company_id")
  REFERENCES "public"."fdp_companies"("workspace_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "fdp_member_company_access" ADD CONSTRAINT "fdp_member_company_access_member_fk"
  FOREIGN KEY ("workspace_id", "user_id")
  REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "fdp_member_company_access" ADD CONSTRAINT "fdp_member_company_access_company_fk"
  FOREIGN KEY ("workspace_id", "company_id")
  REFERENCES "public"."fdp_companies"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "fdp_hr_metrics" ADD CONSTRAINT "fdp_hr_metrics_workspace_company_fk"
  FOREIGN KEY ("workspace_id", "company_id")
  REFERENCES "public"."fdp_companies"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
