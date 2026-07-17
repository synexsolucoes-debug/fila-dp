CREATE TABLE `checklist_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`item_text` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checklist_templates_item_idx` ON `checklist_templates` (`category`,`item_text`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`legal_name` text NOT NULL,
	`trade_name` text NOT NULL,
	`cnpj` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_cnpj_idx` ON `companies` (`cnpj`);--> statement-breakpoint
CREATE UNIQUE INDEX `companies_trade_name_idx` ON `companies` (`trade_name`);--> statement-breakpoint
CREATE TABLE `demand_checklists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer NOT NULL,
	`item_text` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`completed_by_id` integer,
	`completed_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`completed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `demand_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`text` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `demand_labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	`assigned_by_id` integer,
	`assigned_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demand_labels_pair_idx` ON `demand_labels` (`demand_id`,`label_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name_idx` ON `labels` (`name`);--> statement-breakpoint
ALTER TABLE `demands` ADD `company_id` integer REFERENCES companies(id);
--> statement-breakpoint
INSERT OR IGNORE INTO `companies` (`legal_name`, `trade_name`)
SELECT DISTINCT `company`, `company` FROM `demands` WHERE trim(`company`) <> '';
--> statement-breakpoint
UPDATE `demands`
SET `company_id` = (SELECT `id` FROM `companies` WHERE `trade_name` = `demands`.`company` LIMIT 1)
WHERE `company_id` IS NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `labels` (`name`, `color`) VALUES
  ('Risco de Multa', '#dc3f45'),
  ('Falta Assinatura', '#d99018'),
  ('Depende do Financeiro', '#3478b8'),
  ('Aguardando ASO', '#7759b8');
--> statement-breakpoint
INSERT OR IGNORE INTO `checklist_templates` (`category`, `item_text`, `sort_order`) VALUES
  ('Admissão', 'Receber e conferir documentos', 1),
  ('Admissão', 'Validar exame admissional e ASO', 2),
  ('Admissão', 'Gerar contrato de trabalho', 3),
  ('Admissão', 'Cadastrar no sistema e no eSocial', 4),
  ('Admissão', 'Solicitar acessos e e-mail corporativo', 5),
  ('Férias', 'Conferir período aquisitivo e saldo', 1),
  ('Férias', 'Validar datas com o gestor', 2),
  ('Férias', 'Emitir aviso e recibo de férias', 3),
  ('Férias', 'Processar pagamento', 4),
  ('Férias', 'Coletar assinatura e arquivar', 5),
  ('Rescisão', 'Receber dados do desligamento', 1),
  ('Rescisão', 'Calcular e conferir verbas rescisórias', 2),
  ('Rescisão', 'Preparar documentos e guias', 3),
  ('Rescisão', 'Transmitir evento ao eSocial', 4),
  ('Rescisão', 'Confirmar pagamento e assinatura', 5),
  ('eSocial', 'Validar dados e documentos de origem', 1),
  ('eSocial', 'Conferir prazo legal do evento', 2),
  ('eSocial', 'Transmitir evento', 3),
  ('eSocial', 'Conferir recibo de processamento', 4);
--> statement-breakpoint
INSERT INTO `demand_checklists` (`demand_id`, `item_text`, `sort_order`)
SELECT d.`id`, t.`item_text`, t.`sort_order`
FROM `demands` d
JOIN `checklist_templates` t ON t.`category` = d.`category` AND t.`status` = 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM `demand_checklists` dc
  WHERE dc.`demand_id` = d.`id` AND dc.`item_text` = t.`item_text`
);
