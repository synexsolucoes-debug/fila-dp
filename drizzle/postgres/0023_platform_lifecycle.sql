-- Ciclo de vida administrado pela plataforma: suspender workspace e bloquear usuário.
--
-- Migration aditiva. Sem estas colunas não existe como representar "workspace
-- suspenso" nem "usuário bloqueado" — e, sem representação, o console global só
-- podia listar, nunca administrar.
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "status_reason" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "legal_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "tax_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "contact_email" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD CONSTRAINT "fdp_workspaces_status_check"
  CHECK ("status" IN ('active', 'suspended', 'canceled', 'archived'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_workspaces_status_idx" ON "fdp_workspaces" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "fdp_users" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_users" ADD COLUMN IF NOT EXISTS "status_reason" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_users" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fdp_users" ADD CONSTRAINT "fdp_users_status_check"
  CHECK ("status" IN ('active', 'blocked'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_users_status_idx" ON "fdp_users" USING btree ("status");
--> statement-breakpoint
-- Suspender e bloquear exigem motivo registrado: um acesso cortado sem
-- explicação é indefensável para quem paga e para quem audita.
ALTER TABLE "fdp_workspaces" ADD CONSTRAINT "fdp_workspaces_status_reason_check"
  CHECK ("status" = 'active' OR length("status_reason") >= 5);
--> statement-breakpoint
ALTER TABLE "fdp_users" ADD CONSTRAINT "fdp_users_status_reason_check"
  CHECK ("status" = 'active' OR length("status_reason") >= 5);
