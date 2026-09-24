-- Treinamentos obrigatórios (NR), passo 1.
--
-- A análise de produto apontou o mesmo passivo do ASO, com a mesma causa:
-- "quando vence o próximo treinamento?" mora em planilha ou memória, e um
-- treinamento vencido em atividade de risco (trabalho em altura, espaço
-- confinado, elétrica) é auto de infração antes de ser acidente.
--
-- Diferente do exame ocupacional, o produto não fecha o vocabulário do
-- treinamento (`training_name` é texto livre). A mesma razão de
-- `fdp_positions.special_activities` (0098): o Vinculato não decide quais
-- NRs existem nem quais delas o cliente aplica — NR-35, NR-33, NR-10,
-- brigada de incêndio e a lista muda por atividade e por convenção coletiva.
-- Fechar isso em enum seria o produto inventando uma taxonomia que não é
-- dele para inventar.
SELECT pg_advisory_xact_lock(hashtext('0101_mandatory_trainings'));
--> statement-breakpoint

CREATE TABLE "fdp_trainings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"training_name" text NOT NULL,
	"completed_on" date NOT NULL,
	"valid_until" date,
	"provider_name" text DEFAULT '' NOT NULL,
	"certificate_number" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_trainings_name_check" CHECK (length(trim("training_name")) > 0),
	-- A validade, quando existe, não pode terminar antes de começar — a mesma
	-- guarda do exame ocupacional para `next_due_date` em relação a `exam_date`.
	CONSTRAINT "fdp_trainings_validity_check" CHECK ("valid_until" IS NULL OR "valid_until" >= "completed_on")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "fdp_trainings_workspace_id_uq" ON "fdp_trainings" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX "fdp_trainings_workspace_employee_idx" ON "fdp_trainings" USING btree ("workspace_id", "employee_id", "completed_on");
--> statement-breakpoint
-- O Motor de Prazos lê "o que vence quando" — o mesmo índice parcial de
-- fdp_occupational_exams.next_due_date, para o dia em que este módulo ganhar
-- tela própria e puder alimentar a Central de Trabalho.
CREATE INDEX "fdp_trainings_workspace_due_idx" ON "fdp_trainings" USING btree ("workspace_id", "valid_until") WHERE "valid_until" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "fdp_trainings" ADD CONSTRAINT "fdp_trainings_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_trainings" ADD CONSTRAINT "fdp_trainings_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_trainings" ADD CONSTRAINT "fdp_trainings_employee_fk"
  FOREIGN KEY ("workspace_id", "company_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "company_id", "id") ON DELETE cascade;
--> statement-breakpoint

ALTER TABLE "fdp_trainings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_trainings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_trainings_workspace_isolation" ON "fdp_trainings"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
