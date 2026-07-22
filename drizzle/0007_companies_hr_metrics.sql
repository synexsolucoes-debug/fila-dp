CREATE TABLE IF NOT EXISTS `fdp_companies` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `fdp_workspaces`(`id`) ON DELETE cascade,
  `legal_name` text NOT NULL,
  `trade_name` text DEFAULT '' NOT NULL,
  `tax_id` text DEFAULT '' NOT NULL,
  `external_code` text DEFAULT '' NOT NULL,
  `email` text DEFAULT '' NOT NULL,
  `phone` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_companies_workspace_name_idx` ON `fdp_companies` (`workspace_id`, `legal_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_companies_workspace_tax_idx` ON `fdp_companies` (`workspace_id`, `tax_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fdp_hr_metrics` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `fdp_workspaces`(`id`) ON DELETE cascade,
  `company_id` text NOT NULL REFERENCES `fdp_companies`(`id`) ON DELETE cascade,
  `period` text NOT NULL,
  `headcount` integer DEFAULT 0 NOT NULL,
  `admissions` integer DEFAULT 0 NOT NULL,
  `terminations` integer DEFAULT 0 NOT NULL,
  `payroll_cost` real DEFAULT 0 NOT NULL,
  `source` text DEFAULT 'manual' NOT NULL,
  `external_id` text DEFAULT '' NOT NULL,
  `notes` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE(`workspace_id`, `company_id`, `period`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fdp_hr_metrics_workspace_period_idx` ON `fdp_hr_metrics` (`workspace_id`, `period`);
