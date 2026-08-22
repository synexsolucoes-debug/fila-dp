-- Demanda como instância de uma versão de processo (§10, §11, §12, §13).
--
-- O diagnóstico foi direto: o BPMN existia, era versionado, era publicável — e
-- não executava trabalho nenhum. Publicar uma versão trocava um `status` e mais
-- nada. Do outro lado, Demandas rodava sobre `fdp_process_templates`, um
-- segundo conceito de "processo" que não sabe da existência do primeiro.
--
-- Esta migration cria o elo que faltava, e cria **do lado da demanda**: a
-- demanda passa a poder dizer de qual definição, de qual versão e em que etapa
-- ela está. Nenhuma tabela nova de instância foi criada, porque a instância já
-- existe — ela se chama demanda. Inventar `fdp_process_instances` ao lado de
-- `fdp_cards` seria criar o quinto objeto de trabalho paralelo que a auditoria
-- pediu para não criar (§93).
--
-- Compatibilidade (§13, §76): tudo é opcional e com default. Demanda legada
-- fica com `process_version_id` nulo e continua funcionando exatamente como
-- hoje. Não há conversão automática de histórico: converter sem regra
-- comprovada inventaria vínculo.
--
-- A chave estrangeira para a versão é deliberadamente sem `ON DELETE`: uma
-- versão usada por alguma demanda não pode sumir. É isso que garante que
-- publicar a v5 nunca reescreve o que a v4 determinou para as demandas que ela
-- originou (§11).
SELECT pg_advisory_xact_lock(hashtext('0058_process_instances'));
--> statement-breakpoint

ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "process_definition_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "process_version_id" text;
--> statement-breakpoint
-- Texto e não número: a versão é `major.minor` e guardar "4.0" evita ter que
-- reconsultar a versão só para escrever o rótulo na tela ou no evento.
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "process_version_number" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "current_step_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "instantiated_at" timestamptz;
--> statement-breakpoint

-- Concorrência otimista (§34). Duas pessoas mexendo na mesma demanda é o caso
-- real mais comum de colisão no DP: uma move a etapa enquanto a outra edita.
-- Sem esta coluna, a última escrita ganha e a primeira desaparece sem aviso.
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_version_check";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_version_check" CHECK ("version" > 0);
--> statement-breakpoint

-- Uma demanda orientada a processo é um conjunto coerente ou não é nada: ter
-- versão sem definição, ou versão sem etapa atual, é estado impossível de
-- interpretar. O banco recusa, porque é a única camada que todo caminho de
-- escrita atravessa (§4).
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_process_instance_check";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_process_instance_check" CHECK (
  ("process_version_id" IS NULL AND "process_definition_id" IS NULL AND "current_step_id" = '' AND "process_version_number" = '' AND "instantiated_at" IS NULL)
  OR ("process_version_id" IS NOT NULL AND "process_definition_id" IS NOT NULL AND "current_step_id" <> '' AND "instantiated_at" IS NOT NULL)
);
--> statement-breakpoint

ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_process_definition_fk";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_process_definition_fk"
  FOREIGN KEY ("workspace_id", "process_definition_id")
  REFERENCES "public"."fdp_process_definitions"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_process_version_fk";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_process_version_fk"
  FOREIGN KEY ("workspace_id", "process_version_id")
  REFERENCES "public"."fdp_process_versions"("workspace_id", "id");
--> statement-breakpoint

-- "Quais demandas esta versão originou?" e "o que está parado nesta etapa?" são
-- as duas perguntas que a tela de processo faz.
CREATE INDEX IF NOT EXISTS "fdp_cards_process_version_idx"
  ON "fdp_cards" USING btree ("workspace_id", "process_version_id", "current_step_id")
  WHERE "process_version_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_cards_process_definition_idx"
  ON "fdp_cards" USING btree ("workspace_id", "process_definition_id", "archived")
  WHERE "process_definition_id" IS NOT NULL;
--> statement-breakpoint

-- Item de checklist associado à etapa que o exige.
--
-- É o que torna "esta etapa está pronta?" uma pergunta com resposta no banco,
-- em vez de uma contagem de anexos que só aproxima. Vazio significa item solto,
-- que é o caso de toda demanda legada e de tudo que o usuário adiciona à mão.
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "process_step_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_checklist_items_process_step_idx"
  ON "fdp_checklist_items" USING btree ("workspace_id", "card_id", "process_step_id")
  WHERE "process_step_id" <> '';
