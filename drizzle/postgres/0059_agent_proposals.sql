-- Propostas de agente e triagem (§17, §19, §66).
--
-- O que existia: agentes de navegador (Sankhya, Tangerino) que leem tela e
-- publicam evento, e as sugestões de movimentação do Teams
-- (`fdp_movement_suggestions`), que já são uma triagem — mas só para dois tipos
-- de movimentação vindos de um canal.
--
-- O que faltava: um lugar onde qualquer agente registra **o que ele acha que
-- deveria acontecer**, com a nota de confiança, a evidência e a decisão que o
-- motor determinístico tomou. Sem esse registro, "o agente propôs e o motor
-- recusou" não deixa rastro, e a pergunta "por que isso não andou?" não tem
-- resposta.
--
-- Uma tabela só, e ela **não** é um objeto de trabalho novo (§93): a proposta
-- não é tarefa de ninguém até o motor decidir o que fazer com ela, e quando ela
-- vira trabalho quem aparece na Central de Trabalho é a demanda, a movimentação
-- ou o item de triagem — pelo `href` da fonte que já existe.
--
-- `fdp_movement_suggestions` continua como está (§33): as duas convivem sob a
-- mesma leitura de triagem enquanto não houver prova de compatibilidade para
-- migrar a antiga. Fusão destrutiva sem essa prova joga histórico fora.
SELECT pg_advisory_xact_lock(hashtext('0059_agent_proposals'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_agent_proposals" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,

  -- De onde veio. `event_id` aponta o evento de domínio que originou a
  -- proposta: é o que liga a proposta ao fato, e sem ele o motor recusa.
  "agent_key" text NOT NULL,
  "agent_version" text DEFAULT '' NOT NULL,
  "event_id" text DEFAULT '' NOT NULL,
  "event_name" text DEFAULT '' NOT NULL,

  -- Sobre o quê. Tudo opcional de propósito: quando o agente **não** consegue
  -- identificar, é justamente esse vazio que manda o item para triagem.
  "entity_type" text DEFAULT '' NOT NULL,
  "entity_id" text DEFAULT '' NOT NULL,
  "process_instance_id" text,
  "current_step_id" text DEFAULT '' NOT NULL,

  -- O que ele propõe.
  "proposed_action" text NOT NULL,
  "proposed_step_id" text DEFAULT '' NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "confidence" integer DEFAULT 0 NOT NULL,
  "requires_human_approval" integer DEFAULT 1 NOT NULL,
  "evidence_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,

  -- O que o motor decidiu, e por quê. Guardar o código da decisão é o que
  -- permite responder "por que isso não executou sozinho?" meses depois.
  "status" text DEFAULT 'pending_triage' NOT NULL,
  "decision_code" text DEFAULT '' NOT NULL,
  "decision_reason" text DEFAULT '' NOT NULL,

  -- Quem resolveu, quando, e no que deu.
  "resolved_by" text,
  "resolved_at" timestamptz,
  "resolution_note" text DEFAULT '' NOT NULL,
  "result_type" text DEFAULT '' NOT NULL,
  "result_id" text DEFAULT '' NOT NULL,

  "idempotency_key" text DEFAULT '' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT "fdp_agent_proposals_status_check" CHECK ("status" IN ('pending_triage', 'suggested', 'accepted', 'rejected', 'applied', 'discarded')),
  CONSTRAINT "fdp_agent_proposals_confidence_check" CHECK ("confidence" BETWEEN 0 AND 100),
  CONSTRAINT "fdp_agent_proposals_human_flag_check" CHECK ("requires_human_approval" IN (0, 1)),
  CONSTRAINT "fdp_agent_proposals_agent_check" CHECK (length("agent_key") > 0),
  -- Proposta resolvida diz quem resolveu e quando; as duas coisas ou nenhuma.
  CONSTRAINT "fdp_agent_proposals_resolution_check" CHECK (
    ("status" IN ('pending_triage', 'suggested') AND "resolved_at" IS NULL)
    OR ("status" NOT IN ('pending_triage', 'suggested') AND "resolved_at" IS NOT NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "fdp_agent_proposals" DROP CONSTRAINT IF EXISTS "fdp_agent_proposals_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_agent_proposals" ADD CONSTRAINT "fdp_agent_proposals_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_agent_proposals" DROP CONSTRAINT IF EXISTS "fdp_agent_proposals_instance_fk";
--> statement-breakpoint
ALTER TABLE "fdp_agent_proposals" ADD CONSTRAINT "fdp_agent_proposals_instance_fk"
  FOREIGN KEY ("workspace_id", "process_instance_id")
  REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE set null;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fdp_agent_proposals_workspace_id_uq"
  ON "fdp_agent_proposals" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- A mesma ocorrência lida duas vezes pelo agente não vira duas propostas (§8).
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_agent_proposals_idempotency_uq"
  ON "fdp_agent_proposals" USING btree ("workspace_id", "idempotency_key")
  WHERE "idempotency_key" <> '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_agent_proposals_workspace_status_idx"
  ON "fdp_agent_proposals" USING btree ("workspace_id", "status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_agent_proposals_workspace_agent_idx"
  ON "fdp_agent_proposals" USING btree ("workspace_id", "agent_key", "created_at" DESC);
--> statement-breakpoint
-- FK sem índice de apoio é varredura garantida quando a demanda é apagada.
CREATE INDEX IF NOT EXISTS "fdp_agent_proposals_instance_idx"
  ON "fdp_agent_proposals" USING btree ("workspace_id", "process_instance_id")
  WHERE "process_instance_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "fdp_agent_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_agent_proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_agent_proposals_workspace_isolation" ON "fdp_agent_proposals"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- Política de automação por workspace (§18, §66).
--
-- Fica em `fdp_workspace_settings` e não em variável de ambiente porque §66 é
-- explícito: parar uma automação problemática não pode depender de deploy. O
-- padrão é `suggest_only` — na dúvida entre automatizar e pedir validação
-- humana, o produto pede validação (§84).
ALTER TABLE "fdp_workspace_settings"
  ADD COLUMN IF NOT EXISTS "agent_automation" text DEFAULT 'suggest_only' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings" DROP CONSTRAINT IF EXISTS "fdp_workspace_settings_agent_automation_check";
--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings"
  ADD CONSTRAINT "fdp_workspace_settings_agent_automation_check"
  CHECK ("agent_automation" IN ('off', 'suggest_only', 'trusted'));
