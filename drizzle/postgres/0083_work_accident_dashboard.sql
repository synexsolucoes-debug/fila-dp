-- Dashboard de Acidente de Trabalho (SESMT).
--
-- Migration aditiva: nenhuma tabela existente é removida ou reescrita.
--
-- O módulo tem uma tabela só, e isso é a decisão principal. O dashboard mostra
-- total de acidentes, dias afastados, despesas, divisão por tipo, parte do
-- corpo, setor, gênero, turno e mês — nove recortes que, se fossem alimentados
-- como nove totais digitados, poderiam se contradizer entre si já na primeira
-- competência. Alimentando **um registro por acidente**, os nove recortes são a
-- mesma soma vista de nove ângulos, e o período filtra todos juntos.
--
-- Três decisões ficam no banco e não na aplicação:
--
--  1. o vocabulário é fechado onde precisa ser comparável (tipo, parte do
--     corpo, turno, gênero) e aberto onde é da empresa (setor). CHECK garante
--     que a fatia "Mão" não vire "MAO" e "mao dir." em três lançamentos;
--  2. dias afastados e despesa não são negativos, porque os dois são somados
--     direto nos cartões do topo;
--  3. número de CAT só existe quando a CAT foi emitida — guardar protocolo de
--     uma comunicação que ninguém emitiu é registrar prova de um ato que não
--     aconteceu.
--
-- O módulo **não** calcula taxa de frequência nem de gravidade da NBR 14280:
-- elas exigem horas-homem trabalhadas, que o Vinculato não coleta. Não há
-- coluna para elas de propósito.
CREATE TABLE "fdp_work_accidents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"occurred_on" date NOT NULL,
	"accident_type" text NOT NULL,
	"body_part" text NOT NULL,
	"sector" text DEFAULT '' NOT NULL,
	"work_shift" text NOT NULL,
	"gender" text DEFAULT 'not_informed' NOT NULL,
	"employee_label" text DEFAULT '' NOT NULL,
	"leave_days" integer DEFAULT 0 NOT NULL,
	"expense_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"cat_issued" integer DEFAULT 0 NOT NULL,
	"cat_number" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_work_accidents_type_check" CHECK ("fdp_work_accidents"."accident_type" IN ('incident', 'typical', 'commute', 'occupational_disease')),
	CONSTRAINT "fdp_work_accidents_body_part_check" CHECK ("fdp_work_accidents"."body_part" IN ('skull', 'face', 'eyes', 'neck', 'shoulder', 'arm', 'elbow', 'hand', 'fingers', 'chest', 'abdomen', 'lumbar', 'hip', 'leg', 'knee', 'foot', 'toes', 'multiple', 'other')),
	CONSTRAINT "fdp_work_accidents_shift_check" CHECK ("fdp_work_accidents"."work_shift" IN ('morning', 'afternoon', 'night')),
	CONSTRAINT "fdp_work_accidents_gender_check" CHECK ("fdp_work_accidents"."gender" IN ('female', 'male', 'other', 'not_informed')),
	CONSTRAINT "fdp_work_accidents_leave_days_check" CHECK ("fdp_work_accidents"."leave_days" >= 0),
	CONSTRAINT "fdp_work_accidents_expense_check" CHECK ("fdp_work_accidents"."expense_amount" >= 0),
	CONSTRAINT "fdp_work_accidents_cat_flag_check" CHECK ("fdp_work_accidents"."cat_issued" IN (0, 1)),
	-- Protocolo sem emissão é prova de um ato que não aconteceu.
	CONSTRAINT "fdp_work_accidents_cat_number_check" CHECK ("fdp_work_accidents"."cat_issued" = 1 OR "fdp_work_accidents"."cat_number" = '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_work_accidents_workspace_id_uq" ON "fdp_work_accidents" USING btree ("workspace_id","id");--> statement-breakpoint
-- O dashboard sempre pergunta pelo período dentro de um recorte de empresa; é
-- este índice que evita varrer a base inteira a cada troca de mês.
CREATE INDEX "fdp_work_accidents_workspace_company_date_idx" ON "fdp_work_accidents" USING btree ("workspace_id","company_id","occurred_on");--> statement-breakpoint
CREATE INDEX "fdp_work_accidents_workspace_date_idx" ON "fdp_work_accidents" USING btree ("workspace_id","occurred_on");--> statement-breakpoint
ALTER TABLE "fdp_work_accidents" ADD CONSTRAINT "fdp_work_accidents_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_work_accidents" ADD CONSTRAINT "fdp_work_accidents_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Isolamento por tenant no banco, não só na consulta.
ALTER TABLE "fdp_work_accidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_work_accidents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_work_accidents_workspace_isolation" ON "fdp_work_accidents"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
-- O módulo entra no catálogo. Sem esta linha ele existiria em código e não
-- teria porta: o menu do painel é montado a partir de `fdp_modules`.
INSERT INTO "fdp_modules" ("key", "name", "description", "category", "route", "required_capability", "position") VALUES
  ('safety', 'Acidentes de Trabalho', 'Dashboard do SESMT: acidentes por tipo, parte do corpo, setor, turno e período, alimentado pela própria equipe de segurança.', 'pessoas', 'safety', 'safety.view', 960)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Registrar acidente de trabalho e emitir CAT é obrigação de qualquer empresa
-- com colaborador, não recurso de porte. Entra em todos os planos, pelo mesmo
-- motivo que o Controle de EPI entrou.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", 'safety' FROM "fdp_saas_plans" p
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Quem já responde pelo EPI responde pelo acidente: é a mesma equipe de
-- segurança do trabalho. Sem esta linha, o módulo nasceria fora do
-- departamento principal de todo mundo que tem lotação — e o padrão de acesso
-- por departamento o esconderia de quem foi feito para usá-lo, até alguém
-- descobrir a tela de módulos por área.
INSERT INTO "fdp_area_module_assignments" ("workspace_id", "module_key", "area_id", "created_by")
SELECT "workspace_id", 'safety', "area_id", "created_by"
FROM "fdp_area_module_assignments"
WHERE "module_key" = 'epi'
ON CONFLICT ("workspace_id", "module_key") DO NOTHING;
