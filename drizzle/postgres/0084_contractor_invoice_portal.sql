-- Portal do prestador: o link por competência que recebe a nota fiscal.
--
-- A nota entrava por uma pessoa do DP. O aviso saía como texto para colar no
-- WhatsApp, o prestador respondia com o PDF anexado, e alguém subia o arquivo
-- na tela — trinta vezes, todo mês. Coletar era o gargalo do fechamento, e o
-- trabalho não era de quem emite: era de quem estava tentando fechar.
--
-- O link não cria um segundo caminho para a nota. Ele termina no mesmo
-- `registerInvoice` da tela, com a mesma verificação de duplicidade e a mesma
-- substituição versionada; o que muda é quem digita.
SELECT pg_advisory_xact_lock(hashtext('0084_contractor_invoice_portal'));
--> statement-breakpoint

-- O envio pelo portal não tem usuário do workspace por trás.
--
-- `uploaded_by` era NOT NULL com chave estrangeira para os membros. Carimbar
-- ali o id de quem gerou o link registraria que uma pessoa do DP enviou uma
-- nota que ela não enviou — numa tabela cuja razão de existir é responder
-- "quem fez o quê". O ator passa a ser opcional, e `uploaded_via` diz por onde
-- a nota entrou; o CHECK garante que envio pelo painel continua tendo pessoa.
ALTER TABLE "fdp_contractor_invoices"
  ADD COLUMN IF NOT EXISTS "uploaded_via" text DEFAULT 'panel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices" ALTER COLUMN "uploaded_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices" DROP CONSTRAINT IF EXISTS "fdp_contractor_invoices_uploaded_via_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices"
  ADD CONSTRAINT "fdp_contractor_invoices_uploaded_via_check"
  CHECK ("uploaded_via" IN ('panel', 'contractor_portal'));
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices" DROP CONSTRAINT IF EXISTS "fdp_contractor_invoices_uploader_presence_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices"
  ADD CONSTRAINT "fdp_contractor_invoices_uploader_presence_check"
  CHECK ("uploaded_via" <> 'panel' OR "uploaded_by" IS NOT NULL);
--> statement-breakpoint

-- O arquivo enviado pelo portal também não tem autor no workspace. Mesma
-- escolha da nota: o autor some, a origem aparece, e o CHECK mantém obrigatória
-- a pessoa no caminho em que ela existe.
ALTER TABLE "fdp_contractor_documents"
  ADD COLUMN IF NOT EXISTS "created_via" text DEFAULT 'panel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" ALTER COLUMN "created_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" DROP CONSTRAINT IF EXISTS "fdp_contractor_documents_created_via_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents"
  ADD CONSTRAINT "fdp_contractor_documents_created_via_check"
  CHECK ("created_via" IN ('panel', 'contractor_portal'));
--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" DROP CONSTRAINT IF EXISTS "fdp_contractor_documents_creator_presence_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents"
  ADD CONSTRAINT "fdp_contractor_documents_creator_presence_check"
  CHECK ("created_via" <> 'panel' OR "created_by" IS NOT NULL);
--> statement-breakpoint

-- Mesma correção na trilha: um fato sem pessoa é um fato de outro tipo de ator,
-- não um fato de uma pessoa escolhida por conveniência.
ALTER TABLE "fdp_contractor_invoice_events"
  ADD COLUMN IF NOT EXISTS "actor_kind" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
-- Quem aparece no histórico quando não há usuário: o nome do prestador que
-- enviou. Sem ele a linha diria apenas "portal", e o histórico de uma nota
-- precisa nomear quem a mandou.
ALTER TABLE "fdp_contractor_invoice_events"
  ADD COLUMN IF NOT EXISTS "actor_label" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_events" ALTER COLUMN "actor_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_events" DROP CONSTRAINT IF EXISTS "fdp_contractor_invoice_events_actor_kind_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_events"
  ADD CONSTRAINT "fdp_contractor_invoice_events_actor_kind_check"
  CHECK ("actor_kind" IN ('user', 'contractor_portal'));
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_events" DROP CONSTRAINT IF EXISTS "fdp_contractor_invoice_events_actor_presence_check";
--> statement-breakpoint
-- Ator do tipo pessoa exige a pessoa; ator do portal exige o nome de quem
-- enviou. Nos dois casos a linha responde "quem", que é o que ela promete.
ALTER TABLE "fdp_contractor_invoice_events"
  ADD CONSTRAINT "fdp_contractor_invoice_events_actor_presence_check"
  CHECK (("actor_kind" = 'user' AND "actor_user_id" IS NOT NULL)
    OR ("actor_kind" = 'contractor_portal' AND length(trim("actor_label")) > 0));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_contractor_invoice_portal_links" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT current_setting('app.workspace_id', true) NOT NULL,
  "company_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "payroll_cycle_id" text NOT NULL,
  "closing_id" text NOT NULL,
  "competence" text NOT NULL,
  -- Só o hash. O token completo existe na mensagem enviada ao prestador e em
  -- nenhum outro lugar: um vazamento do banco não devolve link utilizável.
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  -- Valor esperado no momento em que o link nasceu. A tela do prestador mostra
  -- este número, e não o do fechamento agora: reapurar a competência depois do
  -- aviso não pode mudar, sem avisar ninguém, o valor que já foi pedido.
  "expected_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
  "first_opened_at" timestamp with time zone,
  "opened_count" integer DEFAULT 0 NOT NULL,
  "submitted_at" timestamp with time zone,
  "submitted_invoice_id" text,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "revoke_reason" text DEFAULT '' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_contractor_invoice_portal_links_competence_check"
    CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "fdp_contractor_invoice_portal_links_amount_check"
    CHECK ("expected_amount" >= 0),
  CONSTRAINT "fdp_contractor_invoice_portal_links_opened_check"
    CHECK ("opened_count" >= 0),
  -- Revogar é ato de alguém, em algum momento: os dois campos ou nenhum.
  CONSTRAINT "fdp_contractor_invoice_portal_links_revoke_check"
    CHECK (("revoked_at" IS NULL AND "revoked_by" IS NULL) OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)),
  -- Marcado como enviado sem a nota correspondente seria um envio que ninguém
  -- consegue abrir depois.
  CONSTRAINT "fdp_contractor_invoice_portal_links_submission_check"
    CHECK (("submitted_at" IS NULL AND "submitted_invoice_id" IS NULL)
      OR ("submitted_at" IS NOT NULL AND "submitted_invoice_id" IS NOT NULL)),
  CONSTRAINT "fdp_contractor_invoice_portal_links_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_contractor_invoice_portal_links_company_fk"
    FOREIGN KEY ("workspace_id", "company_id") REFERENCES "fdp_companies"("workspace_id", "id"),
  CONSTRAINT "fdp_contractor_invoice_portal_links_provider_fk"
    FOREIGN KEY ("workspace_id", "provider_id") REFERENCES "fdp_auxiliary_providers"("workspace_id", "id"),
  CONSTRAINT "fdp_contractor_invoice_portal_links_cycle_fk"
    FOREIGN KEY ("workspace_id", "company_id", "payroll_cycle_id")
    REFERENCES "fdp_payroll_cycles"("workspace_id", "company_id", "id"),
  CONSTRAINT "fdp_contractor_invoice_portal_links_closing_fk"
    FOREIGN KEY ("workspace_id", "closing_id") REFERENCES "fdp_contractor_closings"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_contractor_invoice_portal_links_invoice_fk"
    FOREIGN KEY ("workspace_id", "submitted_invoice_id") REFERENCES "fdp_contractor_invoices"("workspace_id", "id"),
  CONSTRAINT "fdp_contractor_invoice_portal_links_creator_fk"
    FOREIGN KEY ("workspace_id", "created_by") REFERENCES "fdp_workspace_members"("workspace_id", "user_id"),
  CONSTRAINT "fdp_contractor_invoice_portal_links_revoker_fk"
    FOREIGN KEY ("workspace_id", "revoked_by") REFERENCES "fdp_workspace_members"("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_workspace_id_uq"
  ON "fdp_contractor_invoice_portal_links" ("workspace_id", "id");
--> statement-breakpoint
-- O hash é único no banco inteiro, e não por workspace: dois inquilinos com o
-- mesmo hash significaria colisão de segredo, que é defeito, não coincidência.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_token_uq"
  ON "fdp_contractor_invoice_portal_links" ("token_hash");
--> statement-breakpoint
-- Um link vivo por fechamento. Gerar o segundo revoga o primeiro, em vez de
-- deixar dois válidos e o prestador adivinhando qual usar.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_open_uq"
  ON "fdp_contractor_invoice_portal_links" ("workspace_id", "closing_id")
  WHERE "revoked_at" IS NULL AND "submitted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_competence_idx"
  ON "fdp_contractor_invoice_portal_links" ("workspace_id", "company_id", "competence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_provider_idx"
  ON "fdp_contractor_invoice_portal_links" ("workspace_id", "provider_id", "competence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_closing_idx"
  ON "fdp_contractor_invoice_portal_links" ("workspace_id", "closing_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_creator_idx"
  ON "fdp_contractor_invoice_portal_links" ("workspace_id", "created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_revoker_idx"
  ON "fdp_contractor_invoice_portal_links" ("workspace_id", "revoked_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_invoice_idx"
  ON "fdp_contractor_invoice_portal_links" ("workspace_id", "submitted_invoice_id");
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_portal_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_portal_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_contractor_invoice_portal_links_workspace_isolation" ON "fdp_contractor_invoice_portal_links";
--> statement-breakpoint
-- A RLS vale também para a rota pública do portal: ela resolve o inquilino a
-- partir do próprio token e abre a conexão já presa a ele, em vez de consultar
-- sem recorte e filtrar depois.
CREATE POLICY "fdp_contractor_invoice_portal_links_workspace_isolation" ON "fdp_contractor_invoice_portal_links"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
