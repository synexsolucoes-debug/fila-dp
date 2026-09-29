-- Aprovação em múltiplas etapas, passo 1 (§3.11): registrar cada aprovador.
--
-- `fdp_process_step_configs.approval_count`/`approval_mode` sempre existiram
-- (0013) e sempre eram configuráveis no editor de processo, mas quem
-- avançava a etapa exigindo aprovação já contava como o único aprovador
-- necessário — não havia onde registrar a segunda aprovação de uma etapa
-- configurada para exigir três. `approvalCount > 1` era exatamente o mesmo
-- "seletor que promete e o motor que não cumpre" já visto em §3.6 e §3.9,
-- desta vez do lado da aprovação.
--
-- Cada linha é "esta pessoa aprovou esta etapa desta demanda". Uma por
-- aprovador por etapa-demanda (índice único): aprovar de novo não soma duas
-- vezes, e não existe "desaprovar" — quem discorda pede que outro aprovador
-- decida, do mesmo jeito que o resto do produto trata decisão já tomada.
SELECT pg_advisory_xact_lock(hashtext('0105_process_step_approvals'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_process_step_approvals" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text DEFAULT current_setting('app.workspace_id', true) NOT NULL,
  "card_id" text NOT NULL,
  "process_version_id" text NOT NULL,
  "bpmn_element_id" text NOT NULL,
  "approver_user_id" text NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_process_step_approvals_workspace_card_fk"
    FOREIGN KEY ("workspace_id", "card_id") REFERENCES "fdp_cards"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fdp_process_step_approvals_workspace_version_fk"
    FOREIGN KEY ("workspace_id", "process_version_id") REFERENCES "fdp_process_versions"("workspace_id", "id"),
  CONSTRAINT "fdp_process_step_approvals_workspace_approver_fk"
    FOREIGN KEY ("workspace_id", "approver_user_id") REFERENCES "fdp_workspace_members"("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_process_step_approvals_workspace_id_uq"
  ON "fdp_process_step_approvals" ("workspace_id", "id");
--> statement-breakpoint
-- A trava real: uma pessoa aprova a mesma etapa da mesma demanda uma vez só.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_process_step_approvals_step_approver_uq"
  ON "fdp_process_step_approvals" ("workspace_id", "card_id", "bpmn_element_id", "approver_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_process_step_approvals_card_step_idx"
  ON "fdp_process_step_approvals" ("workspace_id", "card_id", "bpmn_element_id");
--> statement-breakpoint
ALTER TABLE "fdp_process_step_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_process_step_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_process_step_approvals_workspace_isolation" ON "fdp_process_step_approvals";
--> statement-breakpoint
CREATE POLICY "fdp_process_step_approvals_workspace_isolation" ON "fdp_process_step_approvals"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
