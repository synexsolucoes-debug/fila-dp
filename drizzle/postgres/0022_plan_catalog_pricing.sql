-- Catálogo comercial do Vinculato: preços de lançamento e histórico de preço.
--
-- Migration aditiva. Nenhuma tabela é removida e nenhuma linha existente é
-- apagada: os planos já cadastrados são atualizados no lugar e passam a ter
-- uma versão de preço registrada.
CREATE TABLE "fdp_saas_plan_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"currency" text DEFAULT 'brl' NOT NULL,
	"monthly_price_cents" integer DEFAULT 0 NOT NULL,
	"annual_price_cents" integer DEFAULT 0 NOT NULL,
	"included_seats" integer DEFAULT 1 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_saas_plan_prices_amount_check" CHECK ("fdp_saas_plan_prices"."monthly_price_cents" >= 0 AND "fdp_saas_plan_prices"."annual_price_cents" >= 0),
	CONSTRAINT "fdp_saas_plan_prices_seats_check" CHECK ("fdp_saas_plan_prices"."included_seats" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_saas_plan_prices_plan_effective_uq" ON "fdp_saas_plan_prices" USING btree ("plan_id","effective_from");--> statement-breakpoint
CREATE INDEX "fdp_saas_plan_prices_plan_idx" ON "fdp_saas_plan_prices" USING btree ("plan_id","effective_from" DESC);
--> statement-breakpoint
ALTER TABLE "fdp_saas_plan_prices" ADD CONSTRAINT "fdp_saas_plan_prices_plan_id_fdp_saas_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."fdp_saas_plans"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- A assinatura guarda em qual versão de preço foi contratada. Sem isso, mexer
-- na tabela de preços mudaria silenciosamente o valor de contratos antigos.
ALTER TABLE "fdp_workspace_subscriptions" ADD COLUMN IF NOT EXISTS "plan_price_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_subscriptions" ADD COLUMN IF NOT EXISTS "contracted_monthly_price_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_subscriptions" ADD CONSTRAINT "fdp_workspace_subscriptions_plan_price_fk" FOREIGN KEY ("plan_price_id") REFERENCES "public"."fdp_saas_plan_prices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_saas_plan_prices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_saas_plan_prices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Preço publicado é informação comercial: qualquer sessão autenticada lê, só a
-- administração da plataforma escreve.
CREATE POLICY "fdp_saas_plan_prices_read" ON "fdp_saas_plan_prices" FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY "fdp_saas_plan_prices_write" ON "fdp_saas_plan_prices" FOR INSERT
  WITH CHECK (current_setting('app.platform_admin', true) = 'true');
--> statement-breakpoint
-- Histórico de preço é append-only: correção entra como nova versão.
CREATE OR REPLACE FUNCTION "fdp_saas_plan_prices_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'plan prices are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_saas_plan_prices_append_only"
BEFORE UPDATE OR DELETE ON "fdp_saas_plan_prices"
FOR EACH ROW EXECUTE FUNCTION "fdp_saas_plan_prices_append_only"();
--> statement-breakpoint
-- Preços de lançamento do Vinculato, em centavos.
--   Starter    R$   0,00 —   3 assentos
--   Standard   R$  97,00 —  10 assentos
--   Premium    R$ 297,00 —  30 assentos
--   Enterprise R$ 797,00 — 100 assentos
UPDATE "fdp_saas_plans" SET
  "name" = 'Starter', "description" = 'Para conhecer a plataforma e organizar um primeiro processo.',
  "status" = 'active', "currency" = 'brl', "monthly_price_cents" = 0, "annual_price_cents" = 0,
  "included_seats" = 3, "position" = 1, "updated_at" = now()
WHERE "code" = 'starter';
--> statement-breakpoint
UPDATE "fdp_saas_plans" SET
  "name" = 'Standard', "description" = 'Para equipes pequenas de Departamento Pessoal.',
  "status" = 'active', "currency" = 'brl', "monthly_price_cents" = 9700, "annual_price_cents" = 0,
  "included_seats" = 10, "position" = 2, "updated_at" = now()
WHERE "code" = 'standard';
--> statement-breakpoint
UPDATE "fdp_saas_plans" SET
  "name" = 'Premium', "description" = 'Para equipes médias que precisam de volume, integrações e automações.',
  "status" = 'active', "currency" = 'brl', "monthly_price_cents" = 29700, "annual_price_cents" = 0,
  "included_seats" = 30, "position" = 3, "updated_at" = now()
WHERE "code" = 'premium';
--> statement-breakpoint
UPDATE "fdp_saas_plans" SET
  "name" = 'Enterprise', "description" = 'Para operações grandes, com mais controle, permissões e capacidade.',
  "status" = 'active', "currency" = 'brl', "monthly_price_cents" = 79700, "annual_price_cents" = 0,
  "included_seats" = 100, "position" = 4, "updated_at" = now()
WHERE "code" = 'enterprise';
--> statement-breakpoint
-- Versão inicial de preço para cada plano do catálogo.
INSERT INTO "fdp_saas_plan_prices" ("id", "plan_id", "currency", "monthly_price_cents", "annual_price_cents", "included_seats", "note", "created_by")
SELECT 'price_launch_' || "code", "id", "currency", "monthly_price_cents", "annual_price_cents", "included_seats",
  'Preço de lançamento do Vinculato', 'migration'
FROM "fdp_saas_plans"
WHERE "code" IN ('starter', 'standard', 'premium', 'enterprise')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Assinaturas existentes ficam presas à versão de preço vigente hoje.
UPDATE "fdp_workspace_subscriptions" s SET
  "plan_price_id" = p."id",
  "contracted_monthly_price_cents" = p."monthly_price_cents"
FROM "fdp_saas_plan_prices" p
WHERE p."plan_id" = s."plan_id" AND s."plan_price_id" IS NULL;
