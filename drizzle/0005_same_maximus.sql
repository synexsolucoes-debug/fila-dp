ALTER TABLE `demands` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `demands` ADD `deleted_by_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `demands` ADD `deletion_reason` text;