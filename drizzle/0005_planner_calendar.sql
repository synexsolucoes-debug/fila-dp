CREATE TABLE IF NOT EXISTS `fdp_planner_blocks` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `user_id` text NOT NULL,
  `card_id` text,
  `title` text NOT NULL,
  `start_at` text NOT NULL,
  `end_at` text NOT NULL,
  `block_type` text DEFAULT 'focus' NOT NULL,
  `notes` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `fdp_users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_planner_user_start_idx` ON `fdp_planner_blocks` (`user_id`,`start_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_calendar_connections` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `user_id` text NOT NULL,
  `provider` text NOT NULL,
  `status` text DEFAULT 'needs_credentials' NOT NULL,
  `config_json` text DEFAULT '{}' NOT NULL,
  `external_calendar_id` text,
  `last_sync_at` text,
  `last_error` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `fdp_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_calendar_connections_user_provider_uq` ON `fdp_calendar_connections` (`user_id`,`provider`);
