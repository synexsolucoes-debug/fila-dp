-- Catálogo global de módulos, inclusão por plano e liberação especial por workspace.
--
-- Migration aditiva. Até aqui o menu era filtrado só por capability do papel:
-- não existia como dizer "este módulo não está no plano contratado" nem como a
-- plataforma liberar um módulo para um cliente específico.
CREATE TABLE "fdp_modules" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'operacao' NOT NULL,
	"route" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"required_capability" text DEFAULT '' NOT NULL,
	"depends_on" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 1000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_modules_status_check" CHECK ("status" IN ('active', 'inactive')),
	CONSTRAINT "fdp_modules_category_check" CHECK ("category" IN ('operacao', 'folha', 'pessoas', 'gestao', 'plataforma')),
	CONSTRAINT "fdp_modules_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "fdp_plan_modules" (
	"plan_id" text NOT NULL,
	"module_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_plan_modules_pk" PRIMARY KEY ("plan_id", "module_key")
);
--> statement-breakpoint
-- Liberação especial: a plataforma abre um módulo para um cliente sem mudar o
-- plano dele. `granted = 0` também é registro válido — serve para bloquear um
-- módulo que o plano inclui, com motivo.
CREATE TABLE "fdp_workspace_module_grants" (
	"workspace_id" text NOT NULL,
	"module_key" text NOT NULL,
	"granted" integer DEFAULT 1 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"granted_by" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_workspace_module_grants_pk" PRIMARY KEY ("workspace_id", "module_key"),
	CONSTRAINT "fdp_workspace_module_grants_granted_check" CHECK ("granted" IN (0, 1)),
	CONSTRAINT "fdp_workspace_module_grants_reason_check" CHECK (length("reason") >= 5)
);
--> statement-breakpoint
CREATE INDEX "fdp_modules_status_position_idx" ON "fdp_modules" USING btree ("status","category","position");--> statement-breakpoint
CREATE INDEX "fdp_plan_modules_module_idx" ON "fdp_plan_modules" USING btree ("module_key");
--> statement-breakpoint
ALTER TABLE "fdp_plan_modules" ADD CONSTRAINT "fdp_plan_modules_plan_id_fdp_saas_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."fdp_saas_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_plan_modules" ADD CONSTRAINT "fdp_plan_modules_module_key_fdp_modules_key_fk" FOREIGN KEY ("module_key") REFERENCES "public"."fdp_modules"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_module_grants" ADD CONSTRAINT "fdp_workspace_module_grants_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_module_grants" ADD CONSTRAINT "fdp_workspace_module_grants_module_key_fdp_modules_key_fk" FOREIGN KEY ("module_key") REFERENCES "public"."fdp_modules"("key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_module_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_module_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- O cliente enxerga as próprias liberações; só a plataforma concede ou revoga.
CREATE POLICY "fdp_workspace_module_grants_read" ON "fdp_workspace_module_grants" FOR SELECT
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')
    OR current_setting('app.platform_admin', true) = 'true');
--> statement-breakpoint
CREATE POLICY "fdp_workspace_module_grants_write" ON "fdp_workspace_module_grants" FOR ALL
  USING (current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.platform_admin', true) = 'true');
--> statement-breakpoint
-- Catálogo dos módulos que existem de fato no produto hoje. Nada aqui aponta
-- para tela inexistente: cada rota corresponde a uma visão já implementada.
INSERT INTO "fdp_modules" ("key", "name", "description", "category", "route", "required_capability", "position") VALUES
  ('board', 'Demandas', 'Quadro de demandas com SLA, responsáveis e prazos.', 'operacao', 'board', 'cards.read', 100),
  ('inbox', 'Caixa de entrada', 'Triagem multicanal de solicitações recebidas.', 'operacao', 'inbox', 'cards.read', 200),
  ('planner', 'Planner', 'Agenda pessoal do analista a partir dos prazos.', 'operacao', 'planner', 'cards.read', 300),
  ('processes', 'Operação DP', 'Competências, movimentações, aprovações e obrigações.', 'folha', 'processes', 'competences.read', 400),
  ('time_tracking', 'Ponto', 'Conferência de marcações e envio dos eventos de hora.', 'folha', 'timeTracking', 'time.read', 500),
  ('auxiliary', 'Módulos auxiliares', 'Benefícios, psicologia e prestadores da competência.', 'folha', 'auxiliary', 'benefits.read', 600),
  ('psychologist_payments', 'Pagamento de Psicólogos', 'Apuração e pagamento das consultas da competência.', 'gestao', 'psychologistPayments', 'psychology.payments.read', 700),
  ('contractor_payments', 'Pagamentos PJ', 'Líquido devido, nota esperada e complemento.', 'gestao', 'contractorPayments', 'contractors.payments.read', 800),
  ('registrations', 'Cadastros', 'Empresas, colaboradores e estruturas auxiliares.', 'pessoas', 'registrations', 'companies.read', 900),
  ('integrations', 'Integrações', 'Conectores, mapeamentos, execuções e conciliação.', 'gestao', 'integrations', 'integrations.status.read', 1000),
  ('payroll', 'Folha', 'Registro da competência e indicadores de custo.', 'folha', 'payroll', 'hr.read', 1100),
  ('indicators', 'Relatórios', 'SLA, volume, produtividade e regras ativas.', 'gestao', 'indicators', 'reports.read', 1200),
  ('saas', 'Plano e ativação', 'Assinatura, limites e ativação do workspace.', 'gestao', 'saas', 'saas.read', 1300)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Starter: o essencial para conhecer o produto.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", m."key" FROM "fdp_saas_plans" p, "fdp_modules" m
WHERE p."code" = 'starter' AND m."key" IN ('board', 'inbox', 'planner', 'registrations', 'saas')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Standard: a operação de DP completa, sem os módulos financeiros.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", m."key" FROM "fdp_saas_plans" p, "fdp_modules" m
WHERE p."code" = 'standard'
  AND m."key" IN ('board', 'inbox', 'planner', 'registrations', 'saas', 'processes', 'payroll', 'indicators')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Premium: acrescenta ponto, auxiliares e integrações.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", m."key" FROM "fdp_saas_plans" p, "fdp_modules" m
WHERE p."code" = 'premium'
  AND m."key" IN ('board', 'inbox', 'planner', 'registrations', 'saas', 'processes', 'payroll', 'indicators',
                  'time_tracking', 'auxiliary', 'integrations')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Enterprise: catálogo inteiro.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", m."key" FROM "fdp_saas_plans" p, "fdp_modules" m
WHERE p."code" = 'enterprise'
ON CONFLICT DO NOTHING;
