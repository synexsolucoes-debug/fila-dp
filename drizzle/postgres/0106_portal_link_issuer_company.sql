-- Portal do prestador: a empresa que recebe a nota é a emitente escolhida ao
-- gerar os links, não necessariamente a empresa do fechamento.
--
-- `company_id` do link é a empresa do fechamento do prestador (é por ela que o
-- link é listado e que a nota é registrada). A página do prestador lia a razão
-- social e o CNPJ dela, então mostrava sempre a empresa do fechamento mesmo
-- quando quem gerou o arquivo escolheu outra para constar na mensagem. A
-- emitente passa a ser gravada no link; nula nos links antigos, que seguem
-- usando `company_id`.
SELECT pg_advisory_xact_lock(hashtext('0106_portal_link_issuer_company'));
--> statement-breakpoint

ALTER TABLE "fdp_contractor_invoice_portal_links" ADD COLUMN IF NOT EXISTS "issuer_company_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_portal_links" DROP CONSTRAINT IF EXISTS "fdp_contractor_invoice_portal_links_issuer_company_fk";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_portal_links" ADD CONSTRAINT "fdp_contractor_invoice_portal_links_issuer_company_fk"
  FOREIGN KEY ("workspace_id", "issuer_company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");
