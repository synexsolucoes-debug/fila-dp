-- Adiantamentos e Descontos (Operação DP).
--
-- Migration aditiva: nenhuma tabela existente é removida ou reescrita. Os três
-- `ALTER` do final apenas ampliam vocabulários fechados que já existiam.
--
-- O problema que este módulo resolve estava numa planilha: 87 abas mensais,
-- ~7.500 linhas de pessoa e o saldo de cada empréstimo escrito em português
-- dentro de uma célula ("5/10 R$ 200,00", "VALE FIXO", "lançado na Domínio").
-- Ninguém consegue responder "quanto ainda falta descontar da pessoa X" sem
-- ler oito abas e confiar na memória de quem digitou.
--
-- Quatro decisões estruturais ficam no banco, e não na aplicação, porque são
-- exatamente as que a planilha não conseguia sustentar:
--
--  1. **Saldo não se digita.** `discounted_amount` da parcela é mantido por
--     trigger a partir de `fdp_ledger_confirmations`, que é append-only. Não
--     existe caminho para "marcar como descontado" sem gravar quem confirmou,
--     quando e com que referência. Competência que passou não baixa parcela;
--     exportar não baixa parcela; fechar o mês não baixa parcela.
--
--  2. **Corrigir é estornar, nunca apagar.** A confirmação não aceita UPDATE
--     nem DELETE. Um desconto lançado errado é desfeito por uma linha negativa
--     com justificativa, e as duas ficam no histórico.
--
--  3. **Pago ≠ descontado.** O adiantamento tem duas tabelas distintas:
--     `fdp_ledger_advance_payments` é o dinheiro que saiu para a pessoa,
--     `fdp_ledger_confirmations` é o dinheiro recuperado dela. São um único
--     lançamento com dois lados — nunca duas dívidas pelo mesmo adiantamento.
--
--  4. **Recorrente sem prazo não tem saldo devedor.** `total_amount` é NULL
--     quando `modality = 'recurring'`, por CHECK. Um "vale fixo" não é uma
--     dívida de valor infinito: é uma regra vigente com ocorrências mensais.
--
-- O módulo **não** calcula folha, não executa pagamento e não transmite nada a
-- ERP nenhum. Ele organiza solicitação, aprovação, documento, parcela e
-- conferência; quem calcula salário continua sendo o sistema de folha.

-- ---------------------------------------------------------------------------
-- 1. Lote de conferência da competência
-- ---------------------------------------------------------------------------
-- Um lote por competência de empresa, amarrado ao ciclo de folha que já existe.
-- Não é um segundo fechamento: é a conferência do módulo dentro do fechamento
-- que `fdp_payroll_cycles` já governa.
CREATE TABLE "fdp_ledger_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"competence" text NOT NULL,
	"scope_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"export_reference" text DEFAULT '' NOT NULL,
	"exported_at" timestamp with time zone,
	"exported_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"reopen_reason" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "fdp_ledger_batches_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	-- "exportado", "lançado no sistema de folha" e "desconto confirmado" são
	-- três estados distintos, e o produto se recusa a tratá-los como um só.
	CONSTRAINT "fdp_ledger_batches_status_check" CHECK ("status" IN ('draft', 'in_review', 'approved', 'exported', 'sent_to_payroll', 'confirmed', 'closed', 'reopened')),
	CONSTRAINT "fdp_ledger_batches_reopen_reason_check" CHECK ("status" <> 'reopened' OR length(trim("reopen_reason")) >= 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_batches_workspace_id_uq" ON "fdp_ledger_batches" USING btree ("workspace_id","id");--> statement-breakpoint
-- Um lote por ciclo: o que impede a segunda conferência paralela do mesmo mês.
CREATE UNIQUE INDEX "fdp_ledger_batches_cycle_uq" ON "fdp_ledger_batches" USING btree ("workspace_id","payroll_cycle_id");--> statement-breakpoint
CREATE INDEX "fdp_ledger_batches_workspace_competence_idx" ON "fdp_ledger_batches" USING btree ("workspace_id","competence","status");--> statement-breakpoint
ALTER TABLE "fdp_ledger_batches" ADD CONSTRAINT "fdp_ledger_batches_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_batches" ADD CONSTRAINT "fdp_ledger_batches_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_batches" ADD CONSTRAINT "fdp_ledger_batches_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. O lançamento
-- ---------------------------------------------------------------------------
-- Um registro individual por empréstimo, multa, franquia, adiantamento ou
-- desconto. Uma pessoa tem quantos lançamentos simultâneos forem necessários,
-- e cada um tem o próprio saldo — foi a confusão entre eles que a planilha
-- resolvia com duas linhas de texto na mesma célula.
CREATE TABLE "fdp_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	-- Exatamente um dos dois. CLT aponta para o colaborador; PJ aponta para o
	-- prestador, cuja contratação continua sendo do grupo.
	"employee_id" text,
	"provider_id" text,
	-- Fotografia do vínculo, unidade e departamento no momento do lançamento.
	-- Mudar de empresa, unidade ou vínculo depois **não** reescreve o histórico
	-- das competências anteriores: elas continuam lendo o que valia aqui.
	"employment_type_snapshot" text DEFAULT '' NOT NULL,
	"department_id" text,
	"department_label" text DEFAULT '' NOT NULL,
	"unit_label" text DEFAULT '' NOT NULL,
	"operation_label" text DEFAULT '' NOT NULL,
	-- Área que pediu ≠ departamento de quem sofre o desconto. O SESMT solicita;
	-- a pessoa é da Técnica Interna. Dois campos porque são dois fatos.
	"requester_area_id" text,
	"responsible_area_id" text,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"occurred_on" date,
	"requested_on" date NOT NULL,
	"requested_by" text NOT NULL,
	"responsible_user_id" text,
	-- NULL quando a obrigação não tem total definido (recorrente sem prazo).
	"total_amount" numeric(18, 2),
	"modality" text NOT NULL,
	"installment_count" integer,
	"first_competence" text NOT NULL,
	"expected_end_competence" text,
	"recurrence_end_competence" text,
	"settlement_target" text DEFAULT 'payroll' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	-- A aprovação usa a máquina que já existe (`fdp_employee_movements` +
	-- `fdp_movement_approval_steps`). Nenhuma segunda máquina de aprovação.
	"movement_id" text,
	"origin_type" text DEFAULT 'manual' NOT NULL,
	"origin_id" text DEFAULT '' NOT NULL,
	"parent_entry_id" text,
	-- Campos por categoria: placa, auto de infração, veículo, ocorrência, item.
	-- Ficam aqui para não inchar a tabela com 30 colunas que servem a 5% dos
	-- lançamentos — e para não inchar a janela de quem lança um desconto simples.
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_note" text DEFAULT '' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"canceled_reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "fdp_ledger_entries_subject_check" CHECK (("employee_id" IS NOT NULL) <> ("provider_id" IS NOT NULL)),
	CONSTRAINT "fdp_ledger_entries_category_check" CHECK ("category" IN ('salary_advance', 'loan', 'traffic_fine', 'vehicle_deductible', 'sesmt_discount', 'equipment_damage', 'tool_loss', 'other')),
	CONSTRAINT "fdp_ledger_entries_modality_check" CHECK ("modality" IN ('single', 'installments', 'recurring')),
	CONSTRAINT "fdp_ledger_entries_settlement_check" CHECK ("settlement_target" IN ('payroll', 'contractor_payment', 'other')),
	-- PJ liquida no fechamento PJ; CLT, na folha. Sem isso um lançamento de
	-- prestador poderia ser projetado na folha de uma empresa qualquer.
	CONSTRAINT "fdp_ledger_entries_target_subject_check" CHECK (
		("provider_id" IS NULL AND "settlement_target" IN ('payroll', 'other'))
		OR ("provider_id" IS NOT NULL AND "settlement_target" = 'contractor_payment')
	),
	CONSTRAINT "fdp_ledger_entries_status_check" CHECK ("status" IN ('draft', 'pending_approval', 'approved', 'rejected', 'active', 'suspended', 'settled', 'canceled', 'renegotiated')),
	CONSTRAINT "fdp_ledger_entries_origin_check" CHECK ("origin_type" IN ('manual', 'epi_discount', 'demand', 'import', 'renegotiation')),
	CONSTRAINT "fdp_ledger_entries_first_competence_check" CHECK ("first_competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_entries_end_competence_check" CHECK ("expected_end_competence" IS NULL OR "expected_end_competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_entries_recurrence_end_check" CHECK ("recurrence_end_competence" IS NULL OR "recurrence_end_competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	-- Sem saldo devedor artificial: recorrente sem prazo não tem total.
	CONSTRAINT "fdp_ledger_entries_modality_shape_check" CHECK (
		("modality" = 'recurring' AND "total_amount" IS NULL AND "installment_count" IS NULL)
		OR ("modality" = 'single' AND "total_amount" > 0 AND "installment_count" = 1)
		OR ("modality" = 'installments' AND "total_amount" > 0 AND "installment_count" >= 1)
	),
	CONSTRAINT "fdp_ledger_entries_cancel_reason_check" CHECK ("status" <> 'canceled' OR length(trim("canceled_reason")) >= 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_entries_workspace_id_uq" ON "fdp_ledger_entries" USING btree ("workspace_id","id");--> statement-breakpoint
-- A garantia de "uma solicitação aprovada origina um único lançamento, mesmo se
-- a operação for repetida". Vale para o SESMT, para a demanda e para a linha da
-- planilha importada — é o mesmo índice para os três.
CREATE UNIQUE INDEX "fdp_ledger_entries_origin_uq" ON "fdp_ledger_entries" USING btree ("workspace_id","origin_type","origin_id") WHERE "origin_id" <> '';--> statement-breakpoint
CREATE INDEX "fdp_ledger_entries_workspace_employee_idx" ON "fdp_ledger_entries" USING btree ("workspace_id","employee_id","status");--> statement-breakpoint
CREATE INDEX "fdp_ledger_entries_workspace_provider_idx" ON "fdp_ledger_entries" USING btree ("workspace_id","provider_id","status");--> statement-breakpoint
CREATE INDEX "fdp_ledger_entries_workspace_company_status_idx" ON "fdp_ledger_entries" USING btree ("workspace_id","company_id","status","category");--> statement-breakpoint
CREATE INDEX "fdp_ledger_entries_workspace_movement_idx" ON "fdp_ledger_entries" USING btree ("workspace_id","movement_id") WHERE "movement_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_provider_fk" FOREIGN KEY ("workspace_id","provider_id") REFERENCES "public"."fdp_auxiliary_providers"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_department_fk" FOREIGN KEY ("workspace_id","company_id","department_id") REFERENCES "public"."fdp_departments"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_requester_area_fk" FOREIGN KEY ("workspace_id","requester_area_id") REFERENCES "public"."fdp_areas"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_responsible_area_fk" FOREIGN KEY ("workspace_id","responsible_area_id") REFERENCES "public"."fdp_areas"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_movement_fk" FOREIGN KEY ("workspace_id","movement_id") REFERENCES "public"."fdp_employee_movements"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_parent_fk" FOREIGN KEY ("workspace_id","parent_entry_id") REFERENCES "public"."fdp_ledger_entries"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ADD CONSTRAINT "fdp_ledger_entries_requester_fk" FOREIGN KEY ("workspace_id","requested_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. A parcela
-- ---------------------------------------------------------------------------
CREATE TABLE "fdp_ledger_installments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"entry_id" text NOT NULL,
	"company_id" text NOT NULL,
	"number" integer NOT NULL,
	-- NULL no recorrente sem prazo: não existe "parcela 3 de ?".
	"total_count" integer,
	"competence" text NOT NULL,
	"planned_amount" numeric(18, 2) NOT NULL,
	-- Mantido por trigger a partir das confirmações. Nunca escrito pela
	-- aplicação: guardar o mesmo número em duas fontes é garantir que um dia
	-- eles discordem.
	"discounted_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"batch_id" text,
	"note" text DEFAULT '' NOT NULL,
	"rescheduled_to_competence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "fdp_ledger_installments_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_installments_reschedule_check" CHECK ("rescheduled_to_competence" IS NULL OR "rescheduled_to_competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_installments_number_check" CHECK ("number" > 0 AND ("total_count" IS NULL OR "number" <= "total_count")),
	CONSTRAINT "fdp_ledger_installments_amount_check" CHECK ("planned_amount" >= 0 AND "discounted_amount" >= 0),
	CONSTRAINT "fdp_ledger_installments_status_check" CHECK ("status" IN ('scheduled', 'partially_discounted', 'discounted', 'skipped', 'rescheduled', 'canceled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_installments_workspace_id_uq" ON "fdp_ledger_installments" USING btree ("workspace_id","id");--> statement-breakpoint
-- Parcela 3 existe uma vez. Reprocessar a geração não cria a segunda.
CREATE UNIQUE INDEX "fdp_ledger_installments_entry_number_uq" ON "fdp_ledger_installments" USING btree ("workspace_id","entry_id","number");--> statement-breakpoint
CREATE INDEX "fdp_ledger_installments_workspace_competence_idx" ON "fdp_ledger_installments" USING btree ("workspace_id","competence","status");--> statement-breakpoint
CREATE INDEX "fdp_ledger_installments_workspace_batch_idx" ON "fdp_ledger_installments" USING btree ("workspace_id","batch_id") WHERE "batch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "fdp_ledger_installments_workspace_entry_idx" ON "fdp_ledger_installments" USING btree ("workspace_id","entry_id","competence");--> statement-breakpoint
ALTER TABLE "fdp_ledger_installments" ADD CONSTRAINT "fdp_ledger_installments_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_installments" ADD CONSTRAINT "fdp_ledger_installments_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."fdp_ledger_entries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_installments" ADD CONSTRAINT "fdp_ledger_installments_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_installments" ADD CONSTRAINT "fdp_ledger_installments_batch_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."fdp_ledger_batches"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. A confirmação do desconto — append-only
-- ---------------------------------------------------------------------------
-- Esta tabela é a única fonte de "foi descontado". Nada mais no sistema pode
-- afirmar isso: nem a competência ter passado, nem a exportação ter saído, nem
-- o lote ter sido fechado.
CREATE TABLE "fdp_ledger_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"installment_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"competence" text NOT NULL,
	-- Positivo desconta, negativo estorna. O saldo da parcela é a soma.
	"amount" numeric(18, 2) NOT NULL,
	"kind" text DEFAULT 'confirmation' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"justification" text DEFAULT '' NOT NULL,
	"reverses_confirmation_id" text,
	"batch_id" text,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Dois usuários confirmando a mesma parcela ao mesmo tempo gravam a mesma
	-- chave; o índice único deixa passar uma. É isso que impede a baixa dupla.
	"idempotency_key" text NOT NULL,
	CONSTRAINT "fdp_ledger_confirmations_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_confirmations_kind_check" CHECK ("kind" IN ('confirmation', 'reversal', 'authorized_override')),
	CONSTRAINT "fdp_ledger_confirmations_source_check" CHECK ("source" IN ('manual', 'return_import', 'api')),
	CONSTRAINT "fdp_ledger_confirmations_amount_sign_check" CHECK (
		("kind" = 'reversal' AND "amount" < 0) OR ("kind" <> 'reversal' AND "amount" > 0)
	),
	-- Estornar e descontar acima do saldo são as duas ações que precisam de
	-- motivo escrito. Sem ele o histórico registra o quê e não registra o porquê.
	CONSTRAINT "fdp_ledger_confirmations_justification_check" CHECK (
		"kind" = 'confirmation' OR length(trim("justification")) >= 5
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_confirmations_workspace_id_uq" ON "fdp_ledger_confirmations" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_confirmations_idempotency_uq" ON "fdp_ledger_confirmations" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "fdp_ledger_confirmations_installment_idx" ON "fdp_ledger_confirmations" USING btree ("workspace_id","installment_id","confirmed_at");--> statement-breakpoint
CREATE INDEX "fdp_ledger_confirmations_workspace_competence_idx" ON "fdp_ledger_confirmations" USING btree ("workspace_id","competence");--> statement-breakpoint
ALTER TABLE "fdp_ledger_confirmations" ADD CONSTRAINT "fdp_ledger_confirmations_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_confirmations" ADD CONSTRAINT "fdp_ledger_confirmations_installment_fk" FOREIGN KEY ("workspace_id","installment_id") REFERENCES "public"."fdp_ledger_installments"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_confirmations" ADD CONSTRAINT "fdp_ledger_confirmations_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."fdp_ledger_entries"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_confirmations" ADD CONSTRAINT "fdp_ledger_confirmations_reverses_fk" FOREIGN KEY ("workspace_id","reverses_confirmation_id") REFERENCES "public"."fdp_ledger_confirmations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_confirmations" ADD CONSTRAINT "fdp_ledger_confirmations_batch_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."fdp_ledger_batches"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Regra de adiantamento
-- ---------------------------------------------------------------------------
-- Alterar o valor de um vale fixo não reescreve a linha: cria outra, com
-- vigência futura, e marca a anterior como `superseded`. As competências já
-- processadas continuam lendo a regra que valia nelas.
CREATE TABLE "fdp_ledger_advance_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"entry_id" text NOT NULL,
	"mode" text NOT NULL,
	"fixed_amount" numeric(18, 2),
	"percentage" numeric(7, 4),
	-- Base salarial informada explicitamente. Sem ela o percentual não calcula:
	-- o produto apresenta pendência em vez de multiplicar por zero em silêncio.
	"salary_base_amount" numeric(18, 2),
	"salary_base_source" text DEFAULT '' NOT NULL,
	"effective_from_competence" text NOT NULL,
	"end_competence" text,
	"supersedes_rule_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_ledger_advance_rules_mode_check" CHECK ("mode" IN ('single_competence', 'fixed_monthly', 'percentage')),
	CONSTRAINT "fdp_ledger_advance_rules_status_check" CHECK ("status" IN ('active', 'superseded', 'canceled')),
	CONSTRAINT "fdp_ledger_advance_rules_source_check" CHECK ("salary_base_source" IN ('', 'manual', 'hr_metrics')),
	CONSTRAINT "fdp_ledger_advance_rules_competence_check" CHECK ("effective_from_competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_advance_rules_end_check" CHECK ("end_competence" IS NULL OR "end_competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_advance_rules_shape_check" CHECK (
		("mode" IN ('single_competence', 'fixed_monthly') AND "fixed_amount" > 0 AND "percentage" IS NULL)
		OR ("mode" = 'percentage' AND "percentage" > 0 AND "percentage" <= 100 AND "fixed_amount" IS NULL)
	),
	-- Percentual sem base é pendência, não é zero.
	CONSTRAINT "fdp_ledger_advance_rules_base_check" CHECK (
		"mode" <> 'percentage' OR "salary_base_amount" IS NULL OR ("salary_base_amount" > 0 AND "salary_base_source" <> '')
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_advance_rules_workspace_id_uq" ON "fdp_ledger_advance_rules" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_advance_rules_entry_effective_uq" ON "fdp_ledger_advance_rules" USING btree ("workspace_id","entry_id","effective_from_competence");--> statement-breakpoint
CREATE INDEX "fdp_ledger_advance_rules_entry_idx" ON "fdp_ledger_advance_rules" USING btree ("workspace_id","entry_id","status");--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_rules" ADD CONSTRAINT "fdp_ledger_advance_rules_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_rules" ADD CONSTRAINT "fdp_ledger_advance_rules_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."fdp_ledger_entries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_rules" ADD CONSTRAINT "fdp_ledger_advance_rules_supersedes_fk" FOREIGN KEY ("workspace_id","supersedes_rule_id") REFERENCES "public"."fdp_ledger_advance_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. O pagamento do adiantamento ao colaborador
-- ---------------------------------------------------------------------------
-- "Pago ao colaborador" mora aqui. "Descontado dele" mora em
-- `fdp_ledger_confirmations`. As duas coisas pertencem ao mesmo lançamento e
-- nunca viram duas dívidas.
CREATE TABLE "fdp_ledger_advance_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"entry_id" text NOT NULL,
	"company_id" text NOT NULL,
	"competence" text NOT NULL,
	"approved_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"paid_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"expected_payment_date" date,
	"actual_payment_date" date,
	"status" text DEFAULT 'scheduled' NOT NULL,
	-- Suspender a competência é cancelar o pagamento dela com motivo. Não existe
	-- "pular" silencioso.
	"cancel_reason" text DEFAULT '' NOT NULL,
	"proof_object_key" text DEFAULT '' NOT NULL,
	"pending_reason" text DEFAULT '' NOT NULL,
	"authorized_by" text,
	"paid_by" text,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "fdp_ledger_advance_payments_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_advance_payments_status_check" CHECK ("status" IN ('scheduled', 'pending_data', 'authorized', 'paid', 'canceled')),
	CONSTRAINT "fdp_ledger_advance_payments_amount_check" CHECK ("approved_amount" >= 0 AND "paid_amount" >= 0),
	CONSTRAINT "fdp_ledger_advance_payments_paid_check" CHECK (
		"status" <> 'paid' OR ("paid_amount" > 0 AND "actual_payment_date" IS NOT NULL)
	),
	CONSTRAINT "fdp_ledger_advance_payments_cancel_check" CHECK ("status" <> 'canceled' OR length(trim("cancel_reason")) >= 5),
	CONSTRAINT "fdp_ledger_advance_payments_pending_check" CHECK ("status" <> 'pending_data' OR length(trim("pending_reason")) >= 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_advance_payments_workspace_id_uq" ON "fdp_ledger_advance_payments" USING btree ("workspace_id","id");--> statement-breakpoint
-- Uma ocorrência por competência: a recorrência gera programação, e gerar duas
-- vezes não produz dois pagamentos.
CREATE UNIQUE INDEX "fdp_ledger_advance_payments_entry_competence_uq" ON "fdp_ledger_advance_payments" USING btree ("workspace_id","entry_id","competence");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_advance_payments_idempotency_uq" ON "fdp_ledger_advance_payments" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "fdp_ledger_advance_payments_workspace_competence_idx" ON "fdp_ledger_advance_payments" USING btree ("workspace_id","competence","status");--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_payments" ADD CONSTRAINT "fdp_ledger_advance_payments_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_payments" ADD CONSTRAINT "fdp_ledger_advance_payments_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."fdp_ledger_entries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_payments" ADD CONSTRAINT "fdp_ledger_advance_payments_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Documentos do lançamento
-- ---------------------------------------------------------------------------
CREATE TABLE "fdp_ledger_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"entry_id" text NOT NULL,
	"company_id" text NOT NULL,
	"document_kind" text DEFAULT 'other' NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_ledger_documents_kind_check" CHECK ("document_kind" IN ('receipt', 'contract', 'term', 'fine_notice', 'incident_report', 'authorization', 'other')),
	CONSTRAINT "fdp_ledger_documents_size_check" CHECK ("size_bytes" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_documents_workspace_id_uq" ON "fdp_ledger_documents" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_documents_object_key_uq" ON "fdp_ledger_documents" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "fdp_ledger_documents_entry_idx" ON "fdp_ledger_documents" USING btree ("workspace_id","entry_id","created_at");--> statement-breakpoint
ALTER TABLE "fdp_ledger_documents" ADD CONSTRAINT "fdp_ledger_documents_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_documents" ADD CONSTRAINT "fdp_ledger_documents_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."fdp_ledger_entries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_documents" ADD CONSTRAINT "fdp_ledger_documents_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Histórico do lançamento — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE "fdp_ledger_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"entry_id" text NOT NULL,
	"installment_id" text,
	"event_type" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_ledger_events_type_check" CHECK ("event_type" IN (
		'created', 'updated', 'submitted', 'approved', 'rejected', 'canceled',
		'installments_generated', 'installment_rescheduled', 'installment_skipped',
		'confirmed', 'reversed', 'override_authorized',
		'advance_scheduled', 'advance_authorized', 'advance_paid', 'advance_canceled',
		'renegotiated', 'projected_to_contractor', 'imported'
	))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_events_workspace_id_uq" ON "fdp_ledger_events" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_ledger_events_entry_idx" ON "fdp_ledger_events" USING btree ("workspace_id","entry_id","created_at");--> statement-breakpoint
ALTER TABLE "fdp_ledger_events" ADD CONSTRAINT "fdp_ledger_events_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_events" ADD CONSTRAINT "fdp_ledger_events_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."fdp_ledger_entries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. Importação assistida da planilha
-- ---------------------------------------------------------------------------
CREATE TABLE "fdp_ledger_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"filename" text NOT NULL,
	"file_hash" text NOT NULL,
	-- A competência a partir da qual o Vinculato passa a controlar. O que é
	-- anterior a ela entra como saldo inicial, não como pagamento a refazer.
	"entry_competence" text NOT NULL,
	"mapping_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"totals_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_by" text,
	"committed_at" timestamp with time zone,
	CONSTRAINT "fdp_ledger_imports_competence_check" CHECK ("entry_competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_ledger_imports_status_check" CHECK ("status" IN ('draft', 'mapped', 'previewed', 'committed', 'canceled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_imports_workspace_id_uq" ON "fdp_ledger_imports" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_ledger_imports_workspace_hash_idx" ON "fdp_ledger_imports" USING btree ("workspace_id","file_hash");--> statement-breakpoint
ALTER TABLE "fdp_ledger_imports" ADD CONSTRAINT "fdp_ledger_imports_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "fdp_ledger_import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"import_id" text NOT NULL,
	"sheet_name" text NOT NULL,
	"row_number" integer NOT NULL,
	"block_label" text DEFAULT '' NOT NULL,
	-- O texto original, sempre. É a referência de quem vai conferir a
	-- interpretação depois — "5/10 R$ 200,00 Emprestimo Loja" fica legível.
	"raw_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parsed_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ambiguities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution" text DEFAULT 'pending' NOT NULL,
	"employee_id" text,
	"entry_id" text,
	"row_hash" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_ledger_import_rows_resolution_check" CHECK ("resolution" IN ('pending', 'resolved', 'ignored')),
	CONSTRAINT "fdp_ledger_import_rows_number_check" CHECK ("row_number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_import_rows_workspace_id_uq" ON "fdp_ledger_import_rows" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_ledger_import_rows_position_uq" ON "fdp_ledger_import_rows" USING btree ("workspace_id","import_id","sheet_name","row_number");--> statement-breakpoint
-- Reimportar o mesmo arquivo não grava de novo o que já virou lançamento. Linha
-- ainda não gravada continua livre para ser reprocessada.
CREATE UNIQUE INDEX "fdp_ledger_import_rows_committed_uq" ON "fdp_ledger_import_rows" USING btree ("workspace_id","row_hash") WHERE "entry_id" IS NOT NULL AND "row_hash" <> '';--> statement-breakpoint
CREATE INDEX "fdp_ledger_import_rows_import_idx" ON "fdp_ledger_import_rows" USING btree ("workspace_id","import_id","resolution");--> statement-breakpoint
ALTER TABLE "fdp_ledger_import_rows" ADD CONSTRAINT "fdp_ledger_import_rows_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_import_rows" ADD CONSTRAINT "fdp_ledger_import_rows_import_fk" FOREIGN KEY ("workspace_id","import_id") REFERENCES "public"."fdp_ledger_imports"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_ledger_import_rows" ADD CONSTRAINT "fdp_ledger_import_rows_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."fdp_ledger_entries"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. Isolamento por tenant — no banco, não só na consulta
-- ---------------------------------------------------------------------------
ALTER TABLE "fdp_ledger_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_batches_workspace_isolation" ON "fdp_ledger_batches"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_entries_workspace_isolation" ON "fdp_ledger_entries"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_installments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_installments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_installments_workspace_isolation" ON "fdp_ledger_installments"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_confirmations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_confirmations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_confirmations_workspace_isolation" ON "fdp_ledger_confirmations"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_advance_rules_workspace_isolation" ON "fdp_ledger_advance_rules"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_advance_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_advance_payments_workspace_isolation" ON "fdp_ledger_advance_payments"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_documents_workspace_isolation" ON "fdp_ledger_documents"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_events_workspace_isolation" ON "fdp_ledger_events"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_imports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_imports_workspace_isolation" ON "fdp_ledger_imports"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_ledger_import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_ledger_import_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_ledger_import_rows_workspace_isolation" ON "fdp_ledger_import_rows"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. Concorrência otimista
-- ---------------------------------------------------------------------------
-- A função já existe desde a 0061; aqui só estendemos a proteção às tabelas
-- deste módulo onde duas pessoas editam a mesma linha ao mesmo tempo.
DROP TRIGGER IF EXISTS "fdp_ledger_entries_version_bump" ON "fdp_ledger_entries";--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_entries_version_bump" BEFORE UPDATE ON "fdp_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();--> statement-breakpoint
DROP TRIGGER IF EXISTS "fdp_ledger_installments_version_bump" ON "fdp_ledger_installments";--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_installments_version_bump" BEFORE UPDATE ON "fdp_ledger_installments"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();--> statement-breakpoint
DROP TRIGGER IF EXISTS "fdp_ledger_batches_version_bump" ON "fdp_ledger_batches";--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_batches_version_bump" BEFORE UPDATE ON "fdp_ledger_batches"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();--> statement-breakpoint
DROP TRIGGER IF EXISTS "fdp_ledger_advance_payments_version_bump" ON "fdp_ledger_advance_payments";--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_advance_payments_version_bump" BEFORE UPDATE ON "fdp_ledger_advance_payments"
  FOR EACH ROW EXECUTE FUNCTION fdp_bump_row_version();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. Confirmação é append-only
-- ---------------------------------------------------------------------------
-- Corrigir uma confirmação é gravar um estorno, não editar a linha. Sem esta
-- barreira, "descontei R$ 200" viraria "descontei R$ 50" sem deixar rastro — e
-- é justamente esse rastro que a planilha não tinha.
CREATE OR REPLACE FUNCTION "fdp_ledger_confirmations_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fdp_ledger_confirmations is append-only: corrija por estorno';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_confirmations_immutable"
BEFORE UPDATE OR DELETE ON "fdp_ledger_confirmations"
FOR EACH ROW EXECUTE FUNCTION "fdp_ledger_confirmations_append_only"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "fdp_ledger_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fdp_ledger_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_events_immutable"
BEFORE UPDATE OR DELETE ON "fdp_ledger_events"
FOR EACH ROW EXECUTE FUNCTION "fdp_ledger_events_append_only"();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. O saldo da parcela sai das confirmações
-- ---------------------------------------------------------------------------
-- Este trigger é o coração do módulo. Ele faz três coisas que a aplicação não
-- pode ser a única a fazer:
--
--  * o `UPDATE` na parcela toma o lock da linha, o que **serializa** duas
--    confirmações simultâneas: a segunda enxerga o total da primeira;
--  * recusa desconto acima do previsto, salvo `authorized_override` — que é o
--    "ajuste explicitamente autorizado e documentado", com justificativa
--    exigida pelo CHECK da tabela;
--  * recusa estorno maior que o confirmado, que deixaria saldo negativo.
--
-- A situação da parcela é derivada, nunca digitada. Parcela cancelada, pulada
-- ou reprogramada mantém a situação: ela saiu da programação por decisão
-- humana e uma confirmação tardia não a traz de volta sozinha.
CREATE OR REPLACE FUNCTION "fdp_ledger_apply_confirmation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parcela RECORD;
  novo_total numeric(18, 2);
BEGIN
  SELECT * INTO parcela FROM "fdp_ledger_installments"
    WHERE "workspace_id" = NEW."workspace_id" AND "id" = NEW."installment_id"
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'installment % not found in workspace %', NEW."installment_id", NEW."workspace_id";
  END IF;

  IF parcela."entry_id" <> NEW."entry_id" THEN
    RAISE EXCEPTION 'confirmation entry does not match the installment entry';
  END IF;

  novo_total := parcela."discounted_amount" + NEW."amount";

  IF novo_total < 0 THEN
    RAISE EXCEPTION 'reversal exceeds the confirmed amount of the installment';
  END IF;

  IF novo_total > parcela."planned_amount" AND NEW."kind" <> 'authorized_override' THEN
    RAISE EXCEPTION 'confirmed amount exceeds the installment balance; use an authorized override';
  END IF;

  UPDATE "fdp_ledger_installments" SET
    "discounted_amount" = novo_total,
    "status" = CASE
      WHEN parcela."status" IN ('canceled', 'skipped', 'rescheduled') THEN parcela."status"
      WHEN novo_total <= 0 THEN 'scheduled'
      WHEN novo_total < parcela."planned_amount" THEN 'partially_discounted'
      ELSE 'discounted'
    END,
    "updated_at" = now()
  WHERE "workspace_id" = NEW."workspace_id" AND "id" = NEW."installment_id";

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_confirmations_apply"
AFTER INSERT ON "fdp_ledger_confirmations"
FOR EACH ROW EXECUTE FUNCTION "fdp_ledger_apply_confirmation"();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 14. Parcela confirmada é preservada
-- ---------------------------------------------------------------------------
-- Reprogramar, pular ou cancelar só vale para o que ainda não foi descontado.
-- O valor previsto de uma parcela já confirmada também congela: alterá-lo
-- mudaria o saldo de uma obrigação já parcialmente quitada.
CREATE OR REPLACE FUNCTION "fdp_ledger_installment_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."discounted_amount" <> 0 THEN
      RAISE EXCEPTION 'confirmed installment cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."discounted_amount" <> 0 THEN
    IF NEW."planned_amount" IS DISTINCT FROM OLD."planned_amount"
      OR NEW."competence" IS DISTINCT FROM OLD."competence"
      OR NEW."entry_id" IS DISTINCT FROM OLD."entry_id"
      OR NEW."number" IS DISTINCT FROM OLD."number" THEN
      RAISE EXCEPTION 'confirmed installment is immutable';
    END IF;
    IF NEW."status" IN ('canceled', 'skipped', 'rescheduled') AND OLD."status" NOT IN ('canceled', 'skipped', 'rescheduled') THEN
      RAISE EXCEPTION 'confirmed installment cannot be canceled, skipped or rescheduled; reverse the confirmation first';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_installments_guard"
BEFORE UPDATE OR DELETE ON "fdp_ledger_installments"
FOR EACH ROW EXECUTE FUNCTION "fdp_ledger_installment_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 15. Lote fechado é imutável; reabrir exige justificativa
-- ---------------------------------------------------------------------------
-- A mesma regra que `fdp_contractor_closings` já tem, pelo mesmo motivo: o
-- snapshot da conferência é a prova do que foi conferido, e reabrir sem motivo
-- escrito transforma a prova em rascunho.
CREATE OR REPLACE FUNCTION "fdp_ledger_batch_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('confirmed', 'closed') THEN
      RAISE EXCEPTION 'closed ledger batch cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'closed' THEN
    IF NEW."snapshot_json" IS DISTINCT FROM OLD."snapshot_json"
      OR NEW."competence" IS DISTINCT FROM OLD."competence"
      OR NEW."company_id" IS DISTINCT FROM OLD."company_id"
      OR NEW."payroll_cycle_id" IS DISTINCT FROM OLD."payroll_cycle_id" THEN
      RAISE EXCEPTION 'closed ledger batch is immutable';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
      AND NOT (NEW."status" = 'reopened' AND length(trim(coalesce(NEW."reopen_reason", ''))) >= 5) THEN
      RAISE EXCEPTION 'reopening a closed ledger batch requires a justification';
    END IF;
  END IF;

  NEW."updated_at" = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_ledger_batches_guard"
BEFORE UPDATE OR DELETE ON "fdp_ledger_batches"
FOR EACH ROW EXECUTE FUNCTION "fdp_ledger_batch_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 16. Vocabulários existentes, ampliados
-- ---------------------------------------------------------------------------
-- Aprovar um lançamento passa a ser uma movimentação como qualquer outra: entra
-- na fila de aprovações que já existe, herda a segregação contra autoaprovação
-- e passa a barrar o fechamento enquanto não for decidida.
ALTER TABLE "fdp_employee_movements" DROP CONSTRAINT IF EXISTS "fdp_employee_movements_type_check";--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_type_check" CHECK ("movement_type" IN ('salary_change', 'vacation', 'leave', 'termination', 'transfer', 'benefit_change', 'registration_sync', 'epi_discount', 'payroll_discount', 'salary_advance', 'other'));--> statement-breakpoint

-- Saldo em aberto no desligamento, parcela atrasada e lançamento sem aprovação
-- viram pendência pelo mecanismo que já bloqueia o fechamento — não por um
-- segundo mecanismo de bloqueio.
ALTER TABLE "fdp_operational_pending_items" DROP CONSTRAINT IF EXISTS "fdp_operational_pending_items_source_check";--> statement-breakpoint
ALTER TABLE "fdp_operational_pending_items" ADD CONSTRAINT "fdp_operational_pending_items_source_check" CHECK ("source_type" IN ('movement', 'approval', 'obligation', 'cycle', 'card', 'ledger_entry'));--> statement-breakpoint

-- Uma demanda pode apontar para o lançamento que ela originou.
ALTER TABLE "fdp_demand_module_links" DROP CONSTRAINT IF EXISTS "fdp_demand_module_links_module_check";--> statement-breakpoint
ALTER TABLE "fdp_demand_module_links" ADD CONSTRAINT "fdp_demand_module_links_module_check" CHECK ("module_key" IN ('competence', 'movement', 'obligation', 'benefit', 'contractor', 'epi', 'integration', 'payroll_ledger'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 17. O módulo entra no catálogo
-- ---------------------------------------------------------------------------
-- Sem esta linha o módulo existiria em código e não teria porta: o menu do
-- painel é montado a partir de `fdp_modules`.
INSERT INTO "fdp_modules" ("key", "name", "description", "category", "route", "required_capability", "depends_on", "position") VALUES
  ('payroll_ledger', 'Adiantamentos e Descontos', 'Adiantamentos salariais, empréstimos, multas, franquias e descontos parcelados ou recorrentes, com parcelas, saldos, aprovação e conferência por competência.', 'folha', 'adiantamentos', 'ledger.read', 'processes', 430)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Controlar o que se desconta do salário de alguém não é recurso de porte: é a
-- obrigação de quem desconta. Entra em todos os planos, como o EPI entrou.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", 'payroll_ledger' FROM "fdp_saas_plans" p
ON CONFLICT DO NOTHING;
