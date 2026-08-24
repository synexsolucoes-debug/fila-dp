ALTER TABLE "fdp_contractor_profiles"
  ADD COLUMN "fixed_caju_difference" numeric(18,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_profiles"
  ADD CONSTRAINT "fdp_contractor_profiles_fixed_caju_difference_check"
  CHECK ("fixed_caju_difference" >= 0);
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN "fixed_caju_amount" numeric(18,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD CONSTRAINT "fdp_contractor_closings_fixed_caju_amount_check"
  CHECK ("fixed_caju_amount" >= 0);
