CREATE TABLE IF NOT EXISTS `fdp_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`position` real NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_labels_workspace_name_uq` ON `fdp_labels` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_card_labels` (
	`card_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`card_id`, `label_id`),
	FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `fdp_labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_card_assignees` (
	`card_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`card_id`, `user_id`),
	FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `fdp_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_custom_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`field_key` text NOT NULL,
	`field_type` text DEFAULT 'text' NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`position` real NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_custom_fields_workspace_key_uq` ON `fdp_custom_fields` (`workspace_id`,`field_key`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_custom_field_values` (
	`card_id` text NOT NULL,
	`field_id` text NOT NULL,
	`value_text` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`card_id`, `field_id`),
	FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fdp_custom_fields`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_card_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_attachments_object_key_uq` ON `fdp_card_attachments` (`object_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_attachments_card_created_idx` ON `fdp_card_attachments` (`card_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_process_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`process_type` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`checklist_json` text DEFAULT '[]' NOT NULL,
	`default_sla_days` integer DEFAULT 3 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`position` real NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_templates_workspace_name_uq` ON `fdp_process_templates` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_workspace_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`business_days_json` text DEFAULT '[1,2,3,4,5]' NOT NULL,
	`day_start` text DEFAULT '08:00' NOT NULL,
	`day_end` text DEFAULT '18:00' NOT NULL,
	`realtime_seconds` integer DEFAULT 30 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_business_holidays` (
	`workspace_id` text NOT NULL,
	`holiday_date` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `holiday_date`),
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_sla_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`process_type` text NOT NULL,
	`target_business_days` integer DEFAULT 3 NOT NULL,
	`warning_business_days` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_sla_policies_workspace_process_uq` ON `fdp_sla_policies` (`workspace_id`,`process_type`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`event_key` text NOT NULL,
	`notification_type` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`card_id` text,
	`read_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `fdp_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_notifications_user_event_uq` ON `fdp_notifications` (`user_id`,`event_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_notifications_user_read_created_idx` ON `fdp_notifications` (`user_id`,`read_at`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'needs_credentials' NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`last_sync_at` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fdp_integrations_workspace_channel_uq` ON `fdp_integrations` (`workspace_id`,`channel`);
