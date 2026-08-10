-- O modelo de pedidos da Caju é planilha de texto separada por ";", não XLSX.
--
-- Registrar formato, delimitador e categoria evita dois erros caros: gerar o
-- arquivo com o separador errado, e exportar Saldo Livre usando o modelo de
-- outra categoria — o que creditaria o benefício errado sem ninguém perceber.
ALTER TABLE "fdp_caju_templates" ADD COLUMN IF NOT EXISTS "format" text DEFAULT 'csv' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_caju_templates" ADD COLUMN IF NOT EXISTS "delimiter" text DEFAULT ';' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_caju_templates" ADD COLUMN IF NOT EXISTS "category_key" text DEFAULT 'desconhecida' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_caju_templates" ADD COLUMN IF NOT EXISTS "amount_label" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_caju_templates" ADD CONSTRAINT "fdp_caju_templates_format_check"
  CHECK ("format" IN ('csv', 'tsv'));
