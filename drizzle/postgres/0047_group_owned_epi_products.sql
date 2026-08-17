-- O catálogo de EPI é patrimônio do grupo: produto, SKU e saldo não pertencem
-- a um CNPJ. A empresa continua obrigatória apenas nos fatos de consumo, nos
-- quais identifica o colaborador e a responsabilidade operacional.
-- allow-destructive-migration: company_id é removido somente do cadastro do
-- produto; os CNPJs históricos permanecem preservados nos eventos imutáveis.
DROP INDEX IF EXISTS "fdp_epi_products_workspace_company_name_idx";--> statement-breakpoint
ALTER TABLE "fdp_epi_products" DROP CONSTRAINT IF EXISTS "fdp_epi_products_workspace_purchasing_company_fk";--> statement-breakpoint
ALTER TABLE "fdp_epi_products" DROP COLUMN "company_id";--> statement-breakpoint

-- Cadastro, entrada, transferência entre locais e ajuste manual são fatos do
-- estoque compartilhado. O gatilho append-only é suspenso somente para esta
-- correção estrutural e reativado na mesma migration.
ALTER TABLE "fdp_epi_movements" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" DISABLE TRIGGER "fdp_epi_movements_append_only";--> statement-breakpoint
UPDATE "fdp_epi_movements"
SET "company_id" = NULL, "cnpj" = ''
WHERE "movement_type" IN ('registration', 'stock_entry', 'stock_transfer', 'manual_adjustment');--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ENABLE TRIGGER "fdp_epi_movements_append_only";--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_scope_check" CHECK (
  ("movement_type" IN ('registration', 'stock_entry', 'stock_transfer', 'manual_adjustment') AND "company_id" IS NULL)
  OR
  ("movement_type" NOT IN ('registration', 'stock_entry', 'stock_transfer', 'manual_adjustment') AND "company_id" IS NOT NULL)
);--> statement-breakpoint

-- Anexos do produto seguem o próprio produto e também são do grupo. Evidências
-- de entrega, dano, devolução, descarte e desconto continuam por empresa.
ALTER TABLE "fdp_epi_attachments" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "fdp_epi_attachments" SET "company_id" = NULL WHERE "entity_type" = 'product';--> statement-breakpoint
ALTER TABLE "fdp_epi_attachments" ADD CONSTRAINT "fdp_epi_attachments_scope_check" CHECK (
  ("entity_type" = 'product' AND "company_id" IS NULL)
  OR
  ("entity_type" <> 'product' AND "company_id" IS NOT NULL)
);--> statement-breakpoint
