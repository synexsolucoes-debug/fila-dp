-- Exclusão definitiva de grupo, com prova de que ela aconteceu.
--
-- Duas exigências que parecem se contradizer precisam valer juntas:
--
--   1. O cliente tem direito à eliminação dos dados. Arquivar não é excluir, e
--      chamar arquivamento de exclusão seria mentir sobre um direito.
--   2. A trilha de auditoria existe justamente para não sumir. Hoje
--      `fdp_audit_events` tem ON DELETE RESTRICT, o que impede a exclusão — e
--      afrouxar isso para CASCADE apagaria a prova de tudo que foi feito.
--
-- A saída não é escolher um lado: os dados operacionais do grupo, inclusive a
-- trilha dele, são eliminados; e um registro **de plataforma** — sem chave
-- estrangeira para o grupo, porque o grupo deixa de existir — guarda o que
-- sobrou de prova: quem excluiu, quando, por quê, e quantas linhas saíram de
-- cada tabela.
--
-- É o mínimo que permite responder "esse grupo foi mesmo excluído, e por quem?"
-- meses depois, sem manter o dado que deveria ter sido eliminado.
CREATE TABLE IF NOT EXISTS "fdp_workspace_deletions" (
	"id" text PRIMARY KEY NOT NULL,
	-- Sem FK, de propósito: o grupo referenciado não existe mais.
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"workspace_slug" text NOT NULL,
	"owner_email" text DEFAULT '' NOT NULL,
	"plan_code" text DEFAULT '' NOT NULL,
	"status_before" text NOT NULL,
	"reason" text NOT NULL,
	-- Quantas linhas saíram de cada tabela. É o que transforma "excluí" em algo
	-- conferível.
	"row_counts_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_by" text NOT NULL,
	"deleted_by_email" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_workspace_deletions_reason_check" CHECK (length(btrim("reason")) >= 10)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_workspace_deletions_workspace_idx"
  ON "fdp_workspace_deletions" ("workspace_id");
--> statement-breakpoint
-- Registro de exclusão é imutável: se ele pudesse ser editado ou apagado, não
-- serviria como prova de nada.
CREATE OR REPLACE FUNCTION "fdp_workspace_deletions_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace deletion records are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_workspace_deletions_immutable"
  BEFORE UPDATE OR DELETE ON "fdp_workspace_deletions"
  FOR EACH ROW EXECUTE FUNCTION "fdp_workspace_deletions_immutable"();
--> statement-breakpoint

-- O guard de primeira instalação aponta para o primeiro grupo criado. Se esse
-- grupo for excluído, a referência precisa soltar em vez de bloquear a exclusão
-- — o guard existe para impedir dois grupos iniciais, não para tornar o
-- primeiro deles indestrutível.
ALTER TABLE "fdp_bootstrap_guard" DROP CONSTRAINT IF EXISTS "fdp_bootstrap_guard_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_bootstrap_guard" ADD CONSTRAINT "fdp_bootstrap_guard_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
