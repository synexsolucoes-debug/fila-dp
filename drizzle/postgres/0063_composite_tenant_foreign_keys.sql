-- Fecha a última fresta de tenant no nível do banco (§87).
--
-- O produto já impede o cruzamento entre clientes em três camadas: a aplicação
-- filtra por workspace, a RLS recusa a linha, e a maior parte das chaves
-- estrangeiras é **composta** — `(workspace_id, id)` —, o que torna a
-- combinação impossível de gravar.
--
-- A verificação final encontrou treze chaves que ficaram fora desse desenho.
-- São chaves de coluna única para tabelas que **têm** `workspace_id`, e sem uma
-- irmã composta ao lado. Na prática, o banco aceitaria uma linha de um cliente
-- apontando para o registro de outro; leitura continuaria bloqueada pela RLS,
-- mas a garantia estrutural não estava lá.
--
-- Nenhuma delas nasceu nesta consolidação: as chaves criadas aqui — demanda para
-- definição e versão de processo, proposta de agente para demanda — já são
-- compostas. Estas treze são anteriores, e fechá-las é o que permite afirmar
-- "nenhuma FK cruza tenant" sem asterisco.
--
-- Três tabelas-pai ainda não tinham a chave única `(workspace_id, id)` que uma
-- chave composta exige; como `id` já é primária, o par é trivialmente único e o
-- índice é aditivo.
--
-- O preflight recusa em vez de corrigir. Se existir linha inconsistente, a
-- migration para e diz quantas são: reatribuir workspace de dado de cliente por
-- palpite é exatamente o que §69 e §84 proíbem.
SELECT pg_advisory_xact_lock(hashtext('0063_composite_tenant_foreign_keys'));
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fdp_assistant_conversations_ws_key_uq" ON "fdp_assistant_conversations" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_fixed_items_ws_key_uq" ON "fdp_contractor_fixed_items" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_profiles_ws_key_uq" ON "fdp_contractor_profiles" USING btree ("workspace_id", "provider_id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_assistant_messages" f JOIN "fdp_assistant_conversations" p ON p."id" = f."conversation_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_assistant_messages apontando fdp_assistant_conversations de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_assistant_messages" DROP CONSTRAINT IF EXISTS "fdp_assistant_messages_ws_conversation_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_assistant_messages" ADD CONSTRAINT "fdp_assistant_messages_ws_conversation_id_fk"
  FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "public"."fdp_assistant_conversations"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_cards" f JOIN "fdp_boards" p ON p."id" = f."board_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_cards apontando fdp_boards de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_ws_board_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_ws_board_id_fk"
  FOREIGN KEY ("workspace_id", "board_id") REFERENCES "public"."fdp_boards"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_contractor_components" f JOIN "fdp_contractor_fixed_items" p ON p."id" = f."fixed_item_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_contractor_components apontando fdp_contractor_fixed_items de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" DROP CONSTRAINT IF EXISTS "fdp_contractor_components_ws_fixed_item_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_ws_fixed_item_id_fk"
  FOREIGN KEY ("workspace_id", "fixed_item_id") REFERENCES "public"."fdp_contractor_fixed_items"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_contractor_fixed_items" f JOIN "fdp_contractor_profiles" p ON p."provider_id" = f."provider_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_contractor_fixed_items apontando fdp_contractor_profiles de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_fixed_items" DROP CONSTRAINT IF EXISTS "fdp_contractor_fixed_items_ws_provider_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_fixed_items" ADD CONSTRAINT "fdp_contractor_fixed_items_ws_provider_id_fk"
  FOREIGN KEY ("workspace_id", "provider_id") REFERENCES "public"."fdp_contractor_profiles"("workspace_id", "provider_id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_contractor_movements" f JOIN "fdp_contractor_profiles" p ON p."provider_id" = f."provider_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_contractor_movements apontando fdp_contractor_profiles de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_movements" DROP CONSTRAINT IF EXISTS "fdp_contractor_movements_ws_provider_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_movements" ADD CONSTRAINT "fdp_contractor_movements_ws_provider_id_fk"
  FOREIGN KEY ("workspace_id", "provider_id") REFERENCES "public"."fdp_contractor_profiles"("workspace_id", "provider_id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_integration_jobs" f JOIN "fdp_integrations" p ON p."id" = f."integration_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_integration_jobs apontando fdp_integrations de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" DROP CONSTRAINT IF EXISTS "fdp_integration_jobs_ws_integration_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" ADD CONSTRAINT "fdp_integration_jobs_ws_integration_id_fk"
  FOREIGN KEY ("workspace_id", "integration_id") REFERENCES "public"."fdp_integrations"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_integration_reconciliations" f JOIN "fdp_integrations" p ON p."id" = f."integration_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_integration_reconciliations apontando fdp_integrations de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" DROP CONSTRAINT IF EXISTS "fdp_integration_reconciliations_ws_integration_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ADD CONSTRAINT "fdp_integration_reconciliations_ws_integration_id_fk"
  FOREIGN KEY ("workspace_id", "integration_id") REFERENCES "public"."fdp_integrations"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_integration_run_logs" f JOIN "fdp_integrations" p ON p."id" = f."integration_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_integration_run_logs apontando fdp_integrations de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_integration_run_logs" DROP CONSTRAINT IF EXISTS "fdp_integration_run_logs_ws_integration_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_integration_run_logs" ADD CONSTRAINT "fdp_integration_run_logs_ws_integration_id_fk"
  FOREIGN KEY ("workspace_id", "integration_id") REFERENCES "public"."fdp_integrations"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_integration_sync_items" f JOIN "fdp_integrations" p ON p."id" = f."integration_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_integration_sync_items apontando fdp_integrations de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" DROP CONSTRAINT IF EXISTS "fdp_integration_sync_items_ws_integration_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" ADD CONSTRAINT "fdp_integration_sync_items_ws_integration_id_fk"
  FOREIGN KEY ("workspace_id", "integration_id") REFERENCES "public"."fdp_integrations"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_movement_suggestions" f JOIN "fdp_integration_events" p ON p."id" = f."event_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_movement_suggestions apontando fdp_integration_events de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions" DROP CONSTRAINT IF EXISTS "fdp_movement_suggestions_ws_event_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions" ADD CONSTRAINT "fdp_movement_suggestions_ws_event_id_fk"
  FOREIGN KEY ("workspace_id", "event_id") REFERENCES "public"."fdp_integration_events"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_payroll_cycle_items" f JOIN "fdp_companies" p ON p."id" = f."company_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_payroll_cycle_items apontando fdp_companies de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" DROP CONSTRAINT IF EXISTS "fdp_payroll_cycle_items_ws_company_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_payroll_cycle_items" ADD CONSTRAINT "fdp_payroll_cycle_items_ws_company_id_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_time_exports" f JOIN "fdp_companies" p ON p."id" = f."company_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_time_exports apontando fdp_companies de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_time_exports" DROP CONSTRAINT IF EXISTS "fdp_time_exports_ws_company_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_time_exports" ADD CONSTRAINT "fdp_time_exports_ws_company_id_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");
--> statement-breakpoint
DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora
    FROM "fdp_time_sheets" f JOIN "fdp_companies" p ON p."id" = f."company_id"
   WHERE p."workspace_id" IS DISTINCT FROM f."workspace_id";
  IF fora > 0 THEN
    RAISE EXCEPTION 'Existem % linhas em fdp_time_sheets apontando fdp_companies de outro grupo. Corrija antes de aplicar.', fora;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" DROP CONSTRAINT IF EXISTS "fdp_time_sheets_ws_company_id_fk";
--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_ws_company_id_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");