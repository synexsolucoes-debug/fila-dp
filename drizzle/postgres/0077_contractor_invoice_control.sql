-- Controle e validação de notas fiscais dentro da competência PJ.
--
-- O fechamento PJ já sabia o número da nota, o valor recebido e a data de
-- emissão — três colunas soltas, sobrescritas a cada envio. Isso responde
-- "qual é a nota", nunca "quem conferiu, quando, e o que havia antes".
-- Documento financeiro não se sobrescreve em silêncio: cada envio vira um
-- registro próprio, o anterior é preservado e substituído explicitamente, e
-- toda decisão de conferência entra no histórico.
SELECT pg_advisory_xact_lock(hashtext('0077_contractor_invoice_control'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_contractor_invoices" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT current_setting('app.workspace_id', true) NOT NULL,
  "company_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "payroll_cycle_id" text NOT NULL,
  "closing_id" text NOT NULL,
  "competence" text NOT NULL,
  -- Ordem do envio dentro do fechamento: 1 é a primeira nota, 2 a substituta.
  "attempt" integer DEFAULT 1 NOT NULL,
  "invoice_number" text NOT NULL,
  "series" text DEFAULT '' NOT NULL,
  "issue_date" date NOT NULL,
  "issuer_document" text DEFAULT '' NOT NULL,
  "issuer_name" text DEFAULT '' NOT NULL,
  "receiver_document" text DEFAULT '' NOT NULL,
  "service_description" text DEFAULT '' NOT NULL,
  "amount" numeric(18, 2) NOT NULL,
  -- Valor esperado congelado no momento do envio: reapurar a competência depois
  -- não pode reescrever o que foi conferido.
  "expected_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
  "difference_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "document_id" text,
  "checklist_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  -- Envio aceito apesar do alerta de duplicidade, com quem aceitou no histórico.
  "duplicate_ack" boolean DEFAULT false NOT NULL,
  "uploaded_by" text NOT NULL,
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "uploaded_ip" text DEFAULT '' NOT NULL,
  "uploaded_user_agent" text DEFAULT '' NOT NULL,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "review_note" text DEFAULT '' NOT NULL,
  "rejection_reason" text DEFAULT '' NOT NULL,
  "rejection_detail" text DEFAULT '' NOT NULL,
  "replaces_invoice_id" text,
  "replaced_by_invoice_id" text,
  -- Nota que deixou de ser a vigente do fechamento. Nunca apagada.
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_contractor_invoices_competence_check"
    CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "fdp_contractor_invoices_status_check"
    CHECK ("status" IN ('received', 'under_review', 'approved', 'rejected', 'correction_requested', 'replaced', 'canceled')),
  CONSTRAINT "fdp_contractor_invoices_number_check"
    CHECK (length(trim("invoice_number")) BETWEEN 1 AND 80),
  CONSTRAINT "fdp_contractor_invoices_amount_check"
    CHECK ("amount" >= 0 AND "expected_amount" >= 0),
  CONSTRAINT "fdp_contractor_invoices_difference_check"
    CHECK ("difference_amount" = "amount" - "expected_amount"),
  CONSTRAINT "fdp_contractor_invoices_attempt_check"
    CHECK ("attempt" >= 1),
  -- Recusar sem motivo é recusar sem explicação: a nota volta para o prestador
  -- e ninguém sabe o que corrigir.
  CONSTRAINT "fdp_contractor_invoices_rejection_check"
    CHECK ("status" NOT IN ('rejected', 'correction_requested') OR length(trim("rejection_reason")) > 0),
  -- "Outro" só vale com descrição; é a única razão que não se explica sozinha.
  CONSTRAINT "fdp_contractor_invoices_rejection_detail_check"
    CHECK ("rejection_reason" <> 'other' OR length(trim("rejection_detail")) >= 5),
  -- Aprovar é um ato de alguém, em algum momento: os dois campos ou nenhum.
  CONSTRAINT "fdp_contractor_invoices_review_check"
    CHECK ("status" NOT IN ('approved', 'rejected', 'correction_requested')
      OR ("reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)),
  CONSTRAINT "fdp_contractor_invoices_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_contractor_invoices_company_fk"
    FOREIGN KEY ("workspace_id", "company_id") REFERENCES "fdp_companies"("workspace_id", "id"),
  CONSTRAINT "fdp_contractor_invoices_provider_fk"
    FOREIGN KEY ("workspace_id", "provider_id") REFERENCES "fdp_auxiliary_providers"("workspace_id", "id"),
  CONSTRAINT "fdp_contractor_invoices_cycle_fk"
    FOREIGN KEY ("workspace_id", "company_id", "payroll_cycle_id")
    REFERENCES "fdp_payroll_cycles"("workspace_id", "company_id", "id"),
  CONSTRAINT "fdp_contractor_invoices_closing_fk"
    FOREIGN KEY ("workspace_id", "closing_id") REFERENCES "fdp_contractor_closings"("workspace_id", "id"),
  CONSTRAINT "fdp_contractor_invoices_document_fk"
    FOREIGN KEY ("workspace_id", "document_id") REFERENCES "fdp_contractor_documents"("workspace_id", "id"),
  CONSTRAINT "fdp_contractor_invoices_uploader_fk"
    FOREIGN KEY ("workspace_id", "uploaded_by") REFERENCES "fdp_workspace_members"("workspace_id", "user_id"),
  CONSTRAINT "fdp_contractor_invoices_reviewer_fk"
    FOREIGN KEY ("workspace_id", "reviewed_by") REFERENCES "fdp_workspace_members"("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoices_workspace_id_uq"
  ON "fdp_contractor_invoices" ("workspace_id", "id");
--> statement-breakpoint
-- As duas chaves de substituição apontam para a própria tabela e só podem ser
-- criadas depois do índice acima: o PostgreSQL exige que as colunas
-- referenciadas já estejam cobertas por unicidade no momento da criação.
ALTER TABLE "fdp_contractor_invoices" DROP CONSTRAINT IF EXISTS "fdp_contractor_invoices_replaces_fk";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices"
  ADD CONSTRAINT "fdp_contractor_invoices_replaces_fk"
  FOREIGN KEY ("workspace_id", "replaces_invoice_id") REFERENCES "fdp_contractor_invoices"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices" DROP CONSTRAINT IF EXISTS "fdp_contractor_invoices_replaced_by_fk";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices"
  ADD CONSTRAINT "fdp_contractor_invoices_replaced_by_fk"
  FOREIGN KEY ("workspace_id", "replaced_by_invoice_id") REFERENCES "fdp_contractor_invoices"("workspace_id", "id");
--> statement-breakpoint
-- Um fechamento tem uma nota vigente por vez. As anteriores continuam na tabela
-- com `superseded_at` preenchido — é assim que o histórico de versões existe
-- sem que duas notas disputem o mesmo pagamento.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoices_current_uq"
  ON "fdp_contractor_invoices" ("workspace_id", "closing_id")
  WHERE "superseded_at" IS NULL;
--> statement-breakpoint
-- Duplicidade: mesmo emissor, mesmo número, mesma série. O índice é parcial
-- porque uma nota recusada pode legitimamente ser reemitida com o mesmo número
-- depois de corrigida — o que não pode é haver duas valendo ao mesmo tempo.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoices_duplicate_uq"
  ON "fdp_contractor_invoices" ("workspace_id", "provider_id", "issuer_document", "invoice_number", "series")
  WHERE "superseded_at" IS NULL AND "status" NOT IN ('rejected', 'canceled', 'replaced');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_competence_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "competence", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_cycle_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "payroll_cycle_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_closing_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "closing_id", "attempt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_provider_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "provider_id", "competence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_reviewer_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "reviewed_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_document_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_replaces_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "replaces_invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_replaced_by_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "replaced_by_invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoices_uploader_idx"
  ON "fdp_contractor_invoices" ("workspace_id", "uploaded_by");
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_contractor_invoices_workspace_isolation" ON "fdp_contractor_invoices";
--> statement-breakpoint
CREATE POLICY "fdp_contractor_invoices_workspace_isolation" ON "fdp_contractor_invoices"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- Histórico da nota: uma linha por fato, nunca atualizada.
CREATE TABLE IF NOT EXISTS "fdp_contractor_invoice_events" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT current_setting('app.workspace_id', true) NOT NULL,
  "invoice_id" text NOT NULL,
  "closing_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "competence" text NOT NULL,
  "action" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "before_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "after_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_contractor_invoice_events_competence_check"
    CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "fdp_contractor_invoice_events_action_check"
    CHECK ("action" IN ('uploaded', 'submitted', 'approved', 'rejected', 'correction_requested',
      'replaced', 'superseded', 'reviewer_assigned', 'updated', 'canceled')),
  CONSTRAINT "fdp_contractor_invoice_events_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_contractor_invoice_events_invoice_fk"
    FOREIGN KEY ("workspace_id", "invoice_id") REFERENCES "fdp_contractor_invoices"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_contractor_invoice_events_actor_fk"
    FOREIGN KEY ("workspace_id", "actor_user_id") REFERENCES "fdp_workspace_members"("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoice_events_workspace_id_uq"
  ON "fdp_contractor_invoice_events" ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_events_invoice_idx"
  ON "fdp_contractor_invoice_events" ("workspace_id", "invoice_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_events_closing_idx"
  ON "fdp_contractor_invoice_events" ("workspace_id", "closing_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_invoice_events_actor_idx"
  ON "fdp_contractor_invoice_events" ("workspace_id", "actor_user_id");
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_invoice_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_contractor_invoice_events_workspace_isolation" ON "fdp_contractor_invoice_events";
--> statement-breakpoint
CREATE POLICY "fdp_contractor_invoice_events_workspace_isolation" ON "fdp_contractor_invoice_events"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- O fechamento passa a carregar a situação da conferência, ao lado da
-- comparação de valores que ele já fazia. São perguntas diferentes:
-- `invoice_status` diz se o valor bate, `invoice_review_status` diz se alguém
-- conferiu e o que decidiu.
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN IF NOT EXISTS "invoice_review_status" text DEFAULT 'not_required' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN IF NOT EXISTS "invoice_current_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" DROP CONSTRAINT IF EXISTS "fdp_contractor_closings_invoice_review_status_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD CONSTRAINT "fdp_contractor_closings_invoice_review_status_check"
  CHECK ("invoice_review_status" IN ('not_required', 'awaiting_issue', 'received', 'under_review',
    'approved', 'rejected', 'correction_requested'));
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings" DROP CONSTRAINT IF EXISTS "fdp_contractor_closings_invoice_current_fk";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD CONSTRAINT "fdp_contractor_closings_invoice_current_fk"
  FOREIGN KEY ("workspace_id", "invoice_current_id") REFERENCES "fdp_contractor_invoices"("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_closings_invoice_review_idx"
  ON "fdp_contractor_closings" ("workspace_id", "payroll_cycle_id", "invoice_review_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_closings_invoice_current_idx"
  ON "fdp_contractor_closings" ("workspace_id", "invoice_current_id");
--> statement-breakpoint
-- Estado inicial coerente com o que já existe: quem tem nota a emitir e nada
-- registrado está aguardando; quem já tinha número registrado entra como
-- recebida, para conferência.
UPDATE "fdp_contractor_closings"
  SET "invoice_review_status" = CASE
    WHEN "invoice_expected_amount" <= 0 THEN 'not_required'
    WHEN "invoice_number" <> '' THEN 'received'
    ELSE 'awaiting_issue' END
  WHERE "invoice_review_status" = 'not_required';
--> statement-breakpoint

-- A política de conferência é do grupo e muda sem deploy: exigir aprovação da
-- nota antes de liberar o pagamento é decisão de quem opera o financeiro.
ALTER TABLE "fdp_workspace_settings"
  ADD COLUMN IF NOT EXISTS "invoice_review_policy" text DEFAULT 'required' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings"
  ADD COLUMN IF NOT EXISTS "invoice_required_checks_json" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings" DROP CONSTRAINT IF EXISTS "fdp_workspace_settings_invoice_review_policy_check";
--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings"
  ADD CONSTRAINT "fdp_workspace_settings_invoice_review_policy_check"
  CHECK ("invoice_review_policy" IN ('required', 'optional'));
