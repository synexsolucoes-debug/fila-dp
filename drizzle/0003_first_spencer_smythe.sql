CREATE TABLE `demand_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer NOT NULL,
	`uploader_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demand_attachments_object_key_idx` ON `demand_attachments` (`object_key`);--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`sender` text NOT NULL,
	`subject` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`external_id` text,
	`company_id` integer,
	`status` text DEFAULT 'new' NOT NULL,
	`priority_hint` text DEFAULT 'medium' NOT NULL,
	`reviewer_id` integer,
	`demand_id` integer,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_external_id_idx` ON `inbox_items` (`external_id`);--> statement-breakpoint
CREATE TABLE `integration_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'setup_required' NOT NULL,
	`inbound_enabled` integer DEFAULT true NOT NULL,
	`outbound_enabled` integer DEFAULT false NOT NULL,
	`last_sync_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_channels_channel_idx` ON `integration_channels` (`channel`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`demand_id` integer,
	`inbox_item_id` integer,
	`read` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sla_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`business_days` integer DEFAULT 3 NOT NULL,
	`default_priority` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sla_rules_category_idx` ON `sla_rules` (`category`);
--> statement-breakpoint
INSERT INTO `sla_rules` (`category`, `business_days`, `default_priority`) VALUES
  ('Admissão', 5, 'high'), ('Férias', 10, 'medium'), ('Rescisão', 2, 'urgent'),
  ('Ponto', 2, 'medium'), ('Folha', 3, 'high'), ('Benefícios', 5, 'medium'),
  ('Afastamento', 2, 'high'), ('eSocial', 1, 'urgent'), ('Atendimento', 3, 'medium'),
  ('Outros', 5, 'medium');
--> statement-breakpoint
INSERT INTO `integration_channels` (`channel`, `provider`, `status`) VALUES
  ('email', 'Microsoft 365 ou Gmail', 'setup_required'),
  ('teams', 'Microsoft Teams', 'setup_required'),
  ('whatsapp', 'WhatsApp Business', 'setup_required');
