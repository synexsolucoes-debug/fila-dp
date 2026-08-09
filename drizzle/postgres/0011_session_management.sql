ALTER TABLE "fdp_auth_sessions" ADD COLUMN "device_label" text DEFAULT 'Dispositivo desconhecido' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_auth_sessions" ADD COLUMN "ip_hash" text DEFAULT '' NOT NULL;
