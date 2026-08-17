-- Áreas operacionais e estoque compartilhado do Workspace.
--
-- O saldo deixa de ter `company_id` na identidade. `fdp_epi_products.stock_quantity`
-- permanece apenas como projeção compatível, atualizada exclusivamente pela função
-- transacional abaixo; a fonte de verdade passa a ser `fdp_stock_balances`.

CREATE TABLE "fdp_stock_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_stock_locations_status_check" CHECK ("status" IN ('active', 'inactive')),
	CONSTRAINT "fdp_stock_locations_default_check" CHECK ("is_default" IN (0, 1)),
	CONSTRAINT "fdp_stock_locations_name_check" CHECK (length("name") > 0),
	CONSTRAINT "fdp_stock_locations_code_check" CHECK (length("code") > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_stock_locations_workspace_id_uq" ON "fdp_stock_locations" ("workspace_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_stock_locations_workspace_code_uq" ON "fdp_stock_locations" ("workspace_id", "code");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_stock_locations_workspace_default_uq" ON "fdp_stock_locations" ("workspace_id") WHERE "is_default" = 1;--> statement-breakpoint
CREATE INDEX "fdp_stock_locations_workspace_status_idx" ON "fdp_stock_locations" ("workspace_id", "status", "name");--> statement-breakpoint
ALTER TABLE "fdp_stock_locations" ADD CONSTRAINT "fdp_stock_locations_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;--> statement-breakpoint

INSERT INTO "fdp_stock_locations" (id, workspace_id, code, name, description, status, is_default, created_by, updated_by)
SELECT w.id || ':stock:default', w.id, 'PRINCIPAL', 'Estoque principal', 'Local padrão criado na migração do saldo compartilhado.', 'active', 1, w.owner_user_id, w.owner_user_id
FROM "fdp_workspaces" w
ON CONFLICT (workspace_id, code) DO NOTHING;--> statement-breakpoint

CREATE TABLE "fdp_stock_balances" (
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"product_id" text NOT NULL,
	"stock_location_id" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_stock_balances_pk" PRIMARY KEY ("workspace_id", "product_id", "stock_location_id"),
	CONSTRAINT "fdp_stock_balances_quantity_check" CHECK ("quantity" >= 0),
	CONSTRAINT "fdp_stock_balances_version_check" CHECK ("version" >= 0)
);--> statement-breakpoint
CREATE INDEX "fdp_stock_balances_workspace_location_idx" ON "fdp_stock_balances" ("workspace_id", "stock_location_id", "product_id");--> statement-breakpoint
CREATE INDEX "fdp_stock_balances_workspace_product_idx" ON "fdp_stock_balances" ("workspace_id", "product_id");--> statement-breakpoint
ALTER TABLE "fdp_stock_balances" ADD CONSTRAINT "fdp_stock_balances_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "fdp_stock_balances" ADD CONSTRAINT "fdp_stock_balances_product_fk" FOREIGN KEY ("workspace_id", "product_id") REFERENCES "public"."fdp_epi_products"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_stock_balances" ADD CONSTRAINT "fdp_stock_balances_location_fk" FOREIGN KEY ("workspace_id", "stock_location_id") REFERENCES "public"."fdp_stock_locations"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint

INSERT INTO "fdp_stock_balances" (workspace_id, product_id, stock_location_id, quantity, version, updated_by)
SELECT p.workspace_id, p.id, l.id, p.stock_quantity, 0, p.updated_by
FROM "fdp_epi_products" p
JOIN "fdp_stock_locations" l ON l.workspace_id = p.workspace_id AND l.is_default = 1
ON CONFLICT (workspace_id, product_id, stock_location_id) DO NOTHING;--> statement-breakpoint

-- Produto/SKU é do Workspace; empresa nas tabelas operacionais continua sendo
-- quem consumiu, usou, devolveu ou descartou.
ALTER TABLE "fdp_epi_deliveries" DROP CONSTRAINT IF EXISTS "fdp_epi_deliveries_product_fk";--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" DROP CONSTRAINT IF EXISTS "fdp_epi_returns_product_fk";--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" DROP CONSTRAINT IF EXISTS "fdp_epi_damages_product_fk";--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" DROP CONSTRAINT IF EXISTS "fdp_epi_disposals_product_fk";--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" DROP CONSTRAINT IF EXISTS "fdp_epi_discounts_product_fk";--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" DROP CONSTRAINT IF EXISTS "fdp_epi_movements_product_fk";--> statement-breakpoint

-- `company_id` no cadastro passa a significar empresa compradora/rastreabilidade.
-- Ela deixa de participar da identidade do produto e pode ficar vazia. As FKs
-- consumidoras acima precisam sair antes do índice único que as sustentava.
DROP INDEX IF EXISTS "fdp_epi_products_workspace_company_id_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "fdp_epi_products_internal_code_uq";--> statement-breakpoint
ALTER TABLE "fdp_epi_products" DROP CONSTRAINT IF EXISTS "fdp_epi_products_workspace_company_fk";--> statement-breakpoint
ALTER TABLE "fdp_epi_products" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_products" ADD CONSTRAINT "fdp_epi_products_workspace_purchasing_company_fk" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_products_internal_code_workspace_uq" ON "fdp_epi_products" ("workspace_id", "internal_code") WHERE "internal_code" <> '';--> statement-breakpoint

ALTER TABLE "fdp_epi_deliveries" ADD CONSTRAINT "fdp_epi_deliveries_product_fk" FOREIGN KEY ("workspace_id", "product_id") REFERENCES "public"."fdp_epi_products"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_product_fk" FOREIGN KEY ("workspace_id", "product_id") REFERENCES "public"."fdp_epi_products"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_product_fk" FOREIGN KEY ("workspace_id", "product_id") REFERENCES "public"."fdp_epi_products"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ADD CONSTRAINT "fdp_epi_disposals_product_fk" FOREIGN KEY ("workspace_id", "product_id") REFERENCES "public"."fdp_epi_products"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_product_fk" FOREIGN KEY ("workspace_id", "product_id") REFERENCES "public"."fdp_epi_products"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_product_fk" FOREIGN KEY ("workspace_id", "product_id") REFERENCES "public"."fdp_epi_products"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "fdp_epi_deliveries" ADD COLUMN "stock_location_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD COLUMN "stock_location_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD COLUMN "stock_location_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ADD COLUMN "stock_location_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD COLUMN "stock_location_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD COLUMN "target_stock_location_id" text;--> statement-breakpoint
UPDATE "fdp_epi_deliveries" d SET stock_location_id = l.id FROM "fdp_stock_locations" l WHERE l.workspace_id = d.workspace_id AND l.is_default = 1 AND d.stock_location_id IS NULL;--> statement-breakpoint
UPDATE "fdp_epi_returns" r SET stock_location_id = l.id FROM "fdp_stock_locations" l WHERE l.workspace_id = r.workspace_id AND l.is_default = 1 AND r.stock_location_id IS NULL;--> statement-breakpoint
UPDATE "fdp_epi_damages" d SET stock_location_id = l.id FROM "fdp_stock_locations" l WHERE l.workspace_id = d.workspace_id AND l.is_default = 1 AND d.stock_location_id IS NULL;--> statement-breakpoint
UPDATE "fdp_epi_disposals" d SET stock_location_id = l.id FROM "fdp_stock_locations" l WHERE l.workspace_id = d.workspace_id AND l.is_default = 1 AND d.stock_location_id IS NULL;--> statement-breakpoint
UPDATE "fdp_epi_movements" m SET stock_location_id = l.id FROM "fdp_stock_locations" l WHERE l.workspace_id = m.workspace_id AND l.is_default = 1 AND m.stock_location_id IS NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_deliveries" ALTER COLUMN "stock_location_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ALTER COLUMN "stock_location_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ALTER COLUMN "stock_location_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_deliveries" ADD CONSTRAINT "fdp_epi_deliveries_stock_location_fk" FOREIGN KEY ("workspace_id", "stock_location_id") REFERENCES "public"."fdp_stock_locations"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_stock_location_fk" FOREIGN KEY ("workspace_id", "stock_location_id") REFERENCES "public"."fdp_stock_locations"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD CONSTRAINT "fdp_epi_damages_stock_location_fk" FOREIGN KEY ("workspace_id", "stock_location_id") REFERENCES "public"."fdp_stock_locations"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ADD CONSTRAINT "fdp_epi_disposals_stock_location_fk" FOREIGN KEY ("workspace_id", "stock_location_id") REFERENCES "public"."fdp_stock_locations"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_stock_location_fk" FOREIGN KEY ("workspace_id", "stock_location_id") REFERENCES "public"."fdp_stock_locations"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_target_stock_location_fk" FOREIGN KEY ("workspace_id", "target_stock_location_id") REFERENCES "public"."fdp_stock_locations"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX "fdp_epi_movements_workspace_location_date_idx" ON "fdp_epi_movements" ("workspace_id", "stock_location_id", "movement_date");--> statement-breakpoint

ALTER TABLE "fdp_epi_deliveries" ADD COLUMN "idempotency_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD COLUMN "idempotency_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_damages" ADD COLUMN "idempotency_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_disposals" ADD COLUMN "idempotency_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD COLUMN "idempotency_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD COLUMN "idempotency_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_deliveries_idempotency_uq" ON "fdp_epi_deliveries" ("workspace_id", "idempotency_key") WHERE "idempotency_key" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_returns_idempotency_uq" ON "fdp_epi_returns" ("workspace_id", "idempotency_key") WHERE "idempotency_key" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_damages_idempotency_uq" ON "fdp_epi_damages" ("workspace_id", "idempotency_key") WHERE "idempotency_key" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_disposals_idempotency_uq" ON "fdp_epi_disposals" ("workspace_id", "idempotency_key") WHERE "idempotency_key" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_discounts_idempotency_uq" ON "fdp_epi_discount_requests" ("workspace_id", "idempotency_key") WHERE "idempotency_key" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_movements_idempotency_uq" ON "fdp_epi_movements" ("workspace_id", "idempotency_key") WHERE "idempotency_key" <> '';--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" DROP CONSTRAINT IF EXISTS "fdp_epi_movements_type_check";--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_type_check" CHECK ("movement_type" IN ('registration', 'stock_entry', 'stock_transfer', 'delivery', 'exchange', 'return', 'sanitizing', 'sanitization_completed', 'disposal', 'discount_analysis', 'manual_adjustment'));--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" DROP CONSTRAINT IF EXISTS "fdp_epi_movements_source_check";--> statement-breakpoint
ALTER TABLE "fdp_epi_movements" ADD CONSTRAINT "fdp_epi_movements_source_check" CHECK ("source_type" IN ('product', 'entry', 'transfer', 'delivery', 'return', 'sanitization', 'damage', 'disposal', 'discount'));--> statement-breakpoint

ALTER TABLE "fdp_epi_returns" ADD COLUMN "sanitization_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD COLUMN "sanitization_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD COLUMN "sanitization_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD COLUMN "sanitization_responsible_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD COLUMN "sanitization_result" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "fdp_epi_returns" SET sanitization_status = CASE WHEN needs_sanitizing = 1 THEN 'awaiting' ELSE 'not_required' END;--> statement-breakpoint
ALTER TABLE "fdp_epi_returns" ADD CONSTRAINT "fdp_epi_returns_sanitization_status_check" CHECK ("sanitization_status" IN ('not_required', 'awaiting', 'in_progress', 'sanitized', 'rejected'));--> statement-breakpoint

-- Áreas operacionais do Workspace. `fdp_departments` continua representando
-- lotação organizacional por empresa; não se mistura CNPJ com origem/destino de fluxo.
CREATE TABLE "fdp_areas" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"manager_user_id" text,
	"color" text DEFAULT '#475569' NOT NULL,
	"icon" text DEFAULT 'building-2' NOT NULL,
	"default_sla_days" integer DEFAULT 3 NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_areas_status_check" CHECK ("status" IN ('active', 'inactive', 'archived')),
	CONSTRAINT "fdp_areas_name_check" CHECK (length("name") > 0),
	CONSTRAINT "fdp_areas_code_check" CHECK (length("code") > 0),
	CONSTRAINT "fdp_areas_sla_check" CHECK ("default_sla_days" BETWEEN 0 AND 365)
);--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_areas_workspace_id_uq" ON "fdp_areas" ("workspace_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_areas_workspace_code_uq" ON "fdp_areas" ("workspace_id", "code");--> statement-breakpoint
CREATE INDEX "fdp_areas_workspace_status_name_idx" ON "fdp_areas" ("workspace_id", "status", "name");--> statement-breakpoint
ALTER TABLE "fdp_areas" ADD CONSTRAINT "fdp_areas_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "fdp_areas" ADD CONSTRAINT "fdp_areas_manager_fk" FOREIGN KEY ("workspace_id", "manager_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id") ON DELETE restrict;--> statement-breakpoint

CREATE TABLE "fdp_area_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"area_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"is_primary" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_area_members_role_check" CHECK ("role" IN ('manager', 'member', 'observer')),
	CONSTRAINT "fdp_area_members_primary_check" CHECK ("is_primary" IN (0, 1))
);--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_area_members_workspace_area_user_uq" ON "fdp_area_members" ("workspace_id", "area_id", "user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_area_members_workspace_user_primary_uq" ON "fdp_area_members" ("workspace_id", "user_id") WHERE "is_primary" = 1;--> statement-breakpoint
CREATE INDEX "fdp_area_members_workspace_user_idx" ON "fdp_area_members" ("workspace_id", "user_id", "area_id");--> statement-breakpoint
ALTER TABLE "fdp_area_members" ADD CONSTRAINT "fdp_area_members_area_fk" FOREIGN KEY ("workspace_id", "area_id") REFERENCES "public"."fdp_areas"("workspace_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "fdp_area_members" ADD CONSTRAINT "fdp_area_members_member_fk" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id") ON DELETE cascade;--> statement-breakpoint

CREATE TABLE "fdp_area_module_assignments" (
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"module_key" text NOT NULL,
	"area_id" text NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_area_module_assignments_pk" PRIMARY KEY ("workspace_id", "module_key")
);--> statement-breakpoint
ALTER TABLE "fdp_area_module_assignments" ADD CONSTRAINT "fdp_area_module_assignments_area_fk" FOREIGN KEY ("workspace_id", "area_id") REFERENCES "public"."fdp_areas"("workspace_id", "id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "fdp_area_module_assignments_workspace_area_idx" ON "fdp_area_module_assignments" ("workspace_id", "area_id");--> statement-breakpoint

ALTER TABLE "fdp_cards" ADD COLUMN "requester_area_id" text;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN "responsible_area_id" text;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_requester_area_fk" FOREIGN KEY ("workspace_id", "requester_area_id") REFERENCES "public"."fdp_areas"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_responsible_area_fk" FOREIGN KEY ("workspace_id", "responsible_area_id") REFERENCES "public"."fdp_areas"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX "fdp_cards_workspace_requester_area_idx" ON "fdp_cards" ("workspace_id", "requester_area_id", "created_at");--> statement-breakpoint
CREATE INDEX "fdp_cards_workspace_responsible_area_idx" ON "fdp_cards" ("workspace_id", "responsible_area_id", "created_at");--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD COLUMN "requester_area_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD COLUMN "responsible_area_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD COLUMN "competence" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD COLUMN "movement_id" text;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_requester_area_fk" FOREIGN KEY ("workspace_id", "requester_area_id") REFERENCES "public"."fdp_areas"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_responsible_area_fk" FOREIGN KEY ("workspace_id", "responsible_area_id") REFERENCES "public"."fdp_areas"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_competence_check" CHECK ("competence" = '' OR "competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');--> statement-breakpoint
ALTER TABLE "fdp_epi_discount_requests" ADD CONSTRAINT "fdp_epi_discounts_movement_fk" FOREIGN KEY ("workspace_id", "movement_id") REFERENCES "public"."fdp_employee_movements"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "fdp_employee_movements" DROP CONSTRAINT IF EXISTS "fdp_employee_movements_type_check";--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_type_check" CHECK ("movement_type" IN ('salary_change', 'vacation', 'leave', 'termination', 'transfer', 'benefit_change', 'registration_sync', 'epi_discount', 'other'));--> statement-breakpoint

-- A projeção legada não aceita escrita direta. A função de saldo serializa por
-- produto, aplica o delta atomicamente e atualiza a projeção no mesmo commit.
CREATE OR REPLACE FUNCTION "fdp_epi_stock_projection_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.stock_quantity <> 0
     AND current_setting('app.stock_projection', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'stock quantity is a derived projection';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity
     AND current_setting('app.stock_projection', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'stock quantity is a derived projection';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "fdp_epi_stock_projection_insert_guard" BEFORE INSERT ON "fdp_epi_products"
FOR EACH ROW EXECUTE FUNCTION "fdp_epi_stock_projection_guard"();--> statement-breakpoint
CREATE TRIGGER "fdp_epi_stock_projection_guard" BEFORE UPDATE OF "stock_quantity" ON "fdp_epi_products"
FOR EACH ROW EXECUTE FUNCTION "fdp_epi_stock_projection_guard"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "fdp_apply_stock_change"(
  p_workspace_id text,
  p_product_id text,
  p_stock_location_id text,
  p_delta integer,
  p_actor_id text
) RETURNS integer AS $$
DECLARE
  v_location_id text;
  v_quantity integer;
BEGIN
  IF p_workspace_id IS NULL OR p_workspace_id = '' OR
     p_workspace_id IS DISTINCT FROM NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'tenant context mismatch' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM fdp_epi_products
    WHERE workspace_id = p_workspace_id AND id = p_product_id
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPI_PRODUCT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  IF COALESCE(p_stock_location_id, '') = '' THEN
    SELECT id INTO v_location_id FROM fdp_stock_locations
      WHERE workspace_id = p_workspace_id AND is_default = 1 AND status = 'active';
  ELSE
    SELECT id INTO v_location_id FROM fdp_stock_locations
      WHERE workspace_id = p_workspace_id AND id = p_stock_location_id AND status = 'active';
  END IF;
  IF v_location_id IS NULL THEN RAISE EXCEPTION 'EPI_STOCK_LOCATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO fdp_stock_balances (workspace_id, product_id, stock_location_id, quantity, version, updated_by)
  VALUES (p_workspace_id, p_product_id, v_location_id, 0, 0, p_actor_id)
  ON CONFLICT (workspace_id, product_id, stock_location_id) DO NOTHING;

  UPDATE fdp_stock_balances
    SET quantity = quantity + p_delta, version = version + 1, updated_by = p_actor_id, updated_at = now()
    WHERE workspace_id = p_workspace_id AND product_id = p_product_id AND stock_location_id = v_location_id
      AND quantity + p_delta >= 0
    RETURNING quantity INTO v_quantity;
  IF v_quantity IS NULL THEN RAISE EXCEPTION 'EPI_INSUFFICIENT_STOCK' USING ERRCODE = 'P0001'; END IF;

  PERFORM set_config('app.stock_projection', 'true', true);
  UPDATE fdp_epi_products p
    SET stock_quantity = (SELECT COALESCE(SUM(b.quantity), 0) FROM fdp_stock_balances b
      WHERE b.workspace_id = p_workspace_id AND b.product_id = p_product_id),
      updated_by = p_actor_id, updated_at = now()
    WHERE p.workspace_id = p_workspace_id AND p.id = p_product_id;
  PERFORM set_config('app.stock_projection', 'false', true);
  RETURN v_quantity;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

ALTER TABLE "fdp_stock_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_stock_locations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_stock_locations_workspace_isolation" ON "fdp_stock_locations" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_stock_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_stock_balances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_stock_balances_workspace_isolation" ON "fdp_stock_balances" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_areas" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_areas_workspace_isolation" ON "fdp_areas" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_area_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_area_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_area_members_workspace_isolation" ON "fdp_area_members" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "fdp_area_module_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_area_module_assignments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_area_module_assignments_workspace_isolation" ON "fdp_area_module_assignments" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
