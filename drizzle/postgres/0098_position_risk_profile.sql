-- Cargo rico, passo 1: risco e atividades especiais ao lado do CBO que já
-- existe (0013_registrations_foundation.sql). A análise de produto de
-- set/2026 nomeou isto como base da Matriz de Requisitos e do módulo de
-- SESMT — sem saber o grau de risco e as atividades especiais de um cargo,
-- não há como decidir depois quais exames ocupacionais ou treinamentos ele
-- exige.
--
-- Os dois campos entram exatamente como o cadastro de cargo já funciona: sem
-- taxonomia fixa nem regra automática — quem cadastra descreve o cargo, o
-- mesmo tratamento que o próprio CBO já recebe. `risk_level` é uma
-- classificação simples ("nenhum"/"baixo"/"médio"/"alto"), não o grau de
-- risco 1-4 da NR-4, que é por CNAE da empresa, não por cargo.
SELECT pg_advisory_xact_lock(hashtext('0098_position_risk_profile'));
--> statement-breakpoint

ALTER TABLE "fdp_positions" ADD COLUMN IF NOT EXISTS "risk_level" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_positions" ADD COLUMN IF NOT EXISTS "special_activities" text DEFAULT '' NOT NULL;
--> statement-breakpoint

ALTER TABLE "fdp_positions" ADD CONSTRAINT "fdp_positions_risk_level_check"
  CHECK ("risk_level" IN ('none', 'low', 'medium', 'high'));
