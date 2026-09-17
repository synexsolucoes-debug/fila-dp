-- Ensaio de Adiantamentos e Descontos (migration 0085) contra PostgreSQL real.
--
-- Verifica o que teste de unidade não alcança, porque não é aritmética: são
-- triggers, índices únicos e locks.
--
--  * o saldo da parcela sai das confirmações e nunca é digitado;
--  * confirmação e histórico são append-only — corrigir é estornar;
--  * desconto acima do saldo só passa como override autorizado e justificado;
--  * parcela já confirmada não é reprogramada nem tem o valor alterado;
--  * lote fechado é imutável e reabrir exige justificativa;
--  * uma solicitação aprovada origina um único lançamento;
--  * duas confirmações simultâneas da mesma parcela não dobram a baixa;
--  * o isolamento entre workspaces vale para um papel sem superusuário.
--
-- Roda depois de payments-db-rehearsal.sql e reaproveita a semente daquele
-- ensaio (ws-a, ws-b, co-a, emp-a, cy-a, pj-a, u1).
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION expect_error(stmt text, fragment text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    IF position(fragment in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'esperava erro contendo "%", veio "%"', fragment, SQLERRM;
    END IF;
    RAISE NOTICE 'OK bloqueado: %', fragment;
    RETURN;
  END;
  RAISE EXCEPTION 'esperava falha (%), mas o comando foi aceito', fragment;
END;
$$;

SELECT set_config('app.workspace_id', 'ws-a', false);

-- ---------------------------------------------------------------------------
-- Semente: um empréstimo de R$ 1.000,00 em 3x a partir de 08/2026.
-- As parcelas são 333,34 + 333,33 + 333,33 — a divisão que a planilha errava.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence,
  status, created_by, updated_by)
  VALUES ('led-1','ws-a','co-a','emp-a','loan','Emprestimo de ensaio','2026-07-20','u1',
    1000.00,'installments',3,'2026-08','active','u1','u1');
INSERT INTO fdp_ledger_installments (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount) VALUES
  ('led-1-p1','ws-a','led-1','co-a',1,3,'2026-08',333.34),
  ('led-1-p2','ws-a','led-1','co-a',2,3,'2026-09',333.33),
  ('led-1-p3','ws-a','led-1','co-a',3,3,'2026-10',333.33);

DO $$
DECLARE soma numeric(18,2);
BEGIN
  SELECT SUM(planned_amount) INTO soma FROM fdp_ledger_installments WHERE entry_id = 'led-1';
  IF soma <> 1000.00 THEN
    RAISE EXCEPTION 'a soma das parcelas (%) nao fecha com o total', soma;
  END IF;
  RAISE NOTICE 'OK: as parcelas somam exatamente o total';
END;
$$;

-- ---------------------------------------------------------------------------
-- A competência passar não desconta nada.
-- ---------------------------------------------------------------------------
DO $$
DECLARE descontado numeric(18,2); situacao text;
BEGIN
  SELECT discounted_amount, status INTO descontado, situacao
    FROM fdp_ledger_installments WHERE id = 'led-1-p1';
  IF descontado <> 0 OR situacao <> 'scheduled' THEN
    RAISE EXCEPTION 'parcela de competencia passada nasceu baixada: % / %', descontado, situacao;
  END IF;
  RAISE NOTICE 'OK: competencia vencida nao baixa parcela';
END;
$$;

-- ---------------------------------------------------------------------------
-- Desconto parcial: o saldo fica visível e não é recobrado sozinho.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, confirmed_by, idempotency_key)
  VALUES ('led-c1','ws-a','led-1-p1','led-1','2026-08',150.00,'u1','ledger-confirm:led-1-p1:2026-08:15000:confirmation:');

DO $$
DECLARE parcela RECORD;
BEGIN
  SELECT * INTO parcela FROM fdp_ledger_installments WHERE id = 'led-1-p1';
  IF parcela.discounted_amount <> 150.00 OR parcela.status <> 'partially_discounted' THEN
    RAISE EXCEPTION 'desconto parcial nao refletiu: % / %', parcela.discounted_amount, parcela.status;
  END IF;
  IF parcela.planned_amount - parcela.discounted_amount <> 183.34 THEN
    RAISE EXCEPTION 'saldo da parcela errado: %', parcela.planned_amount - parcela.discounted_amount;
  END IF;
  RAISE NOTICE 'OK: desconto parcial deixa saldo de 183,34 visivel';
END;
$$;

-- A parcela seguinte continua intacta: o que faltou não é empurrado para frente.
DO $$
DECLARE previsto numeric(18,2);
BEGIN
  SELECT planned_amount INTO previsto FROM fdp_ledger_installments WHERE id = 'led-1-p2';
  IF previsto <> 333.33 THEN
    RAISE EXCEPTION 'a diferenca foi recobrada sozinha na parcela seguinte: %', previsto;
  END IF;
  RAISE NOTICE 'OK: a diferenca nao e recobrada automaticamente';
END;
$$;

-- ---------------------------------------------------------------------------
-- Desconto acima do saldo e estorno excessivo.
-- ---------------------------------------------------------------------------
SELECT expect_error($$INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, confirmed_by, idempotency_key)
  VALUES ('led-c2','ws-a','led-1-p1','led-1','2026-08',500.00,'u1','k-excesso')$$,
  'exceeds the installment balance');

SELECT expect_error($$INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, kind, confirmed_by, idempotency_key)
  VALUES ('led-c3','ws-a','led-1-p1','led-1','2026-08',500.00,'authorized_override','u1','k-sem-motivo')$$,
  'fdp_ledger_confirmations_justification_check');

-- Com justificativa, o override passa — é o "ajuste explicitamente autorizado".
INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, kind, justification, confirmed_by, idempotency_key)
  VALUES ('led-c4','ws-a','led-1-p1','led-1','2026-08',500.00,'authorized_override','Acordo assinado, autorizado pela diretoria','u1','k-override');

SELECT expect_error($$INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, kind, justification, confirmed_by, idempotency_key)
  VALUES ('led-c5','ws-a','led-1-p1','led-1','2026-08',-900.00,'reversal','Estorno maior que o confirmado','u1','k-estorno-demais')$$,
  'reversal exceeds the confirmed amount');

-- ---------------------------------------------------------------------------
-- Estorno rastreável: corrige sem apagar.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, kind, justification, reverses_confirmation_id, confirmed_by, idempotency_key)
  VALUES ('led-c6','ws-a','led-1-p1','led-1','2026-08',-500.00,'reversal','Override lancado por engano','led-c4','u1','k-estorno');

DO $$
DECLARE parcela RECORD; linhas int;
BEGIN
  SELECT * INTO parcela FROM fdp_ledger_installments WHERE id = 'led-1-p1';
  IF parcela.discounted_amount <> 150.00 OR parcela.status <> 'partially_discounted' THEN
    RAISE EXCEPTION 'estorno nao devolveu o saldo: % / %', parcela.discounted_amount, parcela.status;
  END IF;
  SELECT count(*) INTO linhas FROM fdp_ledger_confirmations WHERE installment_id = 'led-1-p1';
  IF linhas <> 3 THEN
    RAISE EXCEPTION 'o historico deveria ter 3 linhas, tem %', linhas;
  END IF;
  RAISE NOTICE 'OK: estorno devolve o saldo e as 3 linhas do historico permanecem';
END;
$$;

SELECT expect_error($$UPDATE fdp_ledger_confirmations SET amount = 1.00 WHERE id = 'led-c1'$$, 'append-only');
SELECT expect_error($$DELETE FROM fdp_ledger_confirmations WHERE id = 'led-c1'$$, 'append-only');

-- ---------------------------------------------------------------------------
-- Dois usuários confirmando ao mesmo tempo: a chave determinística barra a
-- segunda gravação antes mesmo do trigger.
-- ---------------------------------------------------------------------------
SELECT expect_error($$INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, confirmed_by, idempotency_key)
  VALUES ('led-c7','ws-a','led-1-p2','led-1','2026-09',150.00,'u1','ledger-confirm:led-1-p1:2026-08:15000:confirmation:')$$,
  'fdp_ledger_confirmations_idempotency_uq');

-- ---------------------------------------------------------------------------
-- Parcela confirmada é preservada.
-- ---------------------------------------------------------------------------
SELECT expect_error($$UPDATE fdp_ledger_installments SET status = 'rescheduled' WHERE id = 'led-1-p1'$$,
  'confirmed installment cannot be canceled, skipped or rescheduled');
SELECT expect_error($$UPDATE fdp_ledger_installments SET planned_amount = 10.00 WHERE id = 'led-1-p1'$$,
  'confirmed installment is immutable');
SELECT expect_error($$DELETE FROM fdp_ledger_installments WHERE id = 'led-1-p1'$$,
  'confirmed installment cannot be deleted');

-- Parcela ainda não confirmada continua reprogramável: é o caso legítimo.
UPDATE fdp_ledger_installments SET status = 'rescheduled', rescheduled_to_competence = '2026-12' WHERE id = 'led-1-p3';

-- ---------------------------------------------------------------------------
-- Modalidade: recorrente sem prazo não carrega saldo devedor total.
-- ---------------------------------------------------------------------------
SELECT expect_error($$INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, total_amount, modality, first_competence, created_by, updated_by)
  VALUES ('led-2','ws-a','co-a','emp-a','salary_advance','Vale fixo','2026-07-20','u1',5000.00,'recurring','2026-08','u1','u1')$$,
  'fdp_ledger_entries_modality_shape_check');

INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, modality, first_competence, status, created_by, updated_by)
  VALUES ('led-2','ws-a','co-a','emp-a','salary_advance','Vale fixo mensal','2026-07-20','u1','recurring','2026-08','active','u1','u1');

-- ---------------------------------------------------------------------------
-- Sujeito e destino de liquidação.
-- ---------------------------------------------------------------------------
SELECT expect_error($$INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence, created_by, updated_by)
  VALUES ('led-3','ws-a','co-a','loan','Sem sujeito','2026-07-20','u1',100.00,'single',1,'2026-08','u1','u1')$$,
  'fdp_ledger_entries_subject_check');

SELECT expect_error($$INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence, settlement_target, created_by, updated_by)
  VALUES ('led-4','ws-a','co-a','emp-a','loan','Destino errado','2026-07-20','u1',100.00,'single',1,'2026-08','contractor_payment','u1','u1')$$,
  'fdp_ledger_entries_target_subject_check');

-- O lançamento PJ aponta para o prestador e liquida no fechamento PJ.
INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, provider_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence,
  settlement_target, status, created_by, updated_by)
  VALUES ('led-pj','ws-a','co-a','pj-a','loan','Emprestimo ao prestador','2026-07-20','u1',
    600.00,'installments',2,'2026-08','contractor_payment','active','u1','u1');
INSERT INTO fdp_ledger_installments (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount) VALUES
  ('led-pj-p1','ws-a','led-pj','co-a',1,2,'2026-08',300.00),
  ('led-pj-p2','ws-a','led-pj','co-a',2,2,'2026-09',300.00);

-- ---------------------------------------------------------------------------
-- Projeção PJ: recálculo do fechamento não duplica o desconto.
-- O índice `fdp_contractor_components_workspace_external_uq` já existia; este
-- ensaio prova que a chave `ledger:<parcela>` o aciona.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_contractor_components (id, workspace_id, company_id, provider_id, payroll_cycle_id,
  competence, direction, component_type, description, amount, origin, external_id, created_by)
  VALUES ('cmp-led-1','ws-a','co-a','pj-a','cy-a','2026-08','debit','loan','Emprestimo ao prestador 1/2',
    300.00,'manual','ledger:led-pj-p1','u1');

SELECT expect_error($$INSERT INTO fdp_contractor_components (id, workspace_id, company_id, provider_id, payroll_cycle_id,
  competence, direction, component_type, description, amount, origin, external_id, created_by)
  VALUES ('cmp-led-2','ws-a','co-a','pj-a','cy-a','2026-08','debit','loan','Reprojecao do mesmo desconto',
    300.00,'manual','ledger:led-pj-p1','u1')$$,
  'fdp_contractor_components_workspace_external_uq');

-- ---------------------------------------------------------------------------
-- Uma solicitação aprovada origina um único lançamento.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence,
  origin_type, origin_id, status, created_by, updated_by)
  VALUES ('led-sesmt','ws-a','co-a','emp-a','sesmt_discount','Desconto do SESMT','2026-07-20','u1',
    55.00,'single',1,'2026-08','epi_discount','epi-req-1','active','u1','u1');

SELECT expect_error($$INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence,
  origin_type, origin_id, created_by, updated_by)
  VALUES ('led-sesmt-2','ws-a','co-a','emp-a','sesmt_discount','Mesma solicitacao de novo','2026-07-20','u1',
    55.00,'single',1,'2026-08','epi_discount','epi-req-1','u1','u1')$$,
  'fdp_ledger_entries_origin_uq');

-- ---------------------------------------------------------------------------
-- Adiantamento: pago ao colaborador ≠ descontado dele.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_advance_rules (id, workspace_id, entry_id, mode, fixed_amount, effective_from_competence, created_by)
  VALUES ('rule-1','ws-a','led-2','fixed_monthly',500.00,'2026-08','u1');

SELECT expect_error($$INSERT INTO fdp_ledger_advance_rules (id, workspace_id, entry_id, mode, percentage, fixed_amount, effective_from_competence, created_by)
  VALUES ('rule-2','ws-a','led-2','percentage',40,500.00,'2026-09','u1')$$,
  'fdp_ledger_advance_rules_shape_check');

INSERT INTO fdp_ledger_advance_payments (id, workspace_id, entry_id, company_id, competence,
  approved_amount, expected_payment_date, status, idempotency_key, created_by)
  VALUES ('pay-1','ws-a','led-2','co-a','2026-08',500.00,'2026-08-20','scheduled','ledger-advance:led-2:2026-08','u1');

-- Gerar a programação duas vezes não paga duas.
SELECT expect_error($$INSERT INTO fdp_ledger_advance_payments (id, workspace_id, entry_id, company_id, competence,
  approved_amount, status, idempotency_key, created_by)
  VALUES ('pay-2','ws-a','led-2','co-a','2026-08',500.00,'scheduled','outra-chave','u1')$$,
  'fdp_ledger_advance_payments_entry_competence_uq');

-- Pagar exige valor e data efetiva: "pago" sem data é promessa, não pagamento.
SELECT expect_error($$UPDATE fdp_ledger_advance_payments SET status = 'paid' WHERE id = 'pay-1'$$,
  'fdp_ledger_advance_payments_paid_check');
UPDATE fdp_ledger_advance_payments SET status = 'paid', paid_amount = 500.00, actual_payment_date = '2026-08-20', paid_by = 'u1' WHERE id = 'pay-1';

-- Suspender a competência é cancelar com motivo, nunca um pulo silencioso.
INSERT INTO fdp_ledger_advance_payments (id, workspace_id, entry_id, company_id, competence,
  approved_amount, status, idempotency_key, created_by)
  VALUES ('pay-3','ws-a','led-2','co-a','2026-09',500.00,'scheduled','ledger-advance:led-2:2026-09','u1');
SELECT expect_error($$UPDATE fdp_ledger_advance_payments SET status = 'canceled' WHERE id = 'pay-3'$$,
  'fdp_ledger_advance_payments_cancel_check');
UPDATE fdp_ledger_advance_payments SET status = 'canceled', cancel_reason = 'Colaborador em ferias na competencia' WHERE id = 'pay-3';

-- O pagamento do adiantamento não criou desconto nenhum: são dois lados do
-- mesmo lançamento, não duas dívidas.
DO $$
DECLARE descontos int;
BEGIN
  SELECT count(*) INTO descontos FROM fdp_ledger_confirmations WHERE entry_id = 'led-2';
  IF descontos <> 0 THEN
    RAISE EXCEPTION 'pagar o adiantamento gerou % confirmacao(oes) de desconto', descontos;
  END IF;
  RAISE NOTICE 'OK: pagar ao colaborador nao confirma desconto';
END;
$$;

-- ---------------------------------------------------------------------------
-- Lote da competência: exportar não baixa parcela; fechar é imutável.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_batches (id, workspace_id, company_id, payroll_cycle_id, competence, status, created_by)
  VALUES ('bat-1','ws-a','co-a','cy-a','2026-08','draft','u1');

SELECT expect_error($$INSERT INTO fdp_ledger_batches (id, workspace_id, company_id, payroll_cycle_id, competence, created_by)
  VALUES ('bat-2','ws-a','co-a','cy-a','2026-08','u1')$$,
  'fdp_ledger_batches_cycle_uq');

UPDATE fdp_ledger_installments SET batch_id = 'bat-1' WHERE entry_id = 'led-1' AND competence = '2026-09';
UPDATE fdp_ledger_batches SET status = 'exported', exported_at = now(), exported_by = 'u1', export_reference = 'lote-2026-08' WHERE id = 'bat-1';

DO $$
DECLARE parcela RECORD;
BEGIN
  SELECT * INTO parcela FROM fdp_ledger_installments WHERE id = 'led-1-p2';
  IF parcela.discounted_amount <> 0 OR parcela.status <> 'scheduled' THEN
    RAISE EXCEPTION 'exportar o lote baixou a parcela: % / %', parcela.discounted_amount, parcela.status;
  END IF;
  RAISE NOTICE 'OK: exportar nao confirma desconto';
END;
$$;

UPDATE fdp_ledger_batches SET status = 'closed', snapshot_json = '{"total":666.67}', closed_by = 'u1', closed_at = now() WHERE id = 'bat-1';

SELECT expect_error($$UPDATE fdp_ledger_batches SET snapshot_json = '{"total":0}' WHERE id = 'bat-1'$$,
  'closed ledger batch is immutable');
SELECT expect_error($$UPDATE fdp_ledger_batches SET status = 'reopened' WHERE id = 'bat-1'$$,
  'reopening a closed ledger batch requires a justification');
UPDATE fdp_ledger_batches SET status = 'reopened', reopen_reason = 'Divergencia apontada pelo financeiro' WHERE id = 'bat-1';

-- ---------------------------------------------------------------------------
-- Vocabulários ampliados continuam aceitando o que já existia.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_employee_movements (id, workspace_id, company_id, employee_id, payroll_cycle_id,
  movement_type, effective_date, title, requested_by, status)
  VALUES ('mov-led','ws-a','co-a','emp-a','cy-a','payroll_discount','2026-08-01','Aprovacao do desconto','u1','pending_approval');
INSERT INTO fdp_operational_pending_items (id, workspace_id, company_id, payroll_cycle_id, source_type, source_id,
  severity, blocking, title, idempotency_key)
  VALUES ('pend-led','ws-a','co-a','cy-a','ledger_entry','led-1','critical',1,'Saldo em aberto no desligamento','ledger:led-1:termination');

-- ---------------------------------------------------------------------------
-- Reimportação: a mesma linha não vira dois lançamentos.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_imports (id, workspace_id, filename, file_hash, entry_competence, status, created_by)
  VALUES ('imp-1','ws-a','vales.xlsx','hash-abc','2026-08','committed','u1');
INSERT INTO fdp_ledger_import_rows (id, workspace_id, import_id, sheet_name, row_number, raw_json, row_hash, entry_id, resolution)
  VALUES ('imp-1-r1','ws-a','imp-1','20.08.26',25,'{"controle":"5/10 R$ 200,00 Emprestimo Loja"}','hash-linha-1','led-1','resolved');

INSERT INTO fdp_ledger_imports (id, workspace_id, filename, file_hash, entry_competence, status, created_by)
  VALUES ('imp-2','ws-a','vales.xlsx','hash-abc','2026-08','draft','u1');
SELECT expect_error($$INSERT INTO fdp_ledger_import_rows (id, workspace_id, import_id, sheet_name, row_number, raw_json, row_hash, entry_id, resolution)
  VALUES ('imp-2-r1','ws-a','imp-2','20.08.26',25,'{"controle":"5/10 R$ 200,00 Emprestimo Loja"}','hash-linha-1','led-1','resolved')$$,
  'fdp_ledger_import_rows_committed_uq');

-- A mesma linha ainda não gravada continua livre para ser reprocessada.
INSERT INTO fdp_ledger_import_rows (id, workspace_id, import_id, sheet_name, row_number, raw_json, row_hash, resolution)
  VALUES ('imp-2-r2','ws-a','imp-2','20.08.26',26,'{"controle":"VALE FIXO"}','hash-linha-2','pending');

-- O texto original é preservado com a aba e a linha de onde veio.
DO $$
DECLARE original text;
BEGIN
  SELECT raw_json->>'controle' INTO original FROM fdp_ledger_import_rows WHERE id = 'imp-1-r1';
  IF original IS DISTINCT FROM '5/10 R$ 200,00 Emprestimo Loja' THEN
    RAISE EXCEPTION 'o texto original da planilha nao foi preservado: %', original;
  END IF;
  RAISE NOTICE 'OK: o texto original da planilha fica legivel com aba e linha';
END;
$$;

-- ---------------------------------------------------------------------------
-- Quitação: o lançamento vira `settled` por leitura do saldo, não por digitação.
-- É a mesma consulta que a rota de confirmação executa.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence,
  status, created_by, updated_by)
  VALUES ('led-q','ws-a','co-a','emp-a','loan','Emprestimo de duas parcelas','2026-07-20','u1',
    100.00,'installments',2,'2026-08','active','u1','u1');
INSERT INTO fdp_ledger_installments (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount) VALUES
  ('led-q-p1','ws-a','led-q','co-a',1,2,'2026-08',50.00),
  ('led-q-p2','ws-a','led-q','co-a',2,2,'2026-09',50.00);
INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, confirmed_by, idempotency_key)
  VALUES ('led-q-c1','ws-a','led-q-p1','led-q','2026-08',50.00,'u1','q-k1');

UPDATE fdp_ledger_entries entry SET status = 'settled', updated_at = now()
  WHERE entry.workspace_id = 'ws-a' AND entry.id = 'led-q' AND entry.status = 'active'
    AND entry.modality <> 'recurring'
    AND NOT EXISTS (
      SELECT 1 FROM fdp_ledger_installments open_installment
      WHERE open_installment.workspace_id = entry.workspace_id
        AND open_installment.entry_id = entry.id
        AND open_installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
        AND open_installment.discounted_amount < open_installment.planned_amount
    );

DO $$
DECLARE situacao text;
BEGIN
  SELECT status INTO situacao FROM fdp_ledger_entries WHERE id = 'led-q';
  IF situacao <> 'active' THEN
    RAISE EXCEPTION 'lancamento com parcela em aberto virou % em vez de continuar ativo', situacao;
  END IF;
  RAISE NOTICE 'OK: com parcela em aberto, o lancamento nao se quita sozinho';
END;
$$;

INSERT INTO fdp_ledger_confirmations (id, workspace_id, installment_id, entry_id, competence, amount, confirmed_by, idempotency_key)
  VALUES ('led-q-c2','ws-a','led-q-p2','led-q','2026-09',50.00,'u1','q-k2');

UPDATE fdp_ledger_entries entry SET status = 'settled', updated_at = now()
  WHERE entry.workspace_id = 'ws-a' AND entry.id = 'led-q' AND entry.status = 'active'
    AND entry.modality <> 'recurring'
    AND NOT EXISTS (
      SELECT 1 FROM fdp_ledger_installments open_installment
      WHERE open_installment.workspace_id = entry.workspace_id
        AND open_installment.entry_id = entry.id
        AND open_installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
        AND open_installment.discounted_amount < open_installment.planned_amount
    );

DO $$
DECLARE situacao text;
BEGIN
  SELECT status INTO situacao FROM fdp_ledger_entries WHERE id = 'led-q';
  IF situacao <> 'settled' THEN
    RAISE EXCEPTION 'lancamento integralmente descontado ficou como %', situacao;
  END IF;
  RAISE NOTICE 'OK: quitacao e leitura do saldo, nao digitacao';
END;
$$;

-- ---------------------------------------------------------------------------
-- Renegociação: só o saldo entra no novo acordo; o original preserva o que já
-- foi descontado e não é reescrito.
-- ---------------------------------------------------------------------------
-- O empréstimo led-1 tem 1.000,00 previstos, 150,00 confirmados e a parcela 3
-- reprogramada. O saldo é o que resta das parcelas que continuam valendo.
DO $$
DECLARE previsto numeric(18,2); descontado numeric(18,2); saldo numeric(18,2);
BEGIN
  SELECT
    SUM(CASE WHEN status IN ('canceled','rescheduled','skipped') THEN discounted_amount ELSE planned_amount END),
    SUM(discounted_amount)
    INTO previsto, descontado
  FROM fdp_ledger_installments WHERE entry_id = 'led-1';
  saldo := previsto - descontado;
  IF saldo <> 516.67 THEN
    RAISE EXCEPTION 'saldo remanescente esperado 516,67, veio %', saldo;
  END IF;
  RAISE NOTICE 'OK: saldo remanescente calculado sobre as parcelas que valem (%)', saldo;
END;
$$;

INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence,
  status, origin_type, origin_id, parent_entry_id, created_by, updated_by)
  VALUES ('led-1-r','ws-a','co-a','emp-a','loan','Renegociacao do emprestimo','2026-09-01','u1',
    516.67,'installments',2,'2026-11','active','renegotiation','led-1','led-1','u1','u1');
INSERT INTO fdp_ledger_installments (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount) VALUES
  ('led-1-r-p1','ws-a','led-1-r','co-a',1,2,'2026-11',258.34),
  ('led-1-r-p2','ws-a','led-1-r','co-a',2,2,'2026-12',258.33);

UPDATE fdp_ledger_installments SET status = 'canceled', note = 'Renegociado', updated_at = now()
  WHERE workspace_id = 'ws-a' AND entry_id = 'led-1' AND discounted_amount = 0
    AND status NOT IN ('canceled', 'discounted');
UPDATE fdp_ledger_entries SET status = 'renegotiated', updated_at = now()
  WHERE workspace_id = 'ws-a' AND id = 'led-1' AND status IN ('approved','active','suspended');

DO $$
DECLARE confirmada RECORD; soma numeric(18,2);
BEGIN
  SELECT * INTO confirmada FROM fdp_ledger_installments WHERE id = 'led-1-p1';
  IF confirmada.discounted_amount <> 150.00 OR confirmada.status <> 'partially_discounted' THEN
    RAISE EXCEPTION 'a renegociacao mexeu na parcela ja confirmada: % / %', confirmada.discounted_amount, confirmada.status;
  END IF;
  SELECT SUM(planned_amount) INTO soma FROM fdp_ledger_installments WHERE entry_id = 'led-1-r';
  IF soma <> 516.67 THEN
    RAISE EXCEPTION 'as parcelas do novo acordo somam % em vez do saldo', soma;
  END IF;
  IF (SELECT total_amount FROM fdp_ledger_entries WHERE id = 'led-1') <> 1000.00 THEN
    RAISE EXCEPTION 'o valor do acordo original foi reescrito';
  END IF;
  IF (SELECT count(*) FROM fdp_ledger_confirmations WHERE entry_id = 'led-1') <> 3 THEN
    RAISE EXCEPTION 'o historico do acordo original foi perdido na renegociacao';
  END IF;
  RAISE NOTICE 'OK: renegociacao cobre so o saldo e preserva o acordo original inteiro';
END;
$$;

-- ---------------------------------------------------------------------------
-- Adiantamento: um pagamento produz UMA obrigação de recuperar, nunca duas.
--
-- O número da parcela sai da distância entre a primeira competência do
-- lançamento e a da recuperação, exatamente como a rota calcula. Pagar duas
-- vezes o mesmo mês esbarra no índice `(workspace, entry, number)`.
-- ---------------------------------------------------------------------------
INSERT INTO fdp_ledger_advance_payments (id, workspace_id, entry_id, company_id, competence,
  approved_amount, expected_payment_date, status, idempotency_key, created_by)
  VALUES ('pay-set','ws-a','led-2','co-a','2026-10',500.00,'2026-10-20','authorized','ledger-advance:led-2:2026-10','u1');

-- O pagamento cria a parcela de recuperação. led-2 comeca em 2026-08, entao a
-- recuperacao de 2026-10 e a parcela numero 3.
UPDATE fdp_ledger_advance_payments
  SET status = 'paid', paid_amount = 500.00, actual_payment_date = '2026-10-20', paid_by = 'u1'
  WHERE workspace_id = 'ws-a' AND id = 'pay-set' AND status = 'authorized';
INSERT INTO fdp_ledger_installments (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount, note)
  VALUES ('rec-1','ws-a','led-2','co-a',3,NULL,'2026-10',500.00,'Recuperacao do adiantamento pago em 2026-10-20')
  ON CONFLICT (workspace_id, entry_id, number) DO NOTHING;

DO $$
DECLARE parcela RECORD;
BEGIN
  SELECT * INTO parcela FROM fdp_ledger_installments WHERE entry_id = 'led-2' AND number = 3;
  IF parcela.discounted_amount <> 0 OR parcela.status <> 'scheduled' THEN
    RAISE EXCEPTION 'a recuperacao nasceu ja descontada: % / %', parcela.discounted_amount, parcela.status;
  END IF;
  IF parcela.planned_amount <> 500.00 THEN
    RAISE EXCEPTION 'a recuperacao nasceu com valor %', parcela.planned_amount;
  END IF;
  RAISE NOTICE 'OK: pagar cria a recuperacao programada, nunca confirmada';
END;
$$;

-- Repetir o pagamento não cria a segunda dívida pelo mesmo adiantamento.
INSERT INTO fdp_ledger_installments (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount, note)
  VALUES ('rec-1-dup','ws-a','led-2','co-a',3,NULL,'2026-10',500.00,'Tentativa repetida')
  ON CONFLICT (workspace_id, entry_id, number) DO NOTHING;

DO $$
DECLARE quantas int; soma numeric(18,2);
BEGIN
  SELECT count(*), SUM(planned_amount) INTO quantas, soma
    FROM fdp_ledger_installments WHERE entry_id = 'led-2' AND competence = '2026-10';
  IF quantas <> 1 OR soma <> 500.00 THEN
    RAISE EXCEPTION 'o mesmo adiantamento virou % obrigacao(oes) somando %', quantas, soma;
  END IF;
  RAISE NOTICE 'OK: um adiantamento pago nao vira duas dividas';
END;
$$;

-- A recorrência gera a programação, e gerar duas vezes não paga duas.
INSERT INTO fdp_ledger_advance_payments (id, workspace_id, entry_id, company_id, competence,
  approved_amount, status, idempotency_key, created_by)
  VALUES ('pay-nov','ws-a','led-2','co-a','2026-11',500.00,'scheduled','ledger-advance:led-2:2026-11','u1')
  ON CONFLICT (workspace_id, entry_id, competence) DO NOTHING;
INSERT INTO fdp_ledger_advance_payments (id, workspace_id, entry_id, company_id, competence,
  approved_amount, status, idempotency_key, created_by)
  VALUES ('pay-nov-2','ws-a','led-2','co-a','2026-11',500.00,'scheduled','outra-chave-nov','u1')
  ON CONFLICT (workspace_id, entry_id, competence) DO NOTHING;

DO $$
DECLARE quantas int; situacao text;
BEGIN
  SELECT count(*) INTO quantas FROM fdp_ledger_advance_payments
    WHERE entry_id = 'led-2' AND competence = '2026-11';
  IF quantas <> 1 THEN
    RAISE EXCEPTION 'gerar a programacao duas vezes criou % ocorrencias', quantas;
  END IF;
  SELECT status INTO situacao FROM fdp_ledger_advance_payments WHERE id = 'pay-nov';
  IF situacao <> 'scheduled' THEN
    RAISE EXCEPTION 'a programacao nasceu como % em vez de programada', situacao;
  END IF;
  RAISE NOTICE 'OK: a recorrencia programa sem pagar e sem duplicar';
END;
$$;

-- Percentual sem base salarial vira pendência nomeada, nunca R$ 0,00 pago.
INSERT INTO fdp_ledger_advance_rules (id, workspace_id, entry_id, mode, percentage, effective_from_competence, created_by)
  VALUES ('rule-pct','ws-a','led-2','percentage',40,'2027-01','u1');
INSERT INTO fdp_ledger_advance_payments (id, workspace_id, entry_id, company_id, competence,
  approved_amount, status, pending_reason, idempotency_key, created_by)
  VALUES ('pay-pend','ws-a','led-2','co-a','2027-01',0,'pending_data',
    'Informe a base salarial para calcular o adiantamento percentual.','ledger-advance:led-2:2027-01','u1');

DO $$
DECLARE registro RECORD;
BEGIN
  SELECT * INTO registro FROM fdp_ledger_advance_payments WHERE id = 'pay-pend';
  IF registro.status <> 'pending_data' OR registro.pending_reason = '' THEN
    RAISE EXCEPTION 'percentual sem base nao virou pendencia nomeada';
  END IF;
  RAISE NOTICE 'OK: percentual sem base e pendencia, nao pagamento de zero';
END;
$$;

-- A regra anterior vira `superseded` e continua legível: competências passadas
-- leem o valor que valia nelas.
UPDATE fdp_ledger_advance_rules SET status = 'superseded'
  WHERE workspace_id = 'ws-a' AND id = 'rule-1' AND status = 'active';

DO $$
DECLARE antiga RECORD; nova RECORD;
BEGIN
  SELECT * INTO antiga FROM fdp_ledger_advance_rules WHERE id = 'rule-1';
  SELECT * INTO nova FROM fdp_ledger_advance_rules WHERE id = 'rule-pct';
  IF antiga.fixed_amount <> 500.00 OR antiga.effective_from_competence <> '2026-08' THEN
    RAISE EXCEPTION 'a regra anterior foi reescrita: % a partir de %', antiga.fixed_amount, antiga.effective_from_competence;
  END IF;
  IF antiga.status <> 'superseded' OR nova.status <> 'active' THEN
    RAISE EXCEPTION 'as vigencias nao se sucederam: % / %', antiga.status, nova.status;
  END IF;
  RAISE NOTICE 'OK: alterar valor cria nova vigencia e preserva a anterior';
END;
$$;

-- ---------------------------------------------------------------------------
-- Isolamento entre workspaces com papel sem superusuário.
-- ---------------------------------------------------------------------------
DROP ROLE IF EXISTS fdp_ledger_rehearsal_app;
CREATE ROLE fdp_ledger_rehearsal_app LOGIN;
GRANT USAGE ON SCHEMA public TO fdp_ledger_rehearsal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fdp_ledger_rehearsal_app;
GRANT fdp_ledger_rehearsal_app TO CURRENT_USER;

SET ROLE fdp_ledger_rehearsal_app;
SELECT set_config('app.workspace_id', 'ws-b', false);

DO $$
DECLARE visiveis int;
BEGIN
  SELECT count(*) INTO visiveis FROM fdp_ledger_entries;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'o workspace ws-b enxergou % lancamento(s) do ws-a', visiveis;
  END IF;
  SELECT count(*) INTO visiveis FROM fdp_ledger_confirmations;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'o workspace ws-b enxergou % confirmacao(oes) do ws-a', visiveis;
  END IF;
  SELECT count(*) INTO visiveis FROM fdp_ledger_documents;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'o workspace ws-b enxergou % documento(s) do ws-a', visiveis;
  END IF;
  RAISE NOTICE 'OK: nada do ws-a aparece para o ws-b';
END;
$$;

-- Escrever no workspace alheio também é recusado pela política, não só a leitura.
SELECT expect_error($$INSERT INTO fdp_ledger_entries (id, workspace_id, company_id, employee_id, category, title,
  requested_on, requested_by, total_amount, modality, installment_count, first_competence, created_by, updated_by)
  VALUES ('led-vaza','ws-a','co-a','emp-a','loan','Vazamento','2026-07-20','u1',100.00,'single',1,'2026-08','u1','u1')$$,
  'row-level security');

RESET ROLE;
SELECT set_config('app.workspace_id', 'ws-a', false);
REVOKE fdp_ledger_rehearsal_app FROM CURRENT_USER;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fdp_ledger_rehearsal_app;
REVOKE USAGE ON SCHEMA public FROM fdp_ledger_rehearsal_app;
DROP ROLE fdp_ledger_rehearsal_app;
DROP FUNCTION expect_error(text, text);
