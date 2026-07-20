CREATE TABLE IF NOT EXISTS `fdp_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_users_email_uq` ON `fdp_users` (`email`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`timezone` text DEFAULT 'America/Sao_Paulo' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `fdp_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_workspaces_owner_uq` ON `fdp_workspaces` (`owner_user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_workspaces_slug_uq` ON `fdp_workspaces` (`slug`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `fdp_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`board_type` text DEFAULT 'general' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_boards_workspace_name_uq` ON `fdp_boards` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`position` real NOT NULL,
	`sla_behavior` text DEFAULT 'running' NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `fdp_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_lists_board_kind_uq` ON `fdp_lists` (`board_id`,`kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_lists_board_position_idx` ON `fdp_lists` (`board_id`,`position`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`list_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`process_type` text DEFAULT 'OUTROS' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee_name` text DEFAULT '' NOT NULL,
	`due_at` text,
	`sla_status` text DEFAULT 'safe' NOT NULL,
	`position` real NOT NULL,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `fdp_boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `fdp_lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_cards_board_list_position_idx` ON `fdp_cards` (`board_id`,`list_id`,`position`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_cards_due_status_idx` ON `fdp_cards` (`due_at`,`sla_status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`title` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`position` real NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_checklist_card_position_idx` ON `fdp_checklist_items` (`card_id`,`position`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_workspace_inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel` text DEFAULT 'manual' NOT NULL,
	`sender_name` text NOT NULL,
	`subject` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`converted_card_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`converted_card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_inbox_workspace_status_received_idx` ON `fdp_workspace_inbox_items` (`workspace_id`,`status`,`received_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`condition_json` text DEFAULT '{}' NOT NULL,
	`action_json` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` real NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_rules_workspace_position_idx` ON `fdp_automation_rules` (`workspace_id`,`position`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`card_id` text,
	`actor_email` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_activity_workspace_created_idx` ON `fdp_activity_events` (`workspace_id`,`created_at`);
