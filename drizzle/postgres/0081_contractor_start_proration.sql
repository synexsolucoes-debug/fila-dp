-- O proporcional PJ novo usa convenção comercial de 30 dias. O fim da
-- vigência é opcional porque o contrato pode começar dentro da competência e
-- continuar ativo. Registros históricos em calendário (28 a 31 dias) são
-- mantidos válidos apenas quando preservam a data de encerramento.
ALTER TABLE "fdp_contractor_closings"
  DROP CONSTRAINT IF EXISTS "fdp_contractor_closings_proration_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD CONSTRAINT "fdp_contractor_closings_proration_check"
  CHECK (
    ("proration_days" IS NULL AND "proration_total_days" IS NULL AND "proration_end_date" IS NULL)
    OR (
      "proration_days" BETWEEN 1 AND "proration_total_days"
      AND "proration_total_days" BETWEEN 28 AND 31
      AND ("proration_total_days" = 30 OR "proration_end_date" IS NOT NULL)
    )
  );
