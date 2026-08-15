-- Trilha de autenticação (§40).
--
-- §40 pede login e logout registrados na auditoria. Eles não estavam, e o
-- motivo era estrutural, não descuido: `fdp_audit_events.workspace_id` é NOT
-- NULL e a tabela tem RLS por workspace — mas o login acontece antes de existir
-- contexto de workspace, e quem pertence a vários não tem um "correto" a que
-- atribuir o evento. A trilha global (`fdp_platform_audit_events`) também não
-- servia: a política dela exige `app.platform_admin` até para escrever, e o
-- login não tem essa marca nem deveria forjá-la.
--
-- Daí uma tabela própria, sem workspace e sem exigir marca de plataforma para
-- gravar. Ela responde o que a auditoria precisa responder sobre acesso: quem
-- entrou, quando, de onde, e o que foi recusado.
--
-- O que existia antes cobria parte disso e continua valendo: `fdp_auth_sessions`
-- guarda a sessão bem-sucedida com dispositivo e IP, e `fdp_auth_rate_limits`
-- segura o ataque em curso. O que faltava era durabilidade da tentativa
-- recusada — o rate limit apaga o registro assim que um login dá certo, que é o
-- comportamento correto dele, mas apaga junto o rastro do padrão clássico:
-- vinte tentativas erradas e depois uma certa.
--
-- RETENÇÃO: esta tabela guarda e-mail tentado e IP em hash, que são dado
-- pessoal. O prazo de guarda é decisão de política de privacidade, não técnica,
-- e por isso nenhuma limpeza automática é criada aqui. A estrutura permite
-- aplicar a política aprovada depois — que é o que a LGPD pede do produto, sem
-- que o produto invente a garantia jurídica.
CREATE TABLE IF NOT EXISTS "fdp_auth_events" (
	"id" text PRIMARY KEY NOT NULL,
	-- Nulo quando a tentativa foi contra e-mail que não existe. Perder o vínculo
	-- ao excluir o usuário é aceitável; perder o evento não é.
	"user_id" text,
	"email" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	-- Motivo legível da recusa, sem detalhe que ajude quem sonda.
	"reason" text DEFAULT '' NOT NULL,
	"ip_hash" text DEFAULT '' NOT NULL,
	"user_agent_hash" text DEFAULT '' NOT NULL,
	"request_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_auth_events_action_check" CHECK ("action" IN ('login', 'logout', 'password_reset', 'session_revoked')),
	CONSTRAINT "fdp_auth_events_outcome_check" CHECK ("outcome" IN ('success', 'denied', 'failure'))
);
--> statement-breakpoint
ALTER TABLE "fdp_auth_events" ADD CONSTRAINT "fdp_auth_events_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE SET NULL ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_auth_events_recent_idx" ON "fdp_auth_events" USING btree ("created_at" DESC);
--> statement-breakpoint
-- As duas perguntas de investigação: "o que houve com esta conta" e "o que
-- houve com este e-mail", inclusive quando ele não corresponde a conta alguma.
CREATE INDEX IF NOT EXISTS "fdp_auth_events_user_idx" ON "fdp_auth_events" USING btree ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_auth_events_email_idx" ON "fdp_auth_events" USING btree ("email", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "fdp_auth_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_auth_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Gravar é sempre permitido: o login precisa registrar antes de haver qualquer
-- contexto, e um evento que depende de permissão para nascer não é trilha.
CREATE POLICY "fdp_auth_events_append" ON "fdp_auth_events" FOR INSERT WITH CHECK (true);
--> statement-breakpoint
-- Ler é só de quem administra a plataforma: a tabela mostra e-mails de tentativa
-- e o padrão de acesso de todos os clientes.
CREATE POLICY "fdp_auth_events_read" ON "fdp_auth_events" FOR SELECT
  USING (current_setting('app.platform_admin', true) = 'true');
--> statement-breakpoint
-- Trilha que se pode editar não é trilha. Mesmo desenho de `fdp_audit_events`.
CREATE OR REPLACE FUNCTION "fdp_prevent_auth_event_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.audit_maintenance', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'fdp_auth_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_auth_events_append_only"
BEFORE UPDATE OR DELETE ON "fdp_auth_events"
FOR EACH ROW EXECUTE FUNCTION "fdp_prevent_auth_event_mutation"();
