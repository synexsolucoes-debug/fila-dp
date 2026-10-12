-- ERP DP, passo 2: o retorno de afastamento vira medida.
--
-- Até aqui só existia o caminho de ida: `leave` levava o colaborador para
-- "afastado", e voltar a "ativo" era editar o cadastro, com a data de hoje e
-- sem aprovação. No SAP HCM o retorno é o fim do afastamento (IT2001) e, se o
-- vínculo estava suspenso, uma medida própria — com data, motivo e o evento
-- S-2230 de término (docs/engenharia-reversa-sap-hcm.md §13.3).
--
-- `return_to_work` entra no vocabulário da movimentação e no motivo do
-- histórico funcional. Os CHECKs são recriados com a lista nova: nenhuma linha
-- existente muda.
SELECT pg_advisory_xact_lock(hashtext('0108_erp_dp_return_to_work'));
--> statement-breakpoint

ALTER TABLE "fdp_employee_movements" DROP CONSTRAINT IF EXISTS "fdp_employee_movements_type_check";
--> statement-breakpoint
ALTER TABLE "fdp_employee_movements" ADD CONSTRAINT "fdp_employee_movements_type_check"
  CHECK ("movement_type" IN ('salary_change', 'vacation', 'leave', 'return_to_work', 'termination', 'transfer', 'benefit_change', 'registration_sync', 'epi_discount', 'other'));
--> statement-breakpoint

ALTER TABLE "fdp_employee_history_records" DROP CONSTRAINT IF EXISTS "fdp_employee_history_records_reason_check";
--> statement-breakpoint
ALTER TABLE "fdp_employee_history_records" ADD CONSTRAINT "fdp_employee_history_records_reason_check"
  CHECK ("reason" IN ('baseline', 'leave', 'return_to_work', 'termination', 'transfer', 'registration_edit'));
