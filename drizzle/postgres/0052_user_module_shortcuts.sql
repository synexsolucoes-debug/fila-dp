-- Favoritos e recentes por pessoa (§67).
--
-- O menu cresceu com a organização por processo: hoje são sete processos e
-- mais de vinte destinos. Quem trabalha em três deles o dia inteiro abre dois
-- níveis toda vez, e quem voltou do almoço não tem como retomar de onde parou.
--
-- Uma linha por (grupo, pessoa, destino). O favorito é explícito e ordenado
-- por `position`; o recente é automático e ordenado por `last_used_at`. Os dois
-- convivem na mesma linha porque são o mesmo par pessoa-destino visto de dois
-- ângulos — separar em duas tabelas duplicaria a chave e abriria a chance de
-- as duas discordarem sobre a mesma coisa.
--
-- Não há chave estrangeira para o destino: ele é uma tela do painel, não uma
-- linha do banco. O que protege contra lixo é o filtro de permissão na leitura
-- — um destino que a pessoa não pode ver não volta, e um destino que deixou de
-- existir também não.
CREATE TABLE "fdp_user_module_shortcuts" (
 "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
 "user_id" text NOT NULL,
 "view_key" text NOT NULL,
 "favorite" integer DEFAULT 0 NOT NULL,
 "position" integer DEFAULT 0 NOT NULL,
 "last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
 "use_count" integer DEFAULT 0 NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "fdp_user_module_shortcuts_pk" PRIMARY KEY ("workspace_id","user_id","view_key"),
 CONSTRAINT "fdp_user_module_shortcuts_favorite_check" CHECK ("favorite" IN (0,1)),
 CONSTRAINT "fdp_user_module_shortcuts_position_check" CHECK ("position" >= 0 AND "position" <= 99),
 CONSTRAINT "fdp_user_module_shortcuts_view_check" CHECK (length("view_key") BETWEEN 2 AND 64),
 CONSTRAINT "fdp_user_module_shortcuts_count_check" CHECK ("use_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "fdp_user_module_shortcuts" ADD CONSTRAINT "fdp_user_module_shortcuts_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE cascade;--> statement-breakpoint
-- A leitura é sempre "os atalhos desta pessoa neste grupo", nas duas ordens.
CREATE INDEX "fdp_user_module_shortcuts_recent_idx" ON "fdp_user_module_shortcuts" ("workspace_id","user_id","last_used_at" DESC);--> statement-breakpoint
CREATE INDEX "fdp_user_module_shortcuts_favorite_idx" ON "fdp_user_module_shortcuts" ("workspace_id","user_id","favorite","position");--> statement-breakpoint
ALTER TABLE "fdp_user_module_shortcuts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_user_module_shortcuts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_user_module_shortcuts_workspace_isolation" ON "fdp_user_module_shortcuts" USING ("workspace_id"=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK ("workspace_id"=NULLIF(current_setting('app.workspace_id',true),''));

-- Não há rotina de limpeza, e não é esquecimento: uma pessoa só pode visitar
-- tela que existe, então o número de linhas por pessoa é no máximo o número de
-- destinos do painel — hoje pouco mais de vinte. Um gatilho de poda aqui seria
-- código para um crescimento que não acontece.
