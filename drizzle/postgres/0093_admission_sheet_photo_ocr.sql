-- Sugestões de campo por OCR de fotos de documento (RG, CPF, CTPS).
--
-- ## Por que é sugestão, e por que a tabela é separada de fdp_admission_sheets
--
-- A ficha de contratação lê o Registro de Empregado — documento de layout
-- fixo, texto selecionável. A foto de um RG ou CTPS não tem essa garantia:
-- layout varia por estado, a foto pode estar torta ou mal iluminada, e o OCR
-- erra mais. Por isso o resultado nunca é escrito direto na ficha — vive
-- aqui, como candidato, até uma pessoa confirmar (pelo mesmo caminho de
-- "Corrigir/Preencher" que a ficha já tem). Ver lib/photo-document-fields.ts.
--
-- Uma linha por anexo (não por demanda): a pessoa pode anexar RG, CPF e CTPS
-- em fotos separadas, e cada uma tem seu próprio resultado de OCR.
--
-- ## O mesmo par cifrado/aberto de fdp_admission_sheets
--
-- O valor sugerido (CPF, nome, data) é documento pessoal — cifrado no mesmo
-- envelope AES-256-GCM. A confiança por campo ("achei um CPF válido") é
-- metadado de qualidade da leitura, não conteúdo, e por isso fica em coluna
-- aberta, como já acontece com warnings_json em fdp_admission_sheets.
SELECT pg_advisory_xact_lock(hashtext('0093_admission_sheet_photo_ocr'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_admission_sheet_photo_ocr" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"card_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"source_filename" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"encrypted_value" text,
	"initialization_vector" text,
	"auth_tag" text,
	"key_version" integer,
	"confidence_json" text DEFAULT '{}' NOT NULL,
	"warnings_json" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_admission_sheet_photo_ocr_state_check" CHECK ("state" IN ('pending', 'ready', 'failed')),
	CONSTRAINT "fdp_admission_sheet_photo_ocr_ready_envelope_check"
	  CHECK ("state" <> 'ready' OR ("encrypted_value" IS NOT NULL AND "initialization_vector" IS NOT NULL
	    AND "auth_tag" IS NOT NULL AND "key_version" IS NOT NULL)),
	CONSTRAINT "fdp_admission_sheet_photo_ocr_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 20)
);
--> statement-breakpoint

-- Um resultado de OCR por anexo. Reler substitui, nunca acumula.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_admission_sheet_photo_ocr_attachment_uq"
  ON "fdp_admission_sheet_photo_ocr" USING btree ("workspace_id", "attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_admission_sheet_photo_ocr_workspace_id_uq"
  ON "fdp_admission_sheet_photo_ocr" USING btree ("workspace_id", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_admission_sheet_photo_ocr_card_idx"
  ON "fdp_admission_sheet_photo_ocr" USING btree ("workspace_id", "card_id");--> statement-breakpoint

-- A fila do preparo: quem está pendente, mais antigo primeiro. Mesmo desenho
-- do índice parcial de fdp_admission_sheets_pending_idx.
CREATE INDEX IF NOT EXISTS "fdp_admission_sheet_photo_ocr_pending_idx"
  ON "fdp_admission_sheet_photo_ocr" USING btree ("workspace_id", "last_attempt_at" NULLS FIRST)
  WHERE "state" = 'pending';--> statement-breakpoint

ALTER TABLE "fdp_admission_sheet_photo_ocr" ADD CONSTRAINT "fdp_admission_sheet_photo_ocr_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheet_photo_ocr" ADD CONSTRAINT "fdp_admission_sheet_photo_ocr_card_fk"
  FOREIGN KEY ("workspace_id","card_id") REFERENCES "public"."fdp_cards"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheet_photo_ocr" ADD CONSTRAINT "fdp_admission_sheet_photo_ocr_attachment_fk"
  FOREIGN KEY ("workspace_id","attachment_id") REFERENCES "public"."fdp_card_attachments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fdp_admission_sheet_photo_ocr" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheet_photo_ocr" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_admission_sheet_photo_ocr_workspace_isolation" ON "fdp_admission_sheet_photo_ocr"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
