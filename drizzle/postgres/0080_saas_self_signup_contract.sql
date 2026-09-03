-- Contrato comercial inicial e fundação segura do autocadastro Starter.
--
-- A migration é aditiva e pode ser reaplicada com segurança: DDL usa
-- IF NOT EXISTS, versões financeiras são append-only e os seeds têm chaves
-- estáveis. Assinaturas existentes permanecem presas à versão de preço já
-- contratada.
SELECT pg_advisory_xact_lock(hashtext('0080_saas_self_signup_contract'));
--> statement-breakpoint
SELECT set_config('app.platform_admin', 'true', true);
--> statement-breakpoint

ALTER TABLE "fdp_saas_plans" ADD COLUMN IF NOT EXISTS "checkout_enabled" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_saas_plans" ADD COLUMN IF NOT EXISTS "custom_limits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fdp_saas_plans_checkout_enabled_check') THEN
    ALTER TABLE "fdp_saas_plans" ADD CONSTRAINT "fdp_saas_plans_checkout_enabled_check"
      CHECK ("checkout_enabled" IN (0, 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fdp_saas_plans_custom_limits_check') THEN
    ALTER TABLE "fdp_saas_plans" ADD CONSTRAINT "fdp_saas_plans_custom_limits_check"
      CHECK ("custom_limits" IN (0, 1));
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "fdp_users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "fdp_workspace_subscriptions" ADD COLUMN IF NOT EXISTS "contracted_price_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_subscriptions" ADD COLUMN IF NOT EXISTS "contracted_currency" text DEFAULT 'brl' NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fdp_workspace_subscriptions_contracted_price_check') THEN
    ALTER TABLE "fdp_workspace_subscriptions" ADD CONSTRAINT "fdp_workspace_subscriptions_contracted_price_check"
      CHECK ("contracted_price_cents" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fdp_workspace_subscriptions_contracted_currency_check') THEN
    ALTER TABLE "fdp_workspace_subscriptions" ADD CONSTRAINT "fdp_workspace_subscriptions_contracted_currency_check"
      CHECK ("contracted_currency" ~ '^[a-z]{3}$');
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_signup_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "name" text NOT NULL,
  "password_hash" text NOT NULL,
  "password_salt" text NOT NULL,
  "workspace_name" text NOT NULL,
  "workspace_slug" text NOT NULL,
  "provisioned_user_id" text NOT NULL,
  "provisioned_workspace_id" text NOT NULL,
  "provisioned_board_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_expires_at" timestamptz NOT NULL,
  "terms_version" text NOT NULL,
  "privacy_version" text NOT NULL,
  "terms_accepted_at" timestamptz NOT NULL,
  "privacy_accepted_at" timestamptz NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "confirmation_nonce" text DEFAULT '' NOT NULL,
  "used_at" timestamptz,
  "request_fingerprint" text DEFAULT '' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_signup_requests_status_check" CHECK ("status" IN ('pending', 'confirmed', 'canceled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_signup_requests_email_uq" ON "fdp_signup_requests" ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_signup_requests_token_hash_uq" ON "fdp_signup_requests" ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_signup_requests_workspace_uq" ON "fdp_signup_requests" ("provisioned_workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_signup_requests_pending_expiry_idx"
  ON "fdp_signup_requests" ("token_expires_at") WHERE "status" = 'pending';
--> statement-breakpoint

-- Uma identidade pode ocupar esta tabela somente uma vez como proprietária de
-- Starter. Participar de workspaces por convite não cria linha aqui.
CREATE TABLE IF NOT EXISTS "fdp_starter_owners" (
  "user_id" text PRIMARY KEY NOT NULL,
  "owned_workspace_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_starter_owners_user_fk" FOREIGN KEY ("user_id")
    REFERENCES "public"."fdp_users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "fdp_starter_owners_workspace_fk" FOREIGN KEY ("owned_workspace_id")
    REFERENCES "public"."fdp_workspaces" ("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_starter_owners_workspace_uq" ON "fdp_starter_owners" ("owned_workspace_id");
--> statement-breakpoint

-- O contrato comercial vive no catálogo persistido, não nas páginas.
UPDATE "fdp_saas_plans" SET
  "name" = 'Starter', "status" = 'active', "currency" = 'brl',
  "monthly_price_cents" = 0, "annual_price_cents" = 0, "trial_days" = 0,
  "included_seats" = 3, "company_limit" = 1, "integration_limit" = 1,
  "storage_limit_mb" = 1024, "checkout_enabled" = 1, "custom_limits" = 0,
  "position" = 1, "updated_at" = now()
WHERE "code" = 'starter';
--> statement-breakpoint
UPDATE "fdp_saas_plans" SET
  "name" = 'Standard', "status" = 'active', "currency" = 'brl',
  "monthly_price_cents" = 9700, "annual_price_cents" = 0, "trial_days" = 0,
  "included_seats" = 10, "company_limit" = 5, "integration_limit" = 3,
  "storage_limit_mb" = 5120, "checkout_enabled" = 1, "custom_limits" = 0,
  "position" = 2, "updated_at" = now()
WHERE "code" = 'standard';
--> statement-breakpoint
UPDATE "fdp_saas_plans" SET
  "name" = 'Premium', "status" = 'active', "currency" = 'brl',
  "monthly_price_cents" = 29700, "annual_price_cents" = 0, "trial_days" = 0,
  "included_seats" = 30, "company_limit" = 20, "integration_limit" = 10,
  "storage_limit_mb" = 20480, "checkout_enabled" = 1, "custom_limits" = 0,
  "position" = 3, "updated_at" = now()
WHERE "code" = 'premium';
--> statement-breakpoint
UPDATE "fdp_saas_plans" SET
  "name" = 'Enterprise', "description" = 'Contrato e limites personalizados, sob consulta.',
  "status" = 'active', "currency" = 'brl', "monthly_price_cents" = 0,
  "annual_price_cents" = 0, "trial_days" = 0, "checkout_enabled" = 0,
  "custom_limits" = 1, "stripe_monthly_price_id" = '', "stripe_annual_price_id" = '',
  "position" = 4, "updated_at" = now()
WHERE "code" = 'enterprise';
--> statement-breakpoint

-- A quantidade de integrações só vira entitlement se o módulo correspondente
-- também estiver no plano. O catálogo anterior anunciava 1/3 integrações em
-- Starter/Standard, mas não liberava a área que permite configurá-las.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT plan."id", 'integrations'
FROM "fdp_saas_plans" plan
WHERE plan."code" IN ('starter', 'standard')
  AND EXISTS (SELECT 1 FROM "fdp_modules" module_catalog WHERE module_catalog."key" = 'integrations')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Nova versão do preço aprovado. Não atualiza plan_price_id de contratos
-- existentes; apenas novas contratações apontam para esta versão.
INSERT INTO "fdp_saas_plan_prices"
  ("id", "plan_id", "currency", "monthly_price_cents", "annual_price_cents", "included_seats", "effective_from", "note", "created_by")
SELECT 'price_saas_contract_v1_' || p."code", p."id", 'brl',
  CASE p."code" WHEN 'standard' THEN 9700 WHEN 'premium' THEN 29700 ELSE 0 END,
  0,
  CASE p."code" WHEN 'starter' THEN 3 WHEN 'standard' THEN 10 WHEN 'premium' THEN 30 ELSE p."included_seats" END,
  now(), 'Contrato SaaS inicial aprovado', 'migration'
FROM "fdp_saas_plans" p
WHERE p."code" IN ('starter', 'standard', 'premium', 'enterprise')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Preserva o valor dos contratos atuais também no campo neutro por intervalo.
DO $$
DECLARE subscription_row record;
BEGIN
  FOR subscription_row IN
    SELECT "workspace_id" FROM "fdp_workspace_subscriptions"
    WHERE "contracted_price_cents" = 0 AND "contracted_monthly_price_cents" > 0
  LOOP
    PERFORM set_config('app.workspace_id', subscription_row."workspace_id", true);
    UPDATE "fdp_workspace_subscriptions"
    SET "contracted_price_cents" = "contracted_monthly_price_cents",
        "contracted_currency" = 'brl'
    WHERE "workspace_id" = subscription_row."workspace_id"
      AND "contracted_price_cents" = 0;
  END LOOP;
END $$;
--> statement-breakpoint

-- Contas já existentes com propriedade Starter entram no guard antiabuso.
INSERT INTO "fdp_starter_owners" ("user_id", "owned_workspace_id")
SELECT w."owner_user_id", w."id"
FROM "fdp_workspaces" w
JOIN "fdp_workspace_subscriptions" s ON s."workspace_id" = w."id"
JOIN "fdp_saas_plans" p ON p."id" = s."plan_id" AND p."code" = 'starter'
WHERE w."status" = 'active' AND s."status" IN ('trialing', 'active')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- A trilha global de autenticação passa a reconhecer o cadastro sem registrar
-- senha ou token. O trigger append-only e a política de leitura permanecem.
ALTER TABLE "fdp_auth_events" DROP CONSTRAINT IF EXISTS "fdp_auth_events_action_check";
--> statement-breakpoint
ALTER TABLE "fdp_auth_events" ADD CONSTRAINT "fdp_auth_events_action_check"
  CHECK ("action" IN ('login', 'logout', 'password_reset', 'session_revoked',
    'signup_requested', 'signup_confirmed', 'signup_confirmation_resent'));
