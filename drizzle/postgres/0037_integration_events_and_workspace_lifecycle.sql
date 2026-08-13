-- Central de eventos de integração, movimentações pendentes de validação e o
-- ciclo de vida completo do workspace (arquivar / restaurar / excluir).
--
-- Três problemas motivam esta migration:
--
-- 1. A idempotência das integrações estava espalhada: cada conector inventava a
--    sua chave em `fdp_integration_sync_runs.idempotency_key`. Não havia um
--    lugar único para responder "este evento externo já foi processado?", que é
--    exatamente a pergunta que impede demanda duplicada.
-- 2. O Teams só sabia virar item de caixa de entrada. Para reconhecer
--    movimentação sem abrir demanda errada é preciso um estado intermediário —
--    a sugestão, que o usuário confirma ou rejeita.
-- 3. Excluir grupo só existia no console da plataforma e era definitivo. Faltava
--    o passo reversível, com prazo, que o dono do grupo pode acionar.

CREATE TABLE IF NOT EXISTS "fdp_integration_events" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "connector" text NOT NULL,
  "event_type" text NOT NULL,
  -- Identificador do evento no sistema de origem. É a metade da chave de
  -- idempotência; a outra metade é o par workspace+integração, para que o mesmo
  -- id vindo de dois clientes nunca colida.
  "external_event_id" text NOT NULL,
  "source" text DEFAULT 'webhook' NOT NULL,
  "payload_hash" text DEFAULT '' NOT NULL,
  "payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "result_type" text DEFAULT '' NOT NULL,
  "result_id" text DEFAULT '' NOT NULL,
  "error_code" text DEFAULT '' NOT NULL,
  "error_message" text DEFAULT '' NOT NULL,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fdp_movement_suggestions" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "event_id" text NOT NULL,
  "movement_kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  -- 0..100 em inteiro: a nota da interpretação, guardada para que a revisão
  -- humana saiba o quanto o sistema confiou no que leu.
  "confidence" integer DEFAULT 0 NOT NULL,
  "employee_name" text DEFAULT '' NOT NULL,
  "employee_id" text,
  "previous_salary_cents" bigint,
  "new_salary_cents" bigint,
  "previous_role" text DEFAULT '' NOT NULL,
  "new_role" text DEFAULT '' NOT NULL,
  "effective_date" date,
  "requested_by_name" text DEFAULT '' NOT NULL,
  "team_id" text DEFAULT '' NOT NULL,
  "team_name" text DEFAULT '' NOT NULL,
  "channel_id" text DEFAULT '' NOT NULL,
  "channel_name" text DEFAULT '' NOT NULL,
  "message_id" text DEFAULT '' NOT NULL,
  "message_url" text DEFAULT '' NOT NULL,
  "original_message" text DEFAULT '' NOT NULL,
  "missing_fields_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "signals_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "card_id" text,
  "resolved_by" text,
  "resolved_at" timestamp with time zone,
  "resolution_note" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "fdp_integration_events"
  ADD CONSTRAINT "fdp_integration_events_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
-- A chave composta é o que impede um evento apontar para a integração de outro
-- grupo: o par (workspace, integração) precisa existir junto.
ALTER TABLE "fdp_integration_events"
  ADD CONSTRAINT "fdp_integration_events_workspace_integration_fk"
  FOREIGN KEY ("workspace_id", "integration_id")
  REFERENCES "fdp_integrations"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_integration_events"
  ADD CONSTRAINT "fdp_integration_events_status_check"
  CHECK ("status" IN ('received', 'processing', 'processed', 'ignored', 'error', 'reprocessed'));
--> statement-breakpoint
ALTER TABLE "fdp_integration_events"
  ADD CONSTRAINT "fdp_integration_events_source_check"
  CHECK ("source" IN ('webhook', 'polling', 'manual', 'retry'));
--> statement-breakpoint
ALTER TABLE "fdp_integration_events"
  ADD CONSTRAINT "fdp_integration_events_retry_check"
  CHECK ("retry_count" >= 0 AND "retry_count" <= 100);
--> statement-breakpoint

ALTER TABLE "fdp_movement_suggestions"
  ADD CONSTRAINT "fdp_movement_suggestions_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions"
  ADD CONSTRAINT "fdp_movement_suggestions_workspace_integration_fk"
  FOREIGN KEY ("workspace_id", "integration_id")
  REFERENCES "fdp_integrations"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions"
  ADD CONSTRAINT "fdp_movement_suggestions_event_fk"
  FOREIGN KEY ("event_id") REFERENCES "fdp_integration_events"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions"
  ADD CONSTRAINT "fdp_movement_suggestions_kind_check"
  CHECK ("movement_kind" IN ('salary_change', 'role_change'));
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions"
  ADD CONSTRAINT "fdp_movement_suggestions_status_check"
  CHECK ("status" IN ('pending', 'confirmed', 'rejected', 'superseded'));
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions"
  ADD CONSTRAINT "fdp_movement_suggestions_confidence_check"
  CHECK ("confidence" BETWEEN 0 AND 100);
--> statement-breakpoint
-- Confirmada precisa apontar para a demanda que nasceu dela; rejeitada nunca
-- aponta. Sem isto, "confirmei mas não virou demanda" fica invisível no banco.
ALTER TABLE "fdp_movement_suggestions"
  ADD CONSTRAINT "fdp_movement_suggestions_resolution_check"
  CHECK (
    ("status" = 'confirmed' AND "card_id" IS NOT NULL AND "resolved_at" IS NOT NULL)
    OR ("status" = 'rejected' AND "resolved_at" IS NOT NULL)
    OR ("status" IN ('pending', 'superseded'))
  );
--> statement-breakpoint

-- Idempotência: um evento externo por integração, e nada mais. É esta constraint
-- — não o código do conector — que garante que reexecutar o sincronizador não
-- abre a segunda demanda.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_integration_events_idempotency_uq"
  ON "fdp_integration_events" USING btree ("workspace_id", "integration_id", "external_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_integration_events_workspace_id_uq"
  ON "fdp_integration_events" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_events_workspace_status_idx"
  ON "fdp_integration_events" USING btree ("workspace_id", "status", "received_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_events_workspace_connector_idx"
  ON "fdp_integration_events" USING btree ("workspace_id", "connector", "event_type", "received_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_movement_suggestions_workspace_id_uq"
  ON "fdp_movement_suggestions" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_movement_suggestions_workspace_status_idx"
  ON "fdp_movement_suggestions" USING btree ("workspace_id", "status", "created_at" DESC);
--> statement-breakpoint
-- Mensagem editada no Teams reencontra a sugestão que ela mesma gerou, em vez
-- de abrir uma segunda: uma sugestão pendente por mensagem de origem.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_movement_suggestions_message_uq"
  ON "fdp_movement_suggestions" USING btree ("workspace_id", "integration_id", "message_id")
  WHERE "message_id" <> '' AND "status" = 'pending';
--> statement-breakpoint

ALTER TABLE "fdp_integration_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_movement_suggestions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_integration_events_workspace_isolation" ON "fdp_integration_events"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_movement_suggestions_workspace_isolation" ON "fdp_movement_suggestions"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- Ciclo de vida do grupo -----------------------------------------------------
--
-- `deleted` entra como estado; a remoção física continua no console da
-- plataforma. Assim a exclusão pedida pelo dono do grupo é reversível dentro do
-- prazo, e o que some da tela não some do banco no mesmo instante.
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "deleted_by_email" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Data a partir da qual a remoção definitiva pode acontecer. Antes dela, o
-- grupo é restaurável por um administrador.
ALTER TABLE "fdp_workspaces" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fdp_workspaces_status_check'
  ) THEN
    ALTER TABLE "fdp_workspaces" DROP CONSTRAINT "fdp_workspaces_status_check";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_workspaces" ADD CONSTRAINT "fdp_workspaces_status_check"
  CHECK ("status" IN ('active', 'suspended', 'canceled', 'archived', 'deleted'));
--> statement-breakpoint
-- Um grupo excluído sem data de exclusão não teria como ser expurgado nem
-- restaurado com prazo; o estado e as datas andam juntos.
ALTER TABLE "fdp_workspaces" ADD CONSTRAINT "fdp_workspaces_deleted_at_check"
  CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_workspaces_purge_idx"
  ON "fdp_workspaces" USING btree ("status", "purge_after")
  WHERE "status" = 'deleted';
