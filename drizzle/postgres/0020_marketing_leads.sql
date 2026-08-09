-- Contatos do site comercial. Chegam antes de existir workspace, então a tabela
-- não é multi-tenant: o acesso é exclusivo da administração da plataforma.
CREATE TABLE "fdp_marketing_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"headcount" text DEFAULT '' NOT NULL,
	"interest" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"consent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_path" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	"request_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_marketing_leads_status_check" CHECK ("fdp_marketing_leads"."status" IN ('new', 'contacted', 'qualified', 'discarded')),
	CONSTRAINT "fdp_marketing_leads_interest_check" CHECK ("fdp_marketing_leads"."interest" IN ('demonstracao', 'planos', 'integracoes', 'suporte', 'outro'))
);
--> statement-breakpoint
CREATE INDEX "fdp_marketing_leads_created_idx" ON "fdp_marketing_leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "fdp_marketing_leads_status_idx" ON "fdp_marketing_leads" USING btree ("status","created_at");
--> statement-breakpoint
ALTER TABLE "fdp_marketing_leads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_marketing_leads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Nenhum workspace enxerga contatos: apenas o contexto da plataforma lê,
-- e a inserção pública acontece com o contexto de escrita do próprio site.
CREATE POLICY "fdp_marketing_leads_platform_read" ON "fdp_marketing_leads"
  FOR SELECT USING (current_setting('app.platform_admin', true) = 'true');
--> statement-breakpoint
CREATE POLICY "fdp_marketing_leads_public_insert" ON "fdp_marketing_leads"
  FOR INSERT WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "fdp_marketing_leads_platform_update" ON "fdp_marketing_leads"
  FOR UPDATE USING (current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.platform_admin', true) = 'true');
