CREATE TABLE `integration_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`encrypted_config` text NOT NULL,
	`iv` text NOT NULL,
	`updated_by_id` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_credentials_channel_idx` ON `integration_credentials` (`channel`);