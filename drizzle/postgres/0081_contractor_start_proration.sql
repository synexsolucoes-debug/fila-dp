-- O proporcional PJ usa convenção comercial de 30 dias. O fim da vigência é
-- opcional porque o contrato pode começar dentro da competência e continuar
-- ativo, caso em que não há uma data final a registrar.
ALTER TABLE "fdp_contractor_closings"
  DROP CONSTRAINT IF EXISTS "fdp_contractor_closings_proration_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD CONSTRAINT "fdp_contractor_closings_proration_check"
  CHECK (
    ("proration_days" IS NULL AND "proration_total_days" IS NULL AND "proration_end_date" IS NULL)
    OR (
      "proration_days" BETWEEN 1 AND "proration_total_days"
      AND "proration_total_days" = 30
    )
  );
