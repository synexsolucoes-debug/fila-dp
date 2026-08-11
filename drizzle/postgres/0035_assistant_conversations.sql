-- Conversas do assistente, isoladas por grupo.
--
-- Guardar a conversa serve a três coisas concretas: a pessoa retomar de onde
-- parou, o administrador conseguir auditar o que foi perguntado ao assistente
-- sobre a operação dele, e a plataforma medir se o recurso ajuda ou atrapalha.
--
-- O que **não** é guardado: nada de dado pessoal que a redação tenha removido.
-- A mensagem é gravada já redigida, e `redactions_json` diz apenas o tipo e a
-- quantidade do que foi removido — nunca o valor. Assim a auditoria consegue
-- responder "o limite foi acionado?" sem reintroduzir o dado que ele tirou.
CREATE TABLE IF NOT EXISTS "fdp_assistant_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	-- Tela em que a conversa começou: é o que dá sentido a "como faço isso aqui?".
	"screen" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_assistant_conversations_status_check" CHECK ("status" IN ('open', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "fdp_assistant_conversations" ADD CONSTRAINT "fdp_assistant_conversations_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_assistant_conversations" ADD CONSTRAINT "fdp_assistant_conversations_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_assistant_conversations_user_idx"
  ON "fdp_assistant_conversations" ("workspace_id", "user_id", "updated_at" DESC);
--> statement-breakpoint
ALTER TABLE "fdp_assistant_conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_assistant_conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_assistant_conversations_read" ON "fdp_assistant_conversations" FOR SELECT
  USING ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
CREATE POLICY "fdp_assistant_conversations_write" ON "fdp_assistant_conversations" FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_assistant_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	-- Já redigido na gravação. O texto original não existe em lugar nenhum.
	"content" text NOT NULL,
	-- Tipo e quantidade do que a redação removeu. Nunca o valor removido.
	"redactions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_assistant_messages_role_check" CHECK ("role" IN ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "fdp_assistant_messages" ADD CONSTRAINT "fdp_assistant_messages_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_assistant_messages" ADD CONSTRAINT "fdp_assistant_messages_conversation_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "public"."fdp_assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_assistant_messages_conversation_idx"
  ON "fdp_assistant_messages" ("workspace_id", "conversation_id", "created_at");
--> statement-breakpoint
ALTER TABLE "fdp_assistant_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_assistant_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_assistant_messages_read" ON "fdp_assistant_messages" FOR SELECT
  USING ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
CREATE POLICY "fdp_assistant_messages_write" ON "fdp_assistant_messages" FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
