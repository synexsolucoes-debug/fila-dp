-- ERP DP: controle de férias — a cota de ausência (infotipo 2006) do SAP
-- (item 8 do roadmap, §4.39 de docs/arquitetura-operacional.md).
--
-- Os períodos aquisitivos são derivados da admissão; aqui fica o que foi
-- programado, aprovado e gozado em cada um, e as férias coletivas que
-- geraram programações para um grupo de uma vez. Nada é apagado: cancelar é
-- mudar o estado.
SELECT pg_advisory_xact_lock(hashtext('0116_erp_dp_vacations'));
--> statement-breakpoint

CREATE TABLE "fdp_collective_vacations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	-- Sem departamento, vale para a empresa inteira (CLT art. 139).
	"department_id" text,
	"start_date" date NOT NULL,
	"rest_days" integer NOT NULL,
	"employees_count" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_collective_vacations_days_check" CHECK ("rest_days" BETWEEN 10 AND 30)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_collective_vacations_workspace_id_uq" ON "fdp_collective_vacations" USING btree ("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_collective_vacations" ADD CONSTRAINT "fdp_collective_vacations_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_collective_vacations" ADD CONSTRAINT "fdp_collective_vacations_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_collective_vacations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_collective_vacations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_collective_vacations_workspace_isolation" ON "fdp_collective_vacations"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

CREATE TABLE "fdp_vacation_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"acquisitive_start" date NOT NULL,
	"start_date" date NOT NULL,
	"rest_days" integer NOT NULL,
	"sold_days" integer DEFAULT 0 NOT NULL,
	-- Dias de direito do período, pelas faltas (art. 130): 30, 24, 18 ou 12.
	"entitled_days" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"collective_id" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_vacation_schedules_status_check" CHECK ("status" IN ('planned', 'approved', 'taken', 'canceled')),
	CONSTRAINT "fdp_vacation_schedules_days_check" CHECK ("rest_days" BETWEEN 1 AND 30 AND "sold_days" BETWEEN 0 AND 10),
	CONSTRAINT "fdp_vacation_schedules_entitled_check" CHECK ("entitled_days" IN (12, 18, 24, 30)),
	CONSTRAINT "fdp_vacation_schedules_total_check" CHECK ("rest_days" + "sold_days" <= "entitled_days")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_vacation_schedules_workspace_id_uq" ON "fdp_vacation_schedules" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX "fdp_vacation_schedules_employee_idx" ON "fdp_vacation_schedules" USING btree ("workspace_id", "employee_id", "acquisitive_start");
--> statement-breakpoint
CREATE INDEX "fdp_vacation_schedules_start_idx" ON "fdp_vacation_schedules" USING btree ("workspace_id", "company_id", "start_date") WHERE "status" <> 'canceled';
--> statement-breakpoint
ALTER TABLE "fdp_vacation_schedules" ADD CONSTRAINT "fdp_vacation_schedules_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_vacation_schedules" ADD CONSTRAINT "fdp_vacation_schedules_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_vacation_schedules" ADD CONSTRAINT "fdp_vacation_schedules_collective_fk"
  FOREIGN KEY ("workspace_id", "collective_id") REFERENCES "public"."fdp_collective_vacations"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_vacation_schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_vacation_schedules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_vacation_schedules_workspace_isolation" ON "fdp_vacation_schedules"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
