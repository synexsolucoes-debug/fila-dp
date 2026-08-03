CREATE TABLE "fdp_auth_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fdp_auth_rate_limits_updated_idx" ON "fdp_auth_rate_limits" USING btree ("updated_at");
--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" ADD COLUMN "external_id" text;
--> statement-breakpoint
WITH extracted AS (
	SELECT id, workspace_id, channel,
		substring(body FROM '\[external:([^\]]+)\]') AS external_id,
		row_number() OVER (
			PARTITION BY workspace_id, channel, substring(body FROM '\[external:([^\]]+)\]')
			ORDER BY received_at, id
		) AS occurrence
	FROM "fdp_workspace_inbox_items"
	WHERE body LIKE '%[external:%'
)
UPDATE "fdp_workspace_inbox_items" AS inbox
SET "external_id" = extracted.external_id
FROM extracted
WHERE inbox.id = extracted.id AND extracted.occurrence = 1 AND extracted.external_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_inbox_workspace_channel_external_uq" ON "fdp_workspace_inbox_items" USING btree ("workspace_id","channel","external_id");
--> statement-breakpoint
ALTER TABLE "fdp_automation_rules" ADD COLUMN "board_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_automation_rules" ADD CONSTRAINT "fdp_automation_rules_board_id_fdp_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."fdp_boards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
UPDATE "fdp_automation_rules" AS rule
SET "board_id" = (
	SELECT board.id FROM "fdp_boards" AS board
	WHERE board.workspace_id = rule.workspace_id
	ORDER BY board.created_at, board.id
	LIMIT 1
)
WHERE rule.board_id IS NULL;
--> statement-breakpoint
CREATE INDEX "fdp_rules_workspace_board_position_idx" ON "fdp_automation_rules" USING btree ("workspace_id","board_id","position");
--> statement-breakpoint
ALTER TABLE "fdp_boards" ADD COLUMN "process_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN "process_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE "fdp_process_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot_json" text DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_board_id_fdp_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."fdp_boards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_process_versions_board_version_uq" ON "fdp_process_versions" USING btree ("board_id","version");
--> statement-breakpoint
CREATE INDEX "fdp_process_versions_board_created_idx" ON "fdp_process_versions" USING btree ("board_id","created_at");
--> statement-breakpoint
CREATE TABLE "fdp_calendar_credentials" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"encrypted_payload" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fdp_calendar_credentials" ADD CONSTRAINT "fdp_calendar_credentials_connection_id_fdp_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."fdp_calendar_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "fdp_calendar_event_links" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"block_id" text NOT NULL,
	"external_event_id" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fdp_calendar_event_links" ADD CONSTRAINT "fdp_calendar_event_links_connection_id_fdp_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."fdp_calendar_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_calendar_event_links" ADD CONSTRAINT "fdp_calendar_event_links_block_id_fdp_planner_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."fdp_planner_blocks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_calendar_event_links_connection_block_uq" ON "fdp_calendar_event_links" USING btree ("connection_id","block_id");
--> statement-breakpoint
CREATE INDEX "fdp_calendar_event_links_external_idx" ON "fdp_calendar_event_links" USING btree ("connection_id","external_event_id");
