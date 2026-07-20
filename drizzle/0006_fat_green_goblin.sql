CREATE INDEX `demand_attachments_demand_created_idx` ON `demand_attachments` (`demand_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `demand_checklists_demand_order_idx` ON `demand_checklists` (`demand_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `demand_comments_demand_created_idx` ON `demand_comments` (`demand_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `demand_history_demand_created_idx` ON `demand_history` (`demand_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `demands_queue_idx` ON `demands` (`deleted_at`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `demands_assignee_idx` ON `demands` (`assignee_email`,`status`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `demands_due_date_idx` ON `demands` (`due_date`,`status`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `demands_company_idx` ON `demands` (`company_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `inbox_status_received_idx` ON `inbox_items` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `notifications_user_read_created_idx` ON `notifications` (`user_id`,`read`,`created_at`);--> statement-breakpoint
CREATE INDEX `user_history_target_created_idx` ON `user_history` (`target_user_id`,`created_at`);