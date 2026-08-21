-- Notas fiscais anexadas ficam vinculadas ao prestador, contrato/fechamento e
-- competência. A tabela guarda somente metadados; o binário permanece no Blob
-- privado e é servido por uma rota autenticada.
CREATE TABLE "fdp_contractor_documents" (
 "id" text PRIMARY KEY NOT NULL,
 "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
 "company_id" text NOT NULL,
 "provider_id" text NOT NULL,
 "closing_id" text NOT NULL,
 "document_kind" text DEFAULT 'invoice' NOT NULL,
 "competence" text NOT NULL,
 "invoice_number" text DEFAULT '' NOT NULL,
 "object_key" text NOT NULL,
 "filename" text NOT NULL,
 "content_type" text NOT NULL,
 "size_bytes" bigint NOT NULL,
 "created_by" text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "fdp_contractor_documents_kind_check" CHECK ("document_kind" IN ('invoice')),
 CONSTRAINT "fdp_contractor_documents_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 CONSTRAINT "fdp_contractor_documents_size_check" CHECK ("size_bytes" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_contractor_documents_workspace_id_uq" ON "fdp_contractor_documents" ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_contractor_documents_object_key_uq" ON "fdp_contractor_documents" ("object_key");--> statement-breakpoint
CREATE INDEX "fdp_contractor_documents_workspace_provider_idx" ON "fdp_contractor_documents" ("workspace_id","provider_id","created_at");--> statement-breakpoint
CREATE INDEX "fdp_contractor_documents_workspace_closing_idx" ON "fdp_contractor_documents" ("workspace_id","closing_id","created_at");--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" ADD CONSTRAINT "fdp_contractor_documents_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" ADD CONSTRAINT "fdp_contractor_documents_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" ADD CONSTRAINT "fdp_contractor_documents_workspace_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" ADD CONSTRAINT "fdp_contractor_documents_workspace_closing_fk" FOREIGN KEY ("workspace_id","closing_id") REFERENCES "public"."fdp_contractor_closings"("workspace_id","id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" ADD CONSTRAINT "fdp_contractor_documents_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_contractor_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_contractor_documents_workspace_isolation" ON "fdp_contractor_documents" USING ("workspace_id"=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK ("workspace_id"=NULLIF(current_setting('app.workspace_id',true),''));
