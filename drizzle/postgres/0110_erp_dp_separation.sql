-- O que é ERP fica no ERP (§4.30 de docs/arquitetura-operacional.md).
--
-- Regra do produto: o modo ERP DP e o Vinculato compartilham banco e
-- permissões, mas as telas não se misturam.
SELECT pg_advisory_xact_lock(hashtext('0110_erp_dp_separation'));
--> statement-breakpoint

-- Retroativos saem da Operação DP. Até aqui o alerta de retroatividade do
-- ERP DP (§4.28) entrava em `fdp_operational_pending_items` e aparecia nas
-- Pendências do Vinculato. Ele passa a morar na tabela própria do ERP DP, e
-- as pendências que já existiam são copiadas para cá e dispensadas lá —
-- nada é apagado.
CREATE TABLE "fdp_erp_retroactive_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text,
	-- `movement` quando nasce de uma movimentação aplicada; `erp_action` quando
	-- nasce de uma medida executada no próprio ERP DP.
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"effective_date" date NOT NULL,
	"competence" text NOT NULL,
	"cycle_status" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_erp_retroactive_items_source_check" CHECK ("source_type" IN ('movement', 'erp_action')),
	CONSTRAINT "fdp_erp_retroactive_items_status_check" CHECK ("status" IN ('open', 'posted', 'waived')),
	CONSTRAINT "fdp_erp_retroactive_items_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	-- Fechar um retroativo exige dizer o que foi feito: lançado em qual folha, ou por que dispensado.
	CONSTRAINT "fdp_erp_retroactive_items_resolution_check" CHECK ("status" = 'open' OR length(trim("resolution")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_erp_retroactive_items_workspace_id_uq" ON "fdp_erp_retroactive_items" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- Reaplicar a mesma movimentação não abre um segundo retroativo.
CREATE UNIQUE INDEX "fdp_erp_retroactive_items_source_uq" ON "fdp_erp_retroactive_items" USING btree ("workspace_id", "source_type", "source_id");
--> statement-breakpoint
CREATE INDEX "fdp_erp_retroactive_items_status_idx" ON "fdp_erp_retroactive_items" USING btree ("workspace_id", "status", "created_at");
--> statement-breakpoint
ALTER TABLE "fdp_erp_retroactive_items" ADD CONSTRAINT "fdp_erp_retroactive_items_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_erp_retroactive_items" ADD CONSTRAINT "fdp_erp_retroactive_items_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_erp_retroactive_items" ADD CONSTRAINT "fdp_erp_retroactive_items_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_erp_retroactive_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_erp_retroactive_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_erp_retroactive_items_workspace_isolation" ON "fdp_erp_retroactive_items"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
-- Migra os retroativos que a versão anterior gravou como pendência da Operação DP.
-- Roda como dono da tabela (migração), então a RLS não filtra por workspace aqui.
INSERT INTO "fdp_erp_retroactive_items"
  ("id", "workspace_id", "company_id", "employee_id", "source_type", "source_id", "effective_date", "competence",
   "cycle_status", "title", "status", "resolution", "resolved_at", "created_at", "updated_at")
SELECT p."id", p."workspace_id", p."company_id", m."employee_id", 'movement', p."source_id", m."effective_date",
  to_char(m."effective_date", 'YYYY-MM'), 'closed', p."title",
  CASE WHEN p."status" = 'resolved' THEN 'posted' WHEN p."status" = 'waived' THEN 'waived' ELSE 'open' END,
  CASE WHEN p."status" IN ('resolved', 'waived') THEN COALESCE(NULLIF(trim(p."resolution"), ''), 'Resolvido na Operação DP antes da separação') ELSE '' END,
  p."resolved_at", p."created_at", p."updated_at"
FROM "fdp_operational_pending_items" p
JOIN "fdp_employee_movements" m ON m."workspace_id" = p."workspace_id" AND m."id" = p."source_id"
WHERE p."idempotency_key" LIKE 'retro:%'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "fdp_operational_pending_items"
SET "status" = 'waived', "resolution" = 'Movido para Retroativos do ERP DP', "resolved_at" = COALESCE("resolved_at", now()), "updated_at" = now()
WHERE "idempotency_key" LIKE 'retro:%' AND "status" IN ('open', 'in_progress');
