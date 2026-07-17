CREATE TABLE `user_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_user_id` integer NOT NULL,
	`actor_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`field_changed` text,
	`old_value` text,
	`new_value` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `demand_history` ADD `user_id` integer;--> statement-breakpoint
ALTER TABLE `demand_history` ADD `field_changed` text;--> statement-breakpoint
ALTER TABLE `demand_history` ADD `old_value` text;--> statement-breakpoint
ALTER TABLE `demand_history` ADD `new_value` text;--> statement-breakpoint
ALTER TABLE `demand_history` ADD `justification` text;--> statement-breakpoint
ALTER TABLE `demands` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `demands` ADD `updated_by_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `created_by_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `updated_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_access_at` text;
