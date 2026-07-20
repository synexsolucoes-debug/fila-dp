ALTER TABLE `fdp_user_workspace_preferences` ADD COLUMN `active_board_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_preferences_active_board_idx` ON `fdp_user_workspace_preferences` (`active_board_id`);
