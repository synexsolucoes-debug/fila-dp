-- Envelope do catálogo de eventos de domínio (§6, §8).
--
-- A tabela `fdp_domain_events` já existia e já era append-only por construção
-- (o publicador só troca `status`). O que faltava nela era o que transforma um
-- registro de saída em um **evento de domínio**: de onde veio, qual o
-- identificador na origem, o que o causou, que evidência sustenta o fato, e a
-- chave que impede que a mesma ocorrência produza dois resultados de negócio.
--
-- Tudo aqui é aditivo e com default. Nenhuma linha existente muda de sentido:
-- os eventos já gravados passam a ser lidos como `origin = 'internal'`,
-- `schema_version = 1` e sem chave de idempotência — que é exatamente o que
-- eles são.
--
-- Sobre o índice único: ele é **parcial**, `WHERE idempotency_key <> ''`. Sem
-- isso, todo evento interno (que não deriva chave) colidiria com o próximo, e a
-- primeira mutação depois do deploy falharia. A condição é a diferença entre
-- "esta ocorrência já entrou" e "este evento não usa idempotência".
SELECT pg_advisory_xact_lock(hashtext('0057_domain_event_catalog'));
--> statement-breakpoint

ALTER TABLE "fdp_domain_events" ADD COLUMN IF NOT EXISTS "schema_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'internal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ADD COLUMN IF NOT EXISTS "external_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ADD COLUMN IF NOT EXISTS "correlation_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ADD COLUMN IF NOT EXISTS "causation_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ADD COLUMN IF NOT EXISTS "idempotency_key" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ADD COLUMN IF NOT EXISTS "evidence_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ADD COLUMN IF NOT EXISTS "received_at" timestamptz DEFAULT now() NOT NULL;
--> statement-breakpoint

-- `schema_version` positivo e origem dentro do vocabulário do catálogo. A lista
-- é repetida aqui de propósito: a aplicação valida antes de gravar, mas a regra
-- que impede um evento sem origem reconhecida precisa continuar valendo para
-- quem escrever por outro caminho (§4).
ALTER TABLE "fdp_domain_events" DROP CONSTRAINT IF EXISTS "fdp_domain_events_schema_version_check";
--> statement-breakpoint
ALTER TABLE "fdp_domain_events"
  ADD CONSTRAINT "fdp_domain_events_schema_version_check" CHECK ("schema_version" > 0);
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" DROP CONSTRAINT IF EXISTS "fdp_domain_events_origin_check";
--> statement-breakpoint
ALTER TABLE "fdp_domain_events"
  ADD CONSTRAINT "fdp_domain_events_origin_check"
  CHECK ("origin" IN ('internal', 'teams', 'solides', 'tangerino', 'sankhya', 'caju', 'agent', 'api', 'import'));
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fdp_domain_events_idempotency_uq"
  ON "fdp_domain_events" USING btree ("workspace_id", "idempotency_key")
  WHERE "idempotency_key" <> '';
--> statement-breakpoint

-- Duas perguntas operacionais que hoje varrem a tabela inteira: "o que veio
-- desta origem?" e "o que aconteceu nesta correlação?".
CREATE INDEX IF NOT EXISTS "fdp_domain_events_origin_idx"
  ON "fdp_domain_events" USING btree ("workspace_id", "origin", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_domain_events_correlation_idx"
  ON "fdp_domain_events" USING btree ("workspace_id", "correlation_id")
  WHERE "correlation_id" <> '';
