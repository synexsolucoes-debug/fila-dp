-- Concorrência otimista onde as pessoas realmente colidem (§34, §35).
--
-- O produto já protegia a **transição de estado**: as rotas de fechamento e de
-- ponto atualizam com `AND status = ?`, então dois cliques em "aprovar" não
-- aprovam duas vezes. O que não estava protegido é a **edição concorrente**:
-- duas pessoas abrindo o mesmo fechamento, cada uma alterando um campo, e a
-- última escrita apagando a primeira sem que ninguém perceba.
--
-- A coluna `version` fecha isso. O incremento fica em trigger, e não espalhado
-- por cada `UPDATE`, por um motivo prático: existem dezenas de caminhos de
-- escrita nestas tabelas, e um deles esquecer de incrementar transformaria a
-- coluna em decoração — pior do que não existir, porque passaria a dar falsa
-- garantia.
--
-- Quem quer a garantia acrescenta `AND version = ?` ao próprio `UPDATE` e trata
-- zero linhas como 409. Quem não acrescenta continua funcionando como antes.
--
-- `fdp_cards` recebeu a coluna na 0058 e o incremento manual; aqui ele passa a
-- vir do mesmo trigger, para que a regra seja uma só nas três tabelas.
SELECT pg_advisory_xact_lock(hashtext('0061_optimistic_concurrency'));
--> statement-breakpoint

ALTER TABLE "fdp_contractor_closings" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" DROP CONSTRAINT IF EXISTS "fdp_contractor_closings_version_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" ADD CONSTRAINT "fdp_contractor_closings_version_check" CHECK ("version" > 0);
--> statement-breakpoint

ALTER TABLE "fdp_time_sheets" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" DROP CONSTRAINT IF EXISTS "fdp_time_sheets_version_check";
--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_version_check" CHECK ("version" > 0);
--> statement-breakpoint

-- O incremento.
--
-- `IS DISTINCT FROM` na comparação da linha inteira evita contar como alteração
-- um `UPDATE` que não mudou nada — o que aconteceria em toda escrita
-- idempotente e faria a versão avançar sem ninguém ter editado.
CREATE OR REPLACE FUNCTION fdp_bump_row_version() RETURNS trigger AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "fdp_cards_version_bump" ON "fdp_cards";
--> statement-breakpoint
CREATE TRIGGER "fdp_cards_version_bump" BEFORE UPDATE ON "fdp_cards"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "fdp_contractor_closings_version_bump" ON "fdp_contractor_closings";
--> statement-breakpoint
CREATE TRIGGER "fdp_contractor_closings_version_bump" BEFORE UPDATE ON "fdp_contractor_closings"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "fdp_time_sheets_version_bump" ON "fdp_time_sheets";
--> statement-breakpoint
CREATE TRIGGER "fdp_time_sheets_version_bump" BEFORE UPDATE ON "fdp_time_sheets"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();
