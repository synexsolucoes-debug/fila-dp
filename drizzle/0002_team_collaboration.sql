CREATE TABLE IF NOT EXISTS `fdp_user_workspace_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`active_workspace_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `fdp_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_workspace_id`) REFERENCES `fdp_workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_card_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `fdp_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `fdp_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_comments_card_created_idx` ON `fdp_card_comments` (`card_id`,`created_at`);
