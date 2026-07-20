ALTER TABLE `fdp_cards` ADD COLUMN `sla_target_minutes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `fdp_cards` ADD COLUMN `sla_started_at` text;
--> statement-breakpoint
ALTER TABLE `fdp_cards` ADD COLUMN `sla_paused_minutes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `fdp_cards` ADD COLUMN `sla_pause_reason` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `fdp_cards` ADD COLUMN `sla_escalation_level` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_card_sla_pauses` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `card_id` text NOT NULL,
  `started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `ended_at` text,
  `reason` text NOT NULL,
  `created_by` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_card_sla_pause_open_idx` ON `fdp_card_sla_pauses` (`card_id`,`ended_at`);
