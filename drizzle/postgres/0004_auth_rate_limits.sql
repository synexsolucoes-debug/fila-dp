CREATE TABLE "fdp_auth_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fdp_auth_rate_limits_blocked_idx" ON "fdp_auth_rate_limits" USING btree ("blocked_until");
