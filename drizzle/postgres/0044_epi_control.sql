-- Controle de EPI: cadastro, entrega, troca, devolução, higienização, descarte
-- e análise de desconto.
--
-- Migration aditiva: nenhuma tabela existente é removida ou reescrita.
--
-- Três decisões estão gravadas no banco, não na aplicação, porque são as que
-- não podem depender de disciplina de quem escreve a próxima rota:
--
--  1. estoque não fica negativo (CHECK em `stock_quantity`);
--  2. devolução nunca soma mais do que foi entregue (CHECK em
--     `settled_quantity` contra `quantity`);
--  3. o razão de movimentações é append-only (trigger), porque é ele que
--     sustenta o histórico do colaborador e a auditoria do descarte.
--
-- O desconto nunca é lançado: a análise vira demanda do DP, e é por isso que
-- `fdp_epi_discount_requests` aponta para `fdp_cards` em vez de guardar um
-- valor a descontar como fato consumado.
CREATE TABLE "fdp_epi_products" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"epi_type" text NOT NULL,
	"ca_number" text NOT NULL,
	"size" text NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"unit_value" numeric(14, 2) DEFAULT 0 NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"registered_on" date NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"registration_reason" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"product_expires_on" date,
	"ca_expires_on" date,
	"supplier" text DEFAULT '' NOT NULL,
	"internal_code" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_products_name_check" CHECK (length("fdp_epi_products"."name") > 0),
	CONSTRAINT "fdp_epi_products_ca_check" CHECK (length("fdp_epi_products"."ca_number") > 0),
	CONSTRAINT "fdp_epi_products_size_check" CHECK (length("fdp_epi_products"."size") > 0),
	CONSTRAINT "fdp_epi_products_type_check" CHECK ("fdp_epi_products"."epi_type" IN ('head', 'eye_face', 'hearing', 'respiratory', 'trunk', 'upper_limbs', 'lower_limbs', 'full_body', 'fall_protection', 'other')),
	CONSTRAINT "fdp_epi_products_status_check" CHECK ("fdp_epi_products"."status" IN ('active', 'inactive', 'in_stock', 'delivered', 'returned', 'sanitizing', 'discarded', 'damaged', 'lost')),
	CONSTRAINT "fdp_epi_products_reason_check" CHECK ("fdp_epi_products"."registration_reason" IN ('first_delivery', 'periodic_exchange', 'damage_replacement', 'loss_replacement', 'expiry_replacement', 'initial_purchase', 'stock_replenishment', 'manual_adjustment', 'other')),
	CONSTRAINT "fdp_epi_products_stock_check" CHECK ("fdp_epi_products"."stock_quantity" >= 0),
	CONSTRAINT "fdp_epi_products_value_check" CHECK ("fdp_epi_products"."unit_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_epi_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"product_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"delivered_on" date NOT NULL,
	"position_name" text DEFAULT '' NOT NULL,
	"department_name" text DEFAULT '' NOT NULL,
	"ca_number" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"settled_quantity" integer DEFAULT 0 NOT NULL,
	"unit_value" numeric(14, 2) DEFAULT 0 NOT NULL,
	"responsible_user_id" text,
	"delivery_reason" text NOT NULL,
	"status" text DEFAULT 'delivered' NOT NULL,
	"signature_name" text DEFAULT '' NOT NULL,
	"signed_at" timestamp with time zone,
	"canceled_reason" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_deliveries_quantity_check" CHECK ("fdp_epi_deliveries"."quantity" > 0),
	-- A conta que impede a devolução fantasma: nunca volta mais do que saiu.
	CONSTRAINT "fdp_epi_deliveries_settled_check" CHECK ("fdp_epi_deliveries"."settled_quantity" >= 0 AND "fdp_epi_deliveries"."settled_quantity" <= "fdp_epi_deliveries"."quantity"),
	CONSTRAINT "fdp_epi_deliveries_status_check" CHECK ("fdp_epi_deliveries"."status" IN ('delivered', 'pending_signature', 'signed', 'canceled')),
	CONSTRAINT "fdp_epi_deliveries_reason_check" CHECK ("fdp_epi_deliveries"."delivery_reason" IN ('first_delivery', 'periodic_exchange', 'damage_replacement', 'loss_replacement', 'expiry_replacement', 'initial_purchase', 'stock_replenishment', 'manual_adjustment', 'other')),
	CONSTRAINT "fdp_epi_deliveries_value_check" CHECK ("fdp_epi_deliveries"."unit_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_epi_returns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"product_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"returned_on" date NOT NULL,
	"quantity" integer NOT NULL,
	"ca_number" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"epi_condition" text NOT NULL,
	"received_by" text,
	"needs_sanitizing" integer DEFAULT 0 NOT NULL,
	"back_to_stock" integer DEFAULT 0 NOT NULL,
	"send_to_disposal" integer DEFAULT 0 NOT NULL,
	"generate_dp_demand" integer DEFAULT 0 NOT NULL,
	"discount_request_id" text,
	"disposal_id" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_returns_quantity_check" CHECK ("fdp_epi_returns"."quantity" > 0),
	CONSTRAINT "fdp_epi_returns_condition_check" CHECK ("fdp_epi_returns"."epi_condition" IN ('returned_sanitized', 'returned_pending_sanitizing', 'returned_damaged', 'returned_unusable', 'returned_for_disposal', 'not_returned', 'lost')),
	CONSTRAINT "fdp_epi_returns_flags_check" CHECK ("fdp_epi_returns"."needs_sanitizing" IN (0, 1) AND "fdp_epi_returns"."back_to_stock" IN (0, 1) AND "fdp_epi_returns"."send_to_disposal" IN (0, 1) AND "fdp_epi_returns"."generate_dp_demand" IN (0, 1)),
	-- Devolvido sem devolver não volta ao estoque: a condição decide o destino,
	-- e o destino não pode contradizê-la.
	CONSTRAINT "fdp_epi_returns_missing_check" CHECK ("fdp_epi_returns"."epi_condition" NOT IN ('not_returned', 'lost') OR "fdp_epi_returns"."back_to_stock" = 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_epi_damages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"product_id" text NOT NULL,
	"delivery_id" text,
	"occurred_on" date NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"damage_reason" text NOT NULL,
	"description" text NOT NULL,
	"analyst_user_id" text,
	"decision" text NOT NULL,
	"replacement_product_id" text,
	"replacement_ca_number" text DEFAULT '' NOT NULL,
	"replacement_size" text DEFAULT '' NOT NULL,
	"replacement_quantity" integer DEFAULT 0 NOT NULL,
	"replacement_delivery_id" text,
	"disposal_id" text,
	"discount_request_id" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_damages_quantity_check" CHECK ("fdp_epi_damages"."quantity" > 0 AND "fdp_epi_damages"."replacement_quantity" >= 0),
	CONSTRAINT "fdp_epi_damages_description_check" CHECK (length("fdp_epi_damages"."description") > 0),
	CONSTRAINT "fdp_epi_damages_reason_check" CHECK ("fdp_epi_damages"."damage_reason" IN ('natural_wear', 'work_accident', 'misuse', 'bad_storage', 'protection_loss', 'torn_broken', 'contaminated', 'soaked', 'other')),
	CONSTRAINT "fdp_epi_damages_decision_check" CHECK ("fdp_epi_damages"."decision" IN ('exchange_without_discount', 'send_to_discount_analysis', 'refuse_exchange', 'send_to_disposal', 'send_to_sanitizing'))
);
--> statement-breakpoint
CREATE TABLE "fdp_epi_disposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"product_id" text NOT NULL,
	"employee_id" text,
	"disposal_date" date NOT NULL,
	"quantity" integer NOT NULL,
	"ca_number" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"disposal_reason" text NOT NULL,
	"responsible_user_id" text,
	"status" text DEFAULT 'awaiting_disposal' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"origin_type" text DEFAULT 'manual' NOT NULL,
	"origin_id" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_disposals_quantity_check" CHECK ("fdp_epi_disposals"."quantity" > 0),
	CONSTRAINT "fdp_epi_disposals_reason_check" CHECK ("fdp_epi_disposals"."disposal_reason" IN ('damage', 'contamination', 'natural_wear', 'expired', 'inadequate', 'unusable_return', 'mandatory_exchange', 'other')),
	CONSTRAINT "fdp_epi_disposals_status_check" CHECK ("fdp_epi_disposals"."status" IN ('awaiting_disposal', 'disposed', 'canceled', 'reevaluated')),
	CONSTRAINT "fdp_epi_disposals_origin_check" CHECK ("fdp_epi_disposals"."origin_type" IN ('manual', 'return', 'damage')),
	-- Descarte confirmado sem responsável e sem data é evidência que não prova
	-- nada: quem confirmou e quando fazem parte do próprio ato.
	CONSTRAINT "fdp_epi_disposals_confirmation_check" CHECK ("fdp_epi_disposals"."status" <> 'disposed' OR ("fdp_epi_disposals"."confirmed_by" IS NOT NULL AND "fdp_epi_disposals"."confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
-- O desconto é uma análise, nunca um lançamento. Por isso esta tabela guarda o
-- pedido, a evidência e a decisão — e aponta para a demanda que o DP recebe.
CREATE TABLE "fdp_epi_discount_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"product_id" text NOT NULL,
	"delivery_id" text,
	"card_id" text,
	"title" text NOT NULL,
	"ca_number" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_value" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total_value" numeric(14, 2) DEFAULT 0 NOT NULL,
	"delivered_on" date,
	"occurred_on" date NOT NULL,
	"trigger_reason" text NOT NULL,
	"reason_note" text DEFAULT '' NOT NULL,
	"analyst_user_id" text,
	"status" text DEFAULT 'awaiting_dp_analysis' NOT NULL,
	"decision" text DEFAULT '' NOT NULL,
	"decided_value" numeric(14, 2) DEFAULT 0 NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_comment" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_discounts_quantity_check" CHECK ("fdp_epi_discount_requests"."quantity" > 0),
	CONSTRAINT "fdp_epi_discounts_value_check" CHECK ("fdp_epi_discount_requests"."unit_value" >= 0 AND "fdp_epi_discount_requests"."total_value" >= 0 AND "fdp_epi_discount_requests"."decided_value" >= 0),
	CONSTRAINT "fdp_epi_discounts_trigger_check" CHECK ("fdp_epi_discount_requests"."trigger_reason" IN ('lost', 'not_returned', 'misuse_damage', 'refused_return', 'manual_request', 'delivery_return_divergence')),
	CONSTRAINT "fdp_epi_discounts_status_check" CHECK ("fdp_epi_discount_requests"."status" IN ('awaiting_dp_analysis', 'awaiting_approval', 'approved_for_discount', 'refused', 'canceled', 'finished')),
	CONSTRAINT "fdp_epi_discounts_decision_check" CHECK ("fdp_epi_discount_requests"."decision" IN ('', 'no_discount', 'full_discount', 'partial_discount', 'request_more_info', 'forward_to_payroll', 'close_without_action')),
	-- O valor decidido nunca ultrapassa o valor do EPI em análise.
	CONSTRAINT "fdp_epi_discounts_decided_bound_check" CHECK ("fdp_epi_discount_requests"."decided_value" <= "fdp_epi_discount_requests"."total_value"),
	-- Aprovar para desconto sem valor é aprovar nada; recusar com valor é
	-- contradizer a própria decisão.
	CONSTRAINT "fdp_epi_discounts_approval_check" CHECK ("fdp_epi_discount_requests"."status" <> 'approved_for_discount' OR "fdp_epi_discount_requests"."decided_value" > 0)
);
--> statement-breakpoint
-- Razão único das movimentações. É ele que sustenta a aba do colaborador, os
-- relatórios por competência e a prova de quem fez o quê.
CREATE TABLE "fdp_epi_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"movement_date" date NOT NULL,
	"movement_type" text NOT NULL,
	"cnpj" text DEFAULT '' NOT NULL,
	"product_id" text NOT NULL,
	"epi_name" text NOT NULL,
	"ca_number" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"employee_id" text,
	"employee_name" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"stock_delta" integer DEFAULT 0 NOT NULL,
	"unit_value" numeric(14, 2) DEFAULT 0 NOT NULL,
	"movement_reason" text DEFAULT '' NOT NULL,
	"epi_condition" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"generate_dp_demand" integer DEFAULT 0 NOT NULL,
	"demand_id" text,
	"discount_request_id" text,
	"source_type" text DEFAULT 'product' NOT NULL,
	"source_id" text DEFAULT '' NOT NULL,
	"responsible_id" text,
	"attachments_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_movements_type_check" CHECK ("fdp_epi_movements"."movement_type" IN ('registration', 'delivery', 'exchange', 'return', 'sanitizing', 'disposal', 'discount_analysis', 'manual_adjustment')),
	CONSTRAINT "fdp_epi_movements_source_check" CHECK ("fdp_epi_movements"."source_type" IN ('product', 'delivery', 'return', 'damage', 'disposal', 'discount')),
	CONSTRAINT "fdp_epi_movements_flag_check" CHECK ("fdp_epi_movements"."generate_dp_demand" IN (0, 1)),
	CONSTRAINT "fdp_epi_movements_quantity_check" CHECK ("fdp_epi_movements"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_epi_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"attachment_kind" text DEFAULT 'evidence' NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_attachments_entity_check" CHECK ("fdp_epi_attachments"."entity_type" IN ('product', 'delivery', 'return', 'damage', 'disposal', 'discount')),
	CONSTRAINT "fdp_epi_attachments_kind_check" CHECK ("fdp_epi_attachments"."attachment_kind" IN ('evidence', 'delivery_term', 'photo', 'document')),
	CONSTRAINT "fdp_epi_attachments_size_check" CHECK ("fdp_epi_attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
-- Chaves compostas com `workspace_id`: o tenant faz parte da referência, então
-- apontar para a linha de outro cliente deixa de ser representável.
CREATE UNIQUE INDEX "fdp_epi_products_workspace_id_uq" ON "fdp_epi_products" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_products_workspace_company_id_uq" ON "fdp_epi_products" USING btree ("workspace_id","company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_products_internal_code_uq" ON "fdp_epi_products" USING btree ("workspace_id","company_id","internal_code") WHERE "internal_code" <> '';--> statement-breakpoint
CREATE INDEX "fdp_epi_products_workspace_status_idx" ON "fdp_epi_products" USING btree ("workspace_id","status","name");--> statement-breakpoint
CREATE INDEX "fdp_epi_products_workspace_company_name_idx" ON "fdp_epi_products" USING btree ("workspace_id","company_id","name");--> statement-breakpoint
CREATE INDEX "fdp_epi_products_workspace_ca_idx" ON "fdp_epi_products" USING btree ("workspace_id","ca_number");--> statement-breakpoint
CREATE INDEX "fdp_epi_products_ca_expiry_idx" ON "fdp_epi_products" USING btree ("workspace_id","ca_expires_on") WHERE "ca_expires_on" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_deliveries_workspace_id_uq" ON "fdp_epi_deliveries" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_epi_deliveries_workspace_employee_idx" ON "fdp_epi_deliveries" USING btree ("workspace_id","employee_id","delivered_on");--> statement-breakpoint
CREATE INDEX "fdp_epi_deliveries_workspace_status_idx" ON "fdp_epi_deliveries" USING btree ("workspace_id","status","delivered_on");--> statement-breakpoint
CREATE INDEX "fdp_epi_deliveries_workspace_product_idx" ON "fdp_epi_deliveries" USING btree ("workspace_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_returns_workspace_id_uq" ON "fdp_epi_returns" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_epi_returns_workspace_employee_idx" ON "fdp_epi_returns" USING btree ("workspace_id","employee_id","returned_on");--> statement-breakpoint
CREATE INDEX "fdp_epi_returns_workspace_condition_idx" ON "fdp_epi_returns" USING btree ("workspace_id","epi_condition","returned_on");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_damages_workspace_id_uq" ON "fdp_epi_damages" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_epi_damages_workspace_employee_idx" ON "fdp_epi_damages" USING btree ("workspace_id","employee_id","occurred_on");--> statement-breakpoint
CREATE INDEX "fdp_epi_damages_workspace_decision_idx" ON "fdp_epi_damages" USING btree ("workspace_id","decision","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_disposals_workspace_id_uq" ON "fdp_epi_disposals" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_epi_disposals_workspace_status_idx" ON "fdp_epi_disposals" USING btree ("workspace_id","status","disposal_date");--> statement-breakpoint
CREATE INDEX "fdp_epi_disposals_workspace_product_idx" ON "fdp_epi_disposals" USING btree ("workspace_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_discounts_workspace_id_uq" ON "fdp_epi_discount_requests" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_epi_discounts_workspace_status_idx" ON "fdp_epi_discount_requests" USING btree ("workspace_id","status","occurred_on");--> statement-breakpoint
CREATE INDEX "fdp_epi_discounts_workspace_employee_idx" ON "fdp_epi_discount_requests" USING btree ("workspace_id","employee_id","occurred_on");--> statement-breakpoint
CREATE INDEX "fdp_epi_discounts_workspace_card_idx" ON "fdp_epi_discount_requests" USING btree ("workspace_id","card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_movements_workspace_id_uq" ON "fdp_epi_movements" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_epi_movements_workspace_employee_idx" ON "fdp_epi_movements" USING btree ("workspace_id","employee_id","movement_date");--> statement-breakpoint
CREATE INDEX "fdp_epi_movements_workspace_product_idx" ON "fdp_epi_movements" USING btree ("workspace_id","product_id","movement_date");--> statement-breakpoint
CREATE INDEX "fdp_epi_movements_workspace_type_idx" ON "fdp_epi_movements" USING btree ("workspace_id","movement_type","movement_date");--> statement-breakpoint
CREATE INDEX "fdp_epi_movements_workspace_company_date_idx" ON "fdp_epi_movements" USING btree ("workspace_id","company_id","movement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_attachments_workspace_id_uq" ON "fdp_epi_attachments" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_epi_attachments_entity_idx" ON "fdp_epi_attachments" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
ALTER TABLE "fdp_epi_products" ADD CONSTRAINT "fdp_epi_products_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_products" ADD CONSTRAINT "fdp_epi_products_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_deliveries" ADD CONSTRAINT "fdp_epi_deliveries_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_deliveries" ADD CONSTRAINT "fdp_epi_deliveries_product_fk" FOREIGN KEY ("workspace_id","company_id","product_id") REFERENCES "public"."fdp_epi_products"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_deliveries" ADD CONSTRAINT "fdp_epi_deliveries_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_delivery_fk" FOREIGN KEY ("workspace_id","delivery_id") REFERENCES "public"."fdp_epi_deliveries"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_product_fk" FOREIGN KEY ("workspace_id","company_id","product_id") REFERENCES "public"."fdp_epi_products"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_product_fk" FOREIGN KEY ("workspace_id","company_id","product_id") REFERENCES "public"."fdp_epi_products"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_delivery_fk" FOREIGN KEY ("workspace_id","delivery_id") REFERENCES "public"."fdp_epi_deliveries"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ADD CONSTRAINT "fdp_epi_disposals_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ADD CONSTRAINT "fdp_epi_disposals_product_fk" FOREIGN KEY ("workspace_id","company_id","product_id") REFERENCES "public"."fdp_epi_products"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ADD CONSTRAINT "fdp_epi_disposals_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_product_fk" FOREIGN KEY ("workspace_id","company_id","product_id") REFERENCES "public"."fdp_epi_products"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_delivery_fk" FOREIGN KEY ("workspace_id","delivery_id") REFERENCES "public"."fdp_epi_deliveries"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_card_fk" FOREIGN KEY ("workspace_id","card_id") REFERENCES "public"."fdp_cards"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_discount_fk" FOREIGN KEY ("workspace_id","discount_request_id") REFERENCES "public"."fdp_epi_discount_requests"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_disposal_fk" FOREIGN KEY ("workspace_id","disposal_id") REFERENCES "public"."fdp_epi_disposals"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_discount_fk" FOREIGN KEY ("workspace_id","discount_request_id") REFERENCES "public"."fdp_epi_discount_requests"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_disposal_fk" FOREIGN KEY ("workspace_id","disposal_id") REFERENCES "public"."fdp_epi_disposals"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_replacement_delivery_fk" FOREIGN KEY ("workspace_id","replacement_delivery_id") REFERENCES "public"."fdp_epi_deliveries"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_product_fk" FOREIGN KEY ("workspace_id","company_id","product_id") REFERENCES "public"."fdp_epi_products"("workspace_id","company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_attachments" ADD CONSTRAINT "fdp_epi_attachments_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_epi_attachments" ADD CONSTRAINT "fdp_epi_attachments_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Isolamento por tenant no banco, não só na consulta: toda tabela do módulo
-- carrega `workspace_id` e nenhuma delas é global por desenho.
ALTER TABLE "fdp_epi_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_products_workspace_isolation" ON "fdp_epi_products"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_epi_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_deliveries_workspace_isolation" ON "fdp_epi_deliveries"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_returns_workspace_isolation" ON "fdp_epi_returns"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_damages_workspace_isolation" ON "fdp_epi_damages"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_disposals_workspace_isolation" ON "fdp_epi_disposals"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_discounts_workspace_isolation" ON "fdp_epi_discount_requests"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_movements_workspace_isolation" ON "fdp_epi_movements"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_epi_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_attachments_workspace_isolation" ON "fdp_epi_attachments"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
-- O razão é a prova. Reescrever uma movimentação apagaria justamente o que a
-- devolução, o descarte e a análise de desconto precisam demonstrar depois.
CREATE OR REPLACE FUNCTION "fdp_epi_movements_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'epi movements are append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "fdp_epi_movements_append_only"
BEFORE UPDATE OR DELETE ON "fdp_epi_movements"
FOR EACH ROW EXECUTE FUNCTION "fdp_epi_movements_append_only"();--> statement-breakpoint
-- Descarte confirmado não volta ao estoque nem muda de destino: depois do
-- `disposed`, só o registro permanece.
CREATE OR REPLACE FUNCTION "fdp_epi_disposal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'disposed' THEN
      RAISE EXCEPTION 'confirmed disposal is immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'disposed' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.disposal_reason IS DISTINCT FROM OLD.disposal_reason
  ) THEN
    RAISE EXCEPTION 'confirmed disposal is immutable';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "fdp_epi_disposals_guard"
BEFORE UPDATE OR DELETE ON "fdp_epi_disposals"
FOR EACH ROW EXECUTE FUNCTION "fdp_epi_disposal_guard"();--> statement-breakpoint
-- O módulo entra no catálogo. Sem esta linha ele existiria em código e não
-- teria porta: o menu do painel é montado a partir de `fdp_modules`.
INSERT INTO "fdp_modules" ("key", "name", "description", "category", "route", "required_capability", "position") VALUES
  ('epi', 'Controle de EPI', 'Cadastro, entrega, devolução, troca, descarte e análise de desconto de EPI.', 'pessoas', 'epi', 'epi.view', 950)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Entrega de EPI com termo assinado é obrigação de segurança do trabalho de
-- qualquer empresa com colaborador, não recurso de porte. Entra em todos os
-- planos, como já acontece com usuários e permissões.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", 'epi' FROM "fdp_saas_plans" p
ON CONFLICT DO NOTHING;
