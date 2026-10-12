-- ERP DP, passo 3 (docs/engenharia-reversa-sap-hcm.md §16, itens 3, 6 e 7).
--
-- 1. Importadores pelo histórico: a sincronização com o Sankhya passa a
--    gravar o histórico funcional, com motivo próprio — `integration_sync` —
--    para a linha do tempo dizer que a mudança veio da origem, e não de alguém
--    no Vinculato.
-- 2. Elementos contratuais (IT0016 + IT0019 do SAP): tipo de contrato, fim da
--    experiência (art. 445, parágrafo único, da CLT: até 90 dias, uma
--    prorrogação), fim do prazo determinado (até 2 anos) e aviso prévio (Lei
--    12.506/2011: 30 dias + 3 por ano completo, até 90). Só prazos: nenhum
--    valor de verba.
-- 3. Conferência do eSocial: o que a pessoa confirmou sobre cada evento que o
--    histórico exige — transmitido (com recibo) ou não se aplica. O Vinculato
--    não transmite; ele guarda a conferência.
SELECT pg_advisory_xact_lock(hashtext('0109_erp_dp_contract_terms_esocial_checks'));
--> statement-breakpoint

ALTER TABLE "fdp_employee_history_records" DROP CONSTRAINT IF EXISTS "fdp_employee_history_records_reason_check";
--> statement-breakpoint
ALTER TABLE "fdp_employee_history_records" ADD CONSTRAINT "fdp_employee_history_records_reason_check"
  CHECK ("reason" IN ('baseline', 'leave', 'return_to_work', 'termination', 'transfer', 'registration_edit', 'integration_sync'));
--> statement-breakpoint

CREATE TABLE "fdp_employee_contract_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"employee_id" text NOT NULL,
	"contract_kind" text DEFAULT 'indefinite' NOT NULL,
	-- Fim do primeiro período da experiência, quando ela é dividida em dois.
	"experience_first_end" date,
	-- Fim do contrato a termo: experiência (já com a prorrogação) ou prazo determinado.
	"contract_end" date,
	"notice_kind" text,
	"notice_start" date,
	"notice_days" integer,
	"notice_end" date,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_employee_contract_terms_kind_check" CHECK ("contract_kind" IN ('indefinite', 'experience', 'fixed_term')),
	-- Contrato a termo precisa de fim; indeterminado não tem.
	CONSTRAINT "fdp_employee_contract_terms_end_check" CHECK (("contract_kind" = 'indefinite') = ("contract_end" IS NULL)),
	CONSTRAINT "fdp_employee_contract_terms_first_end_check" CHECK ("experience_first_end" IS NULL OR ("contract_kind" = 'experience' AND "experience_first_end" < "contract_end")),
	CONSTRAINT "fdp_employee_contract_terms_notice_kind_check" CHECK ("notice_kind" IS NULL OR "notice_kind" IN ('worked', 'indemnified')),
	-- Aviso prévio é tudo ou nada: tipo, início, dias e fim juntos.
	CONSTRAINT "fdp_employee_contract_terms_notice_check" CHECK (
		("notice_kind" IS NULL AND "notice_start" IS NULL AND "notice_days" IS NULL AND "notice_end" IS NULL)
		OR ("notice_kind" IS NOT NULL AND "notice_start" IS NOT NULL AND "notice_days" BETWEEN 30 AND 90 AND "notice_end" >= "notice_start"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employee_contract_terms_workspace_id_uq" ON "fdp_employee_contract_terms" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- Um registro por colaborador: é o contrato vigente, não um histórico.
CREATE UNIQUE INDEX "fdp_employee_contract_terms_employee_uq" ON "fdp_employee_contract_terms" USING btree ("workspace_id", "employee_id");
--> statement-breakpoint
CREATE INDEX "fdp_employee_contract_terms_contract_end_idx" ON "fdp_employee_contract_terms" USING btree ("workspace_id", "contract_end") WHERE "contract_end" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "fdp_employee_contract_terms_notice_end_idx" ON "fdp_employee_contract_terms" USING btree ("workspace_id", "notice_end") WHERE "notice_end" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_employee_contract_terms" ADD CONSTRAINT "fdp_employee_contract_terms_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_contract_terms" ADD CONSTRAINT "fdp_employee_contract_terms_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_contract_terms" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employee_contract_terms" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_employee_contract_terms_workspace_isolation" ON "fdp_employee_contract_terms"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

CREATE TABLE "fdp_esocial_event_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"employee_id" text NOT NULL,
	-- O registro do histórico funcional que exige o evento.
	"history_record_id" text NOT NULL,
	"event_code" text NOT NULL,
	"event_date" date NOT NULL,
	"status" text NOT NULL,
	"receipt" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_esocial_event_checks_event_check" CHECK ("event_code" IN ('S-2206', 'S-2230', 'S-2299')),
	CONSTRAINT "fdp_esocial_event_checks_status_check" CHECK ("status" IN ('transmitted', 'not_applicable')),
	-- "Transmitido" sem recibo é afirmação sem prova.
	CONSTRAINT "fdp_esocial_event_checks_receipt_check" CHECK ("status" <> 'transmitted' OR length(trim("receipt")) > 0),
	CONSTRAINT "fdp_esocial_event_checks_not_applicable_check" CHECK ("status" <> 'not_applicable' OR length(trim("notes")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_esocial_event_checks_workspace_id_uq" ON "fdp_esocial_event_checks" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- Uma conferência por evento esperado. O evento é identificado pelo registro
-- do histórico que o exige, pelo código e pela data que ele informa — a mesma
-- chave que `expectedEsocialEvents` (lib/erp-dp.ts) produz.
CREATE UNIQUE INDEX "fdp_esocial_event_checks_event_uq" ON "fdp_esocial_event_checks" USING btree ("workspace_id", "history_record_id", "event_code", "event_date");
--> statement-breakpoint
ALTER TABLE "fdp_esocial_event_checks" ADD CONSTRAINT "fdp_esocial_event_checks_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_esocial_event_checks" ADD CONSTRAINT "fdp_esocial_event_checks_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_esocial_event_checks" ADD CONSTRAINT "fdp_esocial_event_checks_record_fk"
  FOREIGN KEY ("workspace_id", "history_record_id") REFERENCES "public"."fdp_employee_history_records"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_esocial_event_checks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_esocial_event_checks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_esocial_event_checks_workspace_isolation" ON "fdp_esocial_event_checks"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
