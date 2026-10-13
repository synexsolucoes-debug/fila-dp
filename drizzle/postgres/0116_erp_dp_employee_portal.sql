-- ERP DP: portal do colaborador (§4.37 de docs/arquitetura-operacional.md).
--
-- Um link com segredo, como o portal do prestador e a ciência de EPI: o
-- colaborador abre sem conta, vê os holerites das folhas fechadas e as
-- férias, baixa o holerite e pede férias — o pedido entra como programação
-- para o DP aprovar. Só o hash do segredo é guardado.
SELECT pg_advisory_xact_lock(hashtext('0116_erp_dp_employee_portal'));
--> statement-breakpoint
CREATE TABLE "fdp_employee_portal_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"opened_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_employee_portal_links_opened_check" CHECK ("opened_count" >= 0),
	CONSTRAINT "fdp_employee_portal_links_revoke_check"
		CHECK (("revoked_at" IS NULL AND "revoked_by" IS NULL) OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employee_portal_links_workspace_id_uq" ON "fdp_employee_portal_links" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- O hash é único no banco inteiro: colisão de segredo é defeito.
CREATE UNIQUE INDEX "fdp_employee_portal_links_token_uq" ON "fdp_employee_portal_links" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "fdp_employee_portal_links_employee_idx" ON "fdp_employee_portal_links" USING btree ("workspace_id", "employee_id");
--> statement-breakpoint
ALTER TABLE "fdp_employee_portal_links" ADD CONSTRAINT "fdp_employee_portal_links_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_portal_links" ADD CONSTRAINT "fdp_employee_portal_links_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_portal_links" ADD CONSTRAINT "fdp_employee_portal_links_creator_fk"
  FOREIGN KEY ("workspace_id", "created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id");
--> statement-breakpoint
ALTER TABLE "fdp_employee_portal_links" ADD CONSTRAINT "fdp_employee_portal_links_revoker_fk"
  FOREIGN KEY ("workspace_id", "revoked_by") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id");
--> statement-breakpoint
ALTER TABLE "fdp_employee_portal_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employee_portal_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_employee_portal_links_workspace_isolation" ON "fdp_employee_portal_links"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
