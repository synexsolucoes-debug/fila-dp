-- Histórico funcional do colaborador — a ficha com data de validade.
--
-- Engenharia reversa do Personnel Administration do SAP HCM
-- (docs/engenharia-reversa-sap-hcm.md). Lá o cadastro mestre é uma sequência
-- de registros (infotipos) com início e fim de validade; aqui
-- `fdp_employees` guarda só o agora, e aplicar uma transferência apagava o
-- departamento anterior sem deixar a resposta para "onde ele estava em março?".
--
-- Uma tabela para os três tipos, e não uma por infotipo: os três têm o mesmo
-- ciclo (delimitar o vigente, abrir o novo) e a tela lê os três juntos. As
-- colunas de valor são explícitas, e não um JSON, para que os CHECKs digam
-- qual tipo carrega qual campo.
--
-- Salário (o infotipo 0008 do SAP) fica de fora de propósito: o Vinculato não
-- calcula folha (§28 de docs/evolucao-produto-2026-09/05-benchmark-lacunas-e-ideias.md).
SELECT pg_advisory_xact_lock(hashtext('0107_employee_functional_history'));
--> statement-breakpoint

CREATE TABLE "fdp_employee_history_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"employee_id" text NOT NULL,
	"record_type" text NOT NULL,
	"valid_from" date NOT NULL,
	-- A "data alta" do SAP: vale até segunda ordem.
	"valid_to" date DEFAULT '9999-12-31' NOT NULL,
	"reason" text NOT NULL,
	"movement_id" text,
	"employment_status" text,
	-- A empresa mora no registro, e não só na FK do colaborador: ela também é
	-- lotação (IT0001), e uma troca de empresa precisa ficar no histórico.
	"company_id" text,
	"establishment_id" text,
	"department_id" text,
	"position_id" text,
	"cost_center_id" text,
	"work_schedule_id" text,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_employee_history_records_type_check" CHECK ("record_type" IN ('situation', 'assignment', 'schedule')),
	CONSTRAINT "fdp_employee_history_records_reason_check" CHECK ("reason" IN ('baseline', 'leave', 'termination', 'transfer', 'registration_edit')),
	CONSTRAINT "fdp_employee_history_records_validity_check" CHECK ("valid_to" >= "valid_from"),
	CONSTRAINT "fdp_employee_history_records_status_check" CHECK ("employment_status" IS NULL OR "employment_status" IN ('active', 'on_leave', 'terminated')),
	-- Cada tipo carrega só os seus campos. A situação sem status, ou a lotação
	-- sem empresa, seria um registro que não responde a pergunta dele.
	CONSTRAINT "fdp_employee_history_records_situation_check" CHECK ("record_type" <> 'situation' OR (
		"employment_status" IS NOT NULL AND "company_id" IS NULL AND "establishment_id" IS NULL AND "department_id" IS NULL
		AND "position_id" IS NULL AND "cost_center_id" IS NULL AND "work_schedule_id" IS NULL)),
	CONSTRAINT "fdp_employee_history_records_assignment_check" CHECK ("record_type" <> 'assignment' OR (
		"company_id" IS NOT NULL AND "employment_status" IS NULL AND "work_schedule_id" IS NULL)),
	CONSTRAINT "fdp_employee_history_records_schedule_check" CHECK ("record_type" <> 'schedule' OR (
		"employment_status" IS NULL AND "company_id" IS NULL AND "establishment_id" IS NULL AND "department_id" IS NULL
		AND "position_id" IS NULL AND "cost_center_id" IS NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX "fdp_employee_history_records_workspace_id_uq" ON "fdp_employee_history_records" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- Dois registros do mesmo tipo começando no mesmo dia são o caso mais comum de
-- sobreposição (duas aplicações concorrentes); o índice barra no banco.
CREATE UNIQUE INDEX "fdp_employee_history_records_employee_type_start_uq" ON "fdp_employee_history_records" USING btree ("workspace_id", "employee_id", "record_type", "valid_from");
--> statement-breakpoint

ALTER TABLE "fdp_employee_history_records" ADD CONSTRAINT "fdp_employee_history_records_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
-- Pelo id, e não por (empresa, id) como o ASO e o treinamento: o cadastro pode
-- trocar de empresa, e o histórico precisa sobreviver à troca.
ALTER TABLE "fdp_employee_history_records" ADD CONSTRAINT "fdp_employee_history_records_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_history_records" ADD CONSTRAINT "fdp_employee_history_records_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_employee_history_records" ADD CONSTRAINT "fdp_employee_history_records_movement_fk"
  FOREIGN KEY ("workspace_id", "movement_id") REFERENCES "public"."fdp_employee_movements"("workspace_id", "id");
--> statement-breakpoint

ALTER TABLE "fdp_employee_history_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employee_history_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_employee_history_records_workspace_isolation" ON "fdp_employee_history_records"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
