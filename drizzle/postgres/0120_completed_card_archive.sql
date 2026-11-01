-- Demandas concluídas saem do quadro sozinhas.
--
-- A coluna "Concluído" crescia para sempre: o quadro é lido o dia inteiro, e
-- uma coluna com centenas de cartões terminados empurra o que está em curso
-- para fora da tela. Depois de alguns dias (7 por padrão, ajustável por grupo
-- e 0 para nunca), a demanda concluída ou cancelada vai para o Arquivo, de
-- onde pode ser restaurada. Nada é apagado.
--
-- `archived_at` diz quando saiu do quadro; serve ao Arquivo e à auditoria.
SELECT pg_advisory_xact_lock(hashtext('0120_completed_card_archive'));
--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings" ADD COLUMN IF NOT EXISTS "completed_archive_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_cards_open_closed_idx" ON "fdp_cards" ("workspace_id", "closed_at") WHERE "archived" = 0;
