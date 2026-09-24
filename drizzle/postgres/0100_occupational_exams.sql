-- Controle de exames ocupacionais (ASO) — passo 1.
--
-- A análise de produto de set/2026 apontou isto como item de alto impacto e
-- passivo de SESMT: sem um registro estruturado do exame, "está apto?" e
-- "quando vence o próximo?" moram em planilha ou memória, e um ASO vencido em
-- atividade de risco é multa (NR-7) além de exposição jurídica.
--
-- O módulo segue a mesma fronteira já praticada em Psicologia
-- (tests/psychology-clinical-boundary.test.mts): resultado e restrição
-- funcional entram, diagnóstico não. `result` é fechado em apto/inapto/apto
-- com restrição — nunca a doença ou o exame clínico que levou à conclusão.
-- `restriction_notes` descreve a restrição de função ("não pode carregar peso
-- acima de 10kg"), não a causa clínica dela.
--
-- Diferente do Dashboard de Acidente de Trabalho (0083), que anonimiza o
-- colaborador porque é estatístico, o ASO existe justamente para responder
-- "este colaborador específico está com o exame em dia?" — por isso tem FK
-- para fdp_employees, no mesmo padrão de fdp_psychology_sessions.
SELECT pg_advisory_xact_lock(hashtext('0100_occupational_exams'));
--> statement-breakpoint

CREATE TABLE "fdp_occupational_exams" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"exam_type" text NOT NULL,
	"exam_date" date NOT NULL,
	"result" text NOT NULL,
	"restriction_notes" text DEFAULT '' NOT NULL,
	"next_due_date" date,
	"clinic_name" text DEFAULT '' NOT NULL,
	"doctor_name" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_occupational_exams_type_check" CHECK ("exam_type" IN ('admission', 'periodic', 'return_to_work', 'role_change', 'termination', 'other')),
	CONSTRAINT "fdp_occupational_exams_result_check" CHECK ("result" IN ('fit', 'unfit', 'fit_with_restriction')),
	-- Restrição funcional só faz sentido quando o exame concluiu apto com
	-- restrição: em "apto" ou "inapto" ela ficaria dizendo uma condição que o
	-- próprio resultado já contradiz ou já não importa mais.
	CONSTRAINT "fdp_occupational_exams_restriction_check" CHECK ("result" = 'fit_with_restriction' OR "restriction_notes" = '')
);
--> statement-breakpoint

CREATE UNIQUE INDEX "fdp_occupational_exams_workspace_id_uq" ON "fdp_occupational_exams" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX "fdp_occupational_exams_workspace_employee_idx" ON "fdp_occupational_exams" USING btree ("workspace_id", "employee_id", "exam_date");
--> statement-breakpoint
-- O Motor de Prazos lê "o que vence quando": o índice serve a mesma pergunta
-- que já serve fdp_compliance_obligations e fdp_epi_products.
CREATE INDEX "fdp_occupational_exams_workspace_due_idx" ON "fdp_occupational_exams" USING btree ("workspace_id", "next_due_date") WHERE "next_due_date" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "fdp_occupational_exams" ADD CONSTRAINT "fdp_occupational_exams_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_occupational_exams" ADD CONSTRAINT "fdp_occupational_exams_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_occupational_exams" ADD CONSTRAINT "fdp_occupational_exams_employee_fk"
  FOREIGN KEY ("workspace_id", "company_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "company_id", "id") ON DELETE cascade;
--> statement-breakpoint

ALTER TABLE "fdp_occupational_exams" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_occupational_exams" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_occupational_exams_workspace_isolation" ON "fdp_occupational_exams"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
