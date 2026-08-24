-- Autorização explícita, por demanda, para trazer documentos da Sólides.
--
-- O worker continua sem permissão para aprovar, alterar ou excluir qualquer
-- coisa no Tangerino. Esta fila libera somente dois downloads de leitura
-- (documentos da admissão e ficha cadastral) e somente para o cartão que a
-- pessoa autorizou. A autorização expira e não pode ser reaproveitada para
-- outro colaborador.
SELECT pg_advisory_xact_lock(hashtext('0068_tangerino_solides_attachments'));
--> statement-breakpoint

ALTER TABLE "fdp_card_attachments"
  ADD COLUMN IF NOT EXISTS "source_type" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments"
  ADD COLUMN IF NOT EXISTS "source_reference" text;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" DROP CONSTRAINT IF EXISTS "fdp_card_attachments_source_type_check";
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD CONSTRAINT "fdp_card_attachments_source_type_check"
  CHECK ("source_type" IN ('manual', 'solides'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_card_attachments_source_reference_uq"
  ON "fdp_card_attachments" ("workspace_id", "source_type", "source_reference")
  WHERE "source_reference" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_tangerino_attachment_authorizations" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "card_id" text NOT NULL,
  "employee_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "external_admission_id" text NOT NULL,
  "authorized_by_user_id" text NOT NULL,
  "state" text DEFAULT 'QUEUED' NOT NULL,
  "error_code" text DEFAULT '' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "expected_count" integer DEFAULT 0 NOT NULL,
  "uploaded_count" integer DEFAULT 0 NOT NULL,
  "authorized_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz DEFAULT (now() + interval '24 hours') NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_tangerino_attachment_authorizations_state_check"
    CHECK ("state" IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT "fdp_tangerino_attachment_authorizations_external_id_check"
    CHECK (length("external_admission_id") > 0),
  CONSTRAINT "fdp_tangerino_attachment_authorizations_counts_check"
    CHECK ("attempt" >= 0 AND "expected_count" >= 0 AND "uploaded_count" >= 0),
  CONSTRAINT "fdp_tangerino_attachment_authorizations_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "fdp_tangerino_attachment_authorizations_workspace_card_fk"
    FOREIGN KEY ("workspace_id", "card_id") REFERENCES "fdp_cards"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_tangerino_attachment_authorizations_workspace_employee_fk"
    FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "fdp_employees"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_tangerino_attachment_authorizations_workspace_integration_fk"
    FOREIGN KEY ("workspace_id", "integration_id") REFERENCES "fdp_integrations"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_tangerino_attachment_authorizations_workspace_user_fk"
    FOREIGN KEY ("workspace_id", "authorized_by_user_id") REFERENCES "fdp_workspace_members"("workspace_id", "user_id") ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_attachment_authorizations_workspace_id_uq"
  ON "fdp_tangerino_attachment_authorizations" ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_attachment_authorizations_active_uq"
  ON "fdp_tangerino_attachment_authorizations" ("workspace_id", "card_id")
  WHERE "state" IN ('QUEUED', 'RUNNING');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_attachment_authorizations_completed_uq"
  ON "fdp_tangerino_attachment_authorizations" ("workspace_id", "card_id")
  WHERE "state" = 'COMPLETED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_tangerino_attachment_authorizations_queue_idx"
  ON "fdp_tangerino_attachment_authorizations" ("workspace_id", "state", "authorized_at");
--> statement-breakpoint

ALTER TABLE "fdp_tangerino_attachment_authorizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_tangerino_attachment_authorizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_tangerino_attachment_authorizations_workspace_isolation"
  ON "fdp_tangerino_attachment_authorizations"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
