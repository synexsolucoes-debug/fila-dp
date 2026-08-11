-- Cadastro de prestador PJ: contrato, valores fixos e movimentação.
--
-- Até aqui o PJ existia só como perfil financeiro, alcançável pelas telas de
-- pagamento. Faltava o cadastro em si — o equivalente ao do colaborador — e as
-- três coisas que a operação acompanha no dia a dia: em que tipo de contrato o
-- prestador está, quanto do contrato já foi consumido, e o histórico do que
-- mudou (reajuste, prorrogação, suspensão, encerramento).

-- 1. Tipo de contrato e valor global -----------------------------------------
--
-- Contrato por prazo determinado tem valor fechado e data de término; o
-- indeterminado não tem nem um nem outro. Guardar o tipo explicitamente evita
-- deduzir a regra da presença de `contract_end`, que é frágil: uma data em
-- branco por descuido viraria silenciosamente "sem prazo".
ALTER TABLE "fdp_contractor_profiles" ADD COLUMN IF NOT EXISTS "contract_type" text DEFAULT 'indeterminado' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD COLUMN IF NOT EXISTS "contract_total_amount" numeric(18, 2);
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD COLUMN IF NOT EXISTS "contract_signed_at" date;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD COLUMN IF NOT EXISTS "payment_day" integer;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_contract_type_check"
  CHECK ("contract_type" IN ('determinado', 'indeterminado'));
--> statement-breakpoint
-- A regra do prazo determinado mora no banco, não só na tela: sem término e sem
-- valor global não existe saldo para acompanhar, e o cadastro perderia o sentido.
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_determinado_check"
  CHECK (
    "contract_type" <> 'determinado'
    OR ("contract_end" IS NOT NULL AND "contract_total_amount" IS NOT NULL AND "contract_total_amount" > 0)
  );
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_indeterminado_check"
  CHECK ("contract_type" <> 'indeterminado' OR "contract_total_amount" IS NULL);
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_contract_window_check"
  CHECK ("contract_end" IS NULL OR "contract_start" IS NULL OR "contract_end" >= "contract_start");
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_payment_day_check"
  CHECK ("payment_day" IS NULL OR ("payment_day" >= 1 AND "payment_day" <= 31));
--> statement-breakpoint
-- Suspenso é situação de contrato, não de cadastro: o prestador continua ativo
-- mas não entra em apuração enquanto estiver suspenso.
ALTER TABLE "fdp_contractor_profiles" DROP CONSTRAINT IF EXISTS "fdp_contractor_profiles_status_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles" ADD CONSTRAINT "fdp_contractor_profiles_status_check"
  CHECK ("status" IN ('active', 'suspended', 'inactive'));
--> statement-breakpoint

-- 2. Valores fixos recorrentes ------------------------------------------------
--
-- `base_amount` é um valor só. A operação também tem parcelas que se repetem
-- todo mês (ajuda de custo, reembolso combinado, desconto de equipamento) e que
-- hoje precisavam ser relançadas competência a competência — trabalho manual
-- que erra por esquecimento, não por cálculo.
--
-- Vigência com início e fim opcional: o item entra nas competências em que
-- estiver valendo e sai sozinho quando terminar, sem ninguém precisar lembrar.
CREATE TABLE IF NOT EXISTS "fdp_contractor_fixed_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"direction" text NOT NULL,
	"component_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	-- Competência no formato AAAA-MM: o item vale por mês, não por dia.
	"effective_from" text NOT NULL,
	"effective_to" text,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_contractor_fixed_items_direction_check" CHECK ("direction" IN ('credit', 'debit')),
	-- Mesma lista dos componentes da competência: é lá que este item se
	-- materializa, e um tipo aceito aqui mas recusado lá deixaria o cadastro
	-- passar para quebrar só na apuração.
	CONSTRAINT "fdp_contractor_fixed_items_type_check" CHECK (
	  ("direction" = 'credit' AND "component_type" IN ('base', 'commission', 'bonus', 'award', 'reimbursement', 'additional', 'positive_adjustment', 'other_credit'))
	  OR ("direction" = 'debit' AND "component_type" IN ('health_plan', 'dental_plan', 'benefit', 'coparticipation', 'equipment', 'advance', 'absence', 'loan', 'negative_adjustment', 'other_debit'))
	),
	CONSTRAINT "fdp_contractor_fixed_items_status_check" CHECK ("status" IN ('active', 'ended')),
	CONSTRAINT "fdp_contractor_fixed_items_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "fdp_contractor_fixed_items_from_check" CHECK ("effective_from" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_contractor_fixed_items_to_check"
	  CHECK ("effective_to" IS NULL OR ("effective_to" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "effective_to" >= "effective_from"))
);
--> statement-breakpoint
ALTER TABLE "fdp_contractor_fixed_items" ADD CONSTRAINT "fdp_contractor_fixed_items_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_fixed_items" ADD CONSTRAINT "fdp_contractor_fixed_items_provider_fk"
  FOREIGN KEY ("provider_id") REFERENCES "public"."fdp_contractor_profiles"("provider_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_fixed_items_provider_idx"
  ON "fdp_contractor_fixed_items" ("workspace_id", "provider_id", "status");
--> statement-breakpoint
ALTER TABLE "fdp_contractor_fixed_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_fixed_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_contractor_fixed_items_read" ON "fdp_contractor_fixed_items" FOR SELECT
  USING ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
CREATE POLICY "fdp_contractor_fixed_items_write" ON "fdp_contractor_fixed_items" FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint

-- 3. Movimentação do prestador ------------------------------------------------
--
-- Mesmo papel que `fdp_employee_movements` cumpre para o colaborador: o que
-- mudou, quando passou a valer e quem decidiu. Sem isso, um reajuste vira uma
-- edição silenciosa do cadastro e ninguém consegue explicar meses depois por
-- que a base daquela competência era outra.
CREATE TABLE IF NOT EXISTS "fdp_contractor_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"movement_type" text NOT NULL,
	"effective_date" date NOT NULL,
	"title" text NOT NULL,
	-- Antes e depois do que a movimentação altera no contrato. Guardar os dois
	-- lados é o que permite explicar a diferença sem reconstruir histórico.
	"before_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"decision_comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_contractor_movements_type_check" CHECK ("movement_type" IN (
	  'base_change', 'fixed_item_change', 'contract_extension', 'contract_value_change',
	  'suspension', 'reactivation', 'termination', 'invoice_limit_change', 'complement_change', 'other')),
	CONSTRAINT "fdp_contractor_movements_status_check" CHECK ("status" IN (
	  'draft', 'pending_approval', 'approved', 'rejected', 'applied', 'canceled')),
	-- Aplicada precisa dizer quando: é a data que explica a competência afetada.
	CONSTRAINT "fdp_contractor_movements_applied_check"
	  CHECK ("status" <> 'applied' OR "applied_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "fdp_contractor_movements" ADD CONSTRAINT "fdp_contractor_movements_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_movements" ADD CONSTRAINT "fdp_contractor_movements_provider_fk"
  FOREIGN KEY ("provider_id") REFERENCES "public"."fdp_contractor_profiles"("provider_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_movements_provider_idx"
  ON "fdp_contractor_movements" ("workspace_id", "provider_id", "effective_date" DESC);
--> statement-breakpoint
ALTER TABLE "fdp_contractor_movements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_movements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_contractor_movements_read" ON "fdp_contractor_movements" FOR SELECT
  USING ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
CREATE POLICY "fdp_contractor_movements_write" ON "fdp_contractor_movements" FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
-- Movimentação aplicada é histórico: corrigir é lançar outra, não reescrever a
-- anterior. O mesmo princípio já vale para preço de plano e ajuste de psicologia.
CREATE OR REPLACE FUNCTION "fdp_contractor_movements_applied_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'applied' THEN
    RAISE EXCEPTION 'applied contractor movements are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_contractor_movements_applied_immutable"
  BEFORE UPDATE OR DELETE ON "fdp_contractor_movements"
  FOR EACH ROW EXECUTE FUNCTION "fdp_contractor_movements_applied_immutable"();
--> statement-breakpoint

-- 4. Ligação do valor fixo com o componente da competência --------------------
--
-- O valor fixo não é um segundo caminho de cálculo: ele é materializado como
-- componente da competência, para que `calculateContractorClosing` continue
-- sendo o único lugar que resolve líquido → nota → complemento → Caju.
--
-- A referência ao item de origem é o que torna a materialização idempotente —
-- reapurar a competência atualiza o mesmo componente em vez de somar outro.
-- `external_id` não serve para isso: ele é a chave de idempotência de quem
-- integra por API, e usar o mesmo campo faria os dois usos colidirem.
ALTER TABLE "fdp_contractor_components" ADD COLUMN IF NOT EXISTS "fixed_item_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" DROP CONSTRAINT IF EXISTS "fdp_contractor_components_origin_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_origin_check"
  CHECK ("origin" IN ('manual', 'import', 'integration', 'fixed_item'));
--> statement-breakpoint
-- Um componente por valor fixo em cada competência.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_components_fixed_item_uq"
  ON "fdp_contractor_components" ("workspace_id", "payroll_cycle_id", "fixed_item_id")
  WHERE "fixed_item_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_components" ADD CONSTRAINT "fdp_contractor_components_fixed_item_fk"
  FOREIGN KEY ("fixed_item_id") REFERENCES "public"."fdp_contractor_fixed_items"("id") ON DELETE SET NULL ON UPDATE no action;
