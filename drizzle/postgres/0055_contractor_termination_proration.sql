ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN "contract_base_amount" numeric(18, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN "proration_days" integer;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN "proration_total_days" integer;--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN "proration_end_date" date;--> statement-breakpoint

UPDATE "fdp_contractor_closings"
  SET "contract_base_amount" = "base_amount";--> statement-breakpoint

ALTER TABLE "fdp_contractor_closings"
  ADD CONSTRAINT "fdp_contractor_closings_proration_check"
  CHECK (
    ("proration_days" IS NULL AND "proration_total_days" IS NULL AND "proration_end_date" IS NULL)
    OR (
      "proration_days" BETWEEN 1 AND "proration_total_days"
      AND "proration_total_days" BETWEEN 28 AND 31
      AND "proration_end_date" IS NOT NULL
    )
  );
