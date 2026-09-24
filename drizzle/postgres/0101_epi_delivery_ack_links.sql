-- Link assinado genérico, passo 1: dar ciência da entrega de EPI sem conta e
-- sem senha.
--
-- Hoje a assinatura do termo de entrega (`fdp_epi_deliveries.signature_name`)
-- só existe se alguém do DP/SESMT digitar o nome pela tela — quem entrega o
-- EPI precisa estar junto de quem tem acesso ao sistema. O link muda quem
-- confirma, não a regra: a entrega continua sendo a mesma linha, o mesmo
-- `PATCH /api/epi/deliveries/[id]`, a mesma trilha de auditoria.
--
-- A tabela e o token seguem exatamente o desenho do portal do prestador
-- (0084_contractor_invoice_portal.sql) — mesmo `<workspace>.<segredo>`, mesmo
-- hash guardado em vez do token, mesmo prazo com teto. É reuso deliberado da
-- mesma primitiva (`lib/contractor-invoice-portal.ts`), não uma segunda
-- implementação: o roteiro de produto pediu um "link assinado genérico"
-- (aprovar, responder, enviar documento, dar ciência), e ciência de entrega de
-- EPI é o primeiro consumidor real dele.
SELECT pg_advisory_xact_lock(hashtext('0101_epi_delivery_ack_links'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_epi_delivery_ack_links" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT current_setting('app.workspace_id', true) NOT NULL,
  "company_id" text NOT NULL,
  "delivery_id" text NOT NULL,
  -- Só o hash, pelo mesmo motivo do portal do prestador: o token completo
  -- existe na mensagem enviada ao colaborador e em nenhum outro lugar.
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "first_opened_at" timestamp with time zone,
  "opened_count" integer DEFAULT 0 NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "revoke_reason" text DEFAULT '' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_epi_delivery_ack_links_opened_check"
    CHECK ("opened_count" >= 0),
  CONSTRAINT "fdp_epi_delivery_ack_links_revoke_check"
    CHECK (("revoked_at" IS NULL AND "revoked_by" IS NULL) OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)),
  CONSTRAINT "fdp_epi_delivery_ack_links_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_epi_delivery_ack_links_company_fk"
    FOREIGN KEY ("workspace_id", "company_id") REFERENCES "fdp_companies"("workspace_id", "id"),
  CONSTRAINT "fdp_epi_delivery_ack_links_delivery_fk"
    FOREIGN KEY ("workspace_id", "delivery_id") REFERENCES "fdp_epi_deliveries"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_epi_delivery_ack_links_creator_fk"
    FOREIGN KEY ("workspace_id", "created_by") REFERENCES "fdp_workspace_members"("workspace_id", "user_id"),
  CONSTRAINT "fdp_epi_delivery_ack_links_revoker_fk"
    FOREIGN KEY ("workspace_id", "revoked_by") REFERENCES "fdp_workspace_members"("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_epi_delivery_ack_links_workspace_id_uq"
  ON "fdp_epi_delivery_ack_links" ("workspace_id", "id");
--> statement-breakpoint
-- O hash é único no banco inteiro, como no portal do prestador: colisão de
-- segredo é defeito, não coincidência de dois inquilinos.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_epi_delivery_ack_links_token_uq"
  ON "fdp_epi_delivery_ack_links" ("token_hash");
--> statement-breakpoint
-- Um link vivo por entrega. Gerar o segundo revoga o primeiro, em vez de
-- deixar dois válidos e o colaborador adivinhando qual usar.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_epi_delivery_ack_links_open_uq"
  ON "fdp_epi_delivery_ack_links" ("workspace_id", "delivery_id")
  WHERE "revoked_at" IS NULL AND "acknowledged_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_epi_delivery_ack_links_delivery_idx"
  ON "fdp_epi_delivery_ack_links" ("workspace_id", "delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_epi_delivery_ack_links_creator_idx"
  ON "fdp_epi_delivery_ack_links" ("workspace_id", "created_by");
--> statement-breakpoint
ALTER TABLE "fdp_epi_delivery_ack_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_epi_delivery_ack_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_epi_delivery_ack_links_workspace_isolation" ON "fdp_epi_delivery_ack_links";
--> statement-breakpoint
-- A RLS vale também para a rota pública do portal: ela resolve o inquilino a
-- partir do próprio token e abre a conexão já presa a ele, exatamente como o
-- portal do prestador.
CREATE POLICY "fdp_epi_delivery_ack_links_workspace_isolation" ON "fdp_epi_delivery_ack_links"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
