-- Carteira do DP: quem responde por cada empresa, com histórico.
--
-- O DP trabalha com dois ou três analistas e nenhuma coordenação formal; a
-- divisão de empresas morava numa planilha, e demanda nova nascia sem dono até
-- alguém lembrar de quem era aquela empresa. Aqui a divisão vira dado: cada
-- empresa tem um titular e um backup vigentes, e toda demanda que nasce para
-- ela é atribuída por `responsavelPara` (lib/portfolio.ts).
--
-- A vigência só cresce. Trocar o titular encerra a linha anterior e abre outra
-- — "quem era o responsável em março?" continua tendo resposta. O trigger
-- abaixo recusa reescrever uma vigência, e a aplicação não apaga nenhuma.
SELECT pg_advisory_xact_lock(hashtext('0113_dp_portfolio'));
--> statement-breakpoint

-- Situação da empresa para o DP. `sem_funcionarios` existe por um caso real:
-- a 40 (Goianésia) é a matriz da raiz da 33 (Goiânia) e o Sankhya mostra os
-- mesmos funcionários nas duas; a operação usa a 33.
ALTER TABLE "fdp_companies" ADD COLUMN IF NOT EXISTS "dp_status" text DEFAULT 'interno' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_companies" DROP CONSTRAINT IF EXISTS "fdp_companies_dp_status_check";
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD CONSTRAINT "fdp_companies_dp_status_check"
  CHECK ("dp_status" IN ('interno', 'a_internalizar', 'sem_funcionarios', 'terceirizado'));
--> statement-breakpoint
-- Derivados do CNPJ, e por isso gerados: uma cópia digitada divergiria do
-- `tax_id` no primeiro cadastro corrigido. Raiz = 8 primeiros dígitos;
-- matriz = ordem 0001.
ALTER TABLE "fdp_companies" ADD COLUMN IF NOT EXISTS "cnpj_root" text
  GENERATED ALWAYS AS (CASE WHEN length(regexp_replace("tax_id", '[^0-9]', '', 'g')) = 14
    THEN substr(regexp_replace("tax_id", '[^0-9]', '', 'g'), 1, 8) ELSE '' END) STORED;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ADD COLUMN IF NOT EXISTS "is_headquarters" boolean
  GENERATED ALWAYS AS (length(regexp_replace("tax_id", '[^0-9]', '', 'g')) = 14
    AND substr(regexp_replace("tax_id", '[^0-9]', '', 'g'), 9, 4) = '0001') STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_companies_workspace_cnpj_root_idx" ON "fdp_companies" USING btree ("workspace_id", "cnpj_root");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_company_portfolio" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"holder_user_id" text NOT NULL,
	"backup_user_id" text,
	"valid_from" date NOT NULL,
	-- NULL = vigente.
	"valid_to" date,
	"created_by" text NOT NULL,
	"ended_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "fdp_company_portfolio_backup_check" CHECK ("backup_user_id" IS NULL OR "backup_user_id" <> "holder_user_id"),
	CONSTRAINT "fdp_company_portfolio_period_check" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
	CONSTRAINT "fdp_company_portfolio_ended_check" CHECK (("valid_to" IS NULL) = ("ended_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_company_portfolio_workspace_id_uq" ON "fdp_company_portfolio" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- Uma vigência aberta por empresa: é o que torna "o titular" uma resposta só.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_company_portfolio_open_uq" ON "fdp_company_portfolio" USING btree ("workspace_id", "company_id") WHERE "valid_to" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_company_portfolio_company_period_idx" ON "fdp_company_portfolio" USING btree ("workspace_id", "company_id", "valid_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_company_portfolio_holder_idx" ON "fdp_company_portfolio" USING btree ("workspace_id", "holder_user_id") WHERE "valid_to" IS NULL;
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" DROP CONSTRAINT IF EXISTS "fdp_company_portfolio_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" ADD CONSTRAINT "fdp_company_portfolio_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" DROP CONSTRAINT IF EXISTS "fdp_company_portfolio_company_fk";
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" ADD CONSTRAINT "fdp_company_portfolio_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" DROP CONSTRAINT IF EXISTS "fdp_company_portfolio_holder_fk";
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" ADD CONSTRAINT "fdp_company_portfolio_holder_fk"
  FOREIGN KEY ("holder_user_id") REFERENCES "public"."fdp_users"("id");
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" DROP CONSTRAINT IF EXISTS "fdp_company_portfolio_backup_fk";
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" ADD CONSTRAINT "fdp_company_portfolio_backup_fk"
  FOREIGN KEY ("backup_user_id") REFERENCES "public"."fdp_users"("id");
--> statement-breakpoint
-- Titular e backup apontam para a pessoa, não para a associação ao grupo: a
-- vigência encerrada de quem saiu da equipe continua sendo histórico válido, e
-- não pode impedir a remoção do membro. Ser membro é conferido na gravação.
--
-- A única escrita aceita depois de gravada é encerrar a vigência aberta.
-- Reescrever titular, backup ou datas de uma vigência apagaria a resposta de
-- "quem respondia por esta empresa naquela data".
CREATE OR REPLACE FUNCTION "fdp_company_portfolio_close_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."valid_to" IS NOT NULL THEN
    RAISE EXCEPTION 'fdp_company_portfolio: vigência encerrada não muda';
  END IF;
  IF NEW."company_id" IS DISTINCT FROM OLD."company_id"
    OR NEW."holder_user_id" IS DISTINCT FROM OLD."holder_user_id"
    OR NEW."backup_user_id" IS DISTINCT FROM OLD."backup_user_id"
    OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
    OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id" THEN
    RAISE EXCEPTION 'fdp_company_portfolio: troque a carteira encerrando a vigência, não reescrevendo';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "fdp_company_portfolio_close_only" ON "fdp_company_portfolio";
--> statement-breakpoint
CREATE TRIGGER "fdp_company_portfolio_close_only" BEFORE UPDATE ON "fdp_company_portfolio"
  FOR EACH ROW EXECUTE FUNCTION "fdp_company_portfolio_close_only"();
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_company_portfolio" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_company_portfolio_workspace_isolation" ON "fdp_company_portfolio";
--> statement-breakpoint
CREATE POLICY "fdp_company_portfolio_workspace_isolation" ON "fdp_company_portfolio"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- Férias e folgas do analista. Na data em que o titular está ausente, a
-- demanda nova nasce com o backup.
CREATE TABLE IF NOT EXISTS "fdp_member_absences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"user_id" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_member_absences_period_check" CHECK ("ends_on" >= "starts_on"),
	CONSTRAINT "fdp_member_absences_reason_check" CHECK (length("reason") <= 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_member_absences_workspace_id_uq" ON "fdp_member_absences" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_member_absences_user_period_idx" ON "fdp_member_absences" USING btree ("workspace_id", "user_id", "starts_on", "ends_on");
--> statement-breakpoint
ALTER TABLE "fdp_member_absences" DROP CONSTRAINT IF EXISTS "fdp_member_absences_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_member_absences" ADD CONSTRAINT "fdp_member_absences_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_member_absences" DROP CONSTRAINT IF EXISTS "fdp_member_absences_member_fk";
--> statement-breakpoint
ALTER TABLE "fdp_member_absences" ADD CONSTRAINT "fdp_member_absences_member_fk"
  FOREIGN KEY ("workspace_id", "user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_member_absences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_member_absences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_member_absences_workspace_isolation" ON "fdp_member_absences";
--> statement-breakpoint
CREATE POLICY "fdp_member_absences_workspace_isolation" ON "fdp_member_absences"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
