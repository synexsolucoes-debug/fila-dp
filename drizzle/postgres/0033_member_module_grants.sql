-- Permissão por usuário, além do papel.
--
-- Até aqui o acesso era decidido só pelo papel: quem é "Membro" vê o que todo
-- membro vê. A operação real não é assim — um membro do time fiscal pode
-- precisar de Relatórios sem virar administrador, e um estagiário pode precisar
-- ficar fora de Folha sem perder o resto.
--
-- Duas direções, com significados diferentes e deliberados:
--
--   granted = false  → bloqueia o módulo para essa pessoa, mesmo que o papel
--                      permita. É a exceção restritiva, e ela vence tudo.
--   granted = true   → concede a essa pessoa a capacidade de leitura do módulo,
--                      que o papel dela não teria. Não concede as ações de
--                      escrita: essas continuam vindo do papel, porque liberar
--                      a tela sem as ações entregaria uma tela decorativa.
--
-- O limite do plano continua acima dos dois: não se libera para um usuário o
-- que o grupo não contratou.
CREATE TABLE IF NOT EXISTS "fdp_member_module_grants" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"module_key" text NOT NULL,
	"granted" boolean NOT NULL,
	-- Por que essa exceção existe. Exceção de acesso sem motivo registrado vira
	-- mistério na próxima revisão de acesso.
	"reason" text DEFAULT '' NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_member_module_grants_pk" PRIMARY KEY ("workspace_id", "user_id", "module_key")
);
--> statement-breakpoint
ALTER TABLE "fdp_member_module_grants" ADD CONSTRAINT "fdp_member_module_grants_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_member_module_grants" ADD CONSTRAINT "fdp_member_module_grants_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_member_module_grants" ADD CONSTRAINT "fdp_member_module_grants_module_fk"
  FOREIGN KEY ("module_key") REFERENCES "public"."fdp_modules"("key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- A exceção só existe enquanto a associação existe: sair do grupo leva junto as
-- permissões individuais, senão elas voltariam a valer se a pessoa fosse
-- readicionada meses depois.
ALTER TABLE "fdp_member_module_grants" ADD CONSTRAINT "fdp_member_module_grants_membership_fk"
  FOREIGN KEY ("workspace_id", "user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_member_module_grants_user_idx"
  ON "fdp_member_module_grants" ("workspace_id", "user_id");
--> statement-breakpoint
ALTER TABLE "fdp_member_module_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_member_module_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_member_module_grants_read" ON "fdp_member_module_grants" FOR SELECT
  USING ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
CREATE POLICY "fdp_member_module_grants_write" ON "fdp_member_module_grants" FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
