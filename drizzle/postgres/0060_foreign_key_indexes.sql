-- Índices de apoio às chaves estrangeiras com ON DELETE CASCADE (§40, §41).
--
-- O PostgreSQL **não** cria índice para o lado filho de uma chave estrangeira.
-- Sem ele, toda verificação de integridade referencial vira varredura da tabela
-- inteira — e no caso de `ON DELETE CASCADE` isso acontece uma vez por linha
-- apagada. É a diferença entre apagar uma demanda em milissegundos e travar a
-- conexão por segundos.
--
-- ## Medição, não estimativa
--
-- Contra PostgreSQL 16 real, com 20.000 demandas, 120.000 eventos de atividade
-- e 80.000 itens de checklist em um workspace:
--
--   apagar 200 demandas (cascata)    antes: 3.040 ms   depois: 41,7 ms   (73x)
--   checagem em fdp_activity_events  antes: Seq Scan, 9,2 ms
--                                    depois: Bitmap Index Scan, 0,16 ms  (56x)
--
-- A varredura em `fdp_activity_events` era o gargalo: 9 ms por demanda
-- alcançada pela cascata. Com 120.000 eventos ela já custava isso; com o
-- histórico de um ano de operação o custo cresce junto com a tabela, e é por
-- isso que o problema não aparece em ambiente de teste vazio.
--
-- ## Sobre CREATE INDEX CONCURRENTLY
--
-- Ele **não** é usado aqui, e a razão é concreta e verificada: o executor de
-- migrations deste projeto (`scripts/migrate.mjs`) aplica cada arquivo dentro
-- de uma única transação, com advisory lock, e `CREATE INDEX CONCURRENTLY` é
-- proibido dentro de bloco transacional pelo PostgreSQL. Colocá-lo aqui faria a
-- migration falhar no deploy, não rodar mais rápido.
--
-- A alternativa seria abrir uma exceção no executor para este arquivo — e §70 é
-- explícito: não se hackeia o executor por causa de uma migration. Se algum dia
-- o volume exigir índice online, o caminho é um mecanismo declarado e testado
-- para isso, não uma exceção pontual.
--
-- O custo aceito: cada `CREATE INDEX` toma `SHARE` na tabela, bloqueando
-- escrita enquanto constrói. Nas tabelas deste volume isso é da ordem de
-- centenas de milissegundos por índice, dentro da janela de deploy.
--
-- Todos os 55 índices cobrem as 71 chaves estrangeiras com CASCADE que estavam
-- sem apoio. Quando duas chaves da mesma tabela compartilham colunas, um índice
-- só atende as duas: a verificação é por igualdade em todas as colunas, e nesse
-- caso a ordem dentro do índice não importa.
SELECT pg_advisory_xact_lock(hashtext('0060_foreign_key_indexes'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fdp_activity_events_card_id_workspace_id_fkidx" ON "fdp_activity_events" USING btree ("card_id", "workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_assistant_conversations_user_id_fkidx" ON "fdp_assistant_conversations" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_assistant_messages_conversation_id_fkidx" ON "fdp_assistant_messages" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_auxiliary_approval_steps_execution_ws_revision_fkidx" ON "fdp_auxiliary_approval_steps" USING btree ("execution_id", "workspace_id", "revision_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_auxiliary_approval_steps_workspace_id_revision_id_fkidx" ON "fdp_auxiliary_approval_steps" USING btree ("workspace_id", "revision_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_billing_invoices_workspace_id_subscription_id_fkidx" ON "fdp_billing_invoices" USING btree ("workspace_id", "subscription_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_calendar_connections_workspace_id_user_id_fkidx" ON "fdp_calendar_connections" USING btree ("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_assignees_user_id_workspace_id_fkidx" ON "fdp_card_assignees" USING btree ("user_id", "workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_assignees_workspace_id_card_id_fkidx" ON "fdp_card_assignees" USING btree ("workspace_id", "card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_attachments_workspace_id_card_id_fkidx" ON "fdp_card_attachments" USING btree ("workspace_id", "card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_comments_workspace_id_card_id_fkidx" ON "fdp_card_comments" USING btree ("workspace_id", "card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_labels_label_id_workspace_id_fkidx" ON "fdp_card_labels" USING btree ("label_id", "workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_labels_workspace_id_card_id_fkidx" ON "fdp_card_labels" USING btree ("workspace_id", "card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_sla_pauses_workspace_id_card_id_fkidx" ON "fdp_card_sla_pauses" USING btree ("workspace_id", "card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_checklist_items_workspace_id_card_id_fkidx" ON "fdp_checklist_items" USING btree ("workspace_id", "card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_fixed_items_provider_id_fkidx" ON "fdp_contractor_fixed_items" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_contractor_movements_provider_id_fkidx" ON "fdp_contractor_movements" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_custom_field_values_field_id_workspace_id_fkidx" ON "fdp_custom_field_values" USING btree ("field_id", "workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_custom_field_values_workspace_id_card_id_fkidx" ON "fdp_custom_field_values" USING btree ("workspace_id", "card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_employee_sync_changes_workspace_id_external_ref_id_fkidx" ON "fdp_employee_sync_changes" USING btree ("workspace_id", "external_ref_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_employee_sync_changes_ws_integration_run_fkidx" ON "fdp_employee_sync_changes" USING btree ("workspace_id", "integration_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_epi_attachments_workspace_id_company_id_fkidx" ON "fdp_epi_attachments" USING btree ("workspace_id", "company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_hour_event_mappings_company_id_fkidx" ON "fdp_hour_event_mappings" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_hr_metrics_company_id_fkidx" ON "fdp_hr_metrics" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_credentials_integration_id_fkidx" ON "fdp_integration_credentials" USING btree ("integration_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_diagnostics_ws_integration_run_fkidx" ON "fdp_integration_diagnostics" USING btree ("workspace_id", "integration_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_jobs_integration_id_workspace_id_run_id_fkidx" ON "fdp_integration_jobs" USING btree ("integration_id", "workspace_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_jobs_run_id_fkidx" ON "fdp_integration_jobs" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_reconciliations_integration_ws_run_fkidx" ON "fdp_integration_reconciliations" USING btree ("integration_id", "workspace_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_reconciliations_run_id_fkidx" ON "fdp_integration_reconciliations" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_reconciliations_workspace_id_item_id_fkidx" ON "fdp_integration_reconciliations" USING btree ("workspace_id", "item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_run_logs_integration_ws_run_fkidx" ON "fdp_integration_run_logs" USING btree ("integration_id", "workspace_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_sync_items_integration_ws_run_fkidx" ON "fdp_integration_sync_items" USING btree ("integration_id", "workspace_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_sync_runs_integration_id_fkidx" ON "fdp_integration_sync_runs" USING btree ("integration_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_member_company_access_user_id_fkidx" ON "fdp_member_company_access" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_member_company_access_company_id_workspace_id_fkidx" ON "fdp_member_company_access" USING btree ("company_id", "workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_member_module_grants_module_key_fkidx" ON "fdp_member_module_grants" USING btree ("module_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_member_module_grants_user_id_fkidx" ON "fdp_member_module_grants" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_movement_approval_steps_workspace_id_movement_id_fkidx" ON "fdp_movement_approval_steps" USING btree ("workspace_id", "movement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_movement_suggestions_event_id_fkidx" ON "fdp_movement_suggestions" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_movement_suggestions_workspace_id_integration_id_fkidx" ON "fdp_movement_suggestions" USING btree ("workspace_id", "integration_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_notifications_workspace_id_user_id_fkidx" ON "fdp_notifications" USING btree ("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_notifications_card_id_fkidx" ON "fdp_notifications" USING btree ("card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_payroll_cycle_items_ws_company_payroll_cycle_fkidx" ON "fdp_payroll_cycle_items" USING btree ("workspace_id", "company_id", "payroll_cycle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_planner_blocks_workspace_id_user_id_fkidx" ON "fdp_planner_blocks" USING btree ("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_psychology_adjustments_closing_id_fkidx" ON "fdp_psychology_adjustments" USING btree ("closing_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_tangerino_admission_consultations_ws_integration_fkidx" ON "fdp_tangerino_admission_consultations" USING btree ("workspace_id", "integration_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_tangerino_admission_consultations_ws_company_fkidx" ON "fdp_tangerino_admission_consultations" USING btree ("workspace_id", "company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_time_entries_time_sheet_id_fkidx" ON "fdp_time_entries" USING btree ("time_sheet_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_time_inconsistencies_time_sheet_id_fkidx" ON "fdp_time_inconsistencies" USING btree ("time_sheet_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_time_sheet_events_time_sheet_id_fkidx" ON "fdp_time_sheet_events" USING btree ("time_sheet_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_webhook_deliveries_event_id_workspace_id_fkidx" ON "fdp_webhook_deliveries" USING btree ("event_id", "workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_webhook_deliveries_endpoint_id_fkidx" ON "fdp_webhook_deliveries" USING btree ("endpoint_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_workspace_members_user_id_fkidx" ON "fdp_workspace_members" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_workspace_module_grants_module_key_fkidx" ON "fdp_workspace_module_grants" USING btree ("module_key");