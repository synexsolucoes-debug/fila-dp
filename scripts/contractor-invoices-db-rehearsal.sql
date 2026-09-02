\set ON_ERROR_STOP on
-- Ensaio do controle de notas fiscais contra um PostgreSQL de verdade.
--
-- O que se prova aqui não é o cálculo — isso é teste de unidade — e sim o que
-- só o banco garante: que uma nota não pode existir sem vínculo com grupo,
-- empresa, competência, pagamento e prestador; que duas notas não podem valer
-- ao mesmo tempo para o mesmo pagamento; que recusar sem motivo é rejeitado
-- pela própria tabela; e que o tenant vizinho não enxerga nada disso mesmo
-- tendo os identificadores certos em mãos.
--
-- Roda depois de `payments-db-rehearsal.sql`, e reaproveita a semente dele.

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

-- Um pagamento aberto para a nota, ao lado do que o ensaio de pagamentos já
-- deixou fechado. Prestador do grupo, empresa pagadora, competência própria.
INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id)
  VALUES ('co-nf','ws-a','Empresa NF','NF','3');
INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
  VALUES ('cy-nf','ws-a','co-nf','2026-09','open','u1');
INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, tax_id)
  VALUES ('pj-nf','ws-a','contractor','XPTO','Empresa XPTO LTDA','26016500000105');
INSERT INTO fdp_contractor_profiles (provider_id, workspace_id, company_id, base_amount, complement_method, updated_by)
  VALUES ('pj-nf','ws-a','co-nf',6000,'caju_saldo_livre','u1');
INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
    base_amount, net_amount, invoice_limit_amount, invoice_limit_source, invoice_expected_amount,
    complement_amount, complement_method, calc_version, created_by, invoice_review_status)
  VALUES ('ccl-nf','ws-a','co-nf','pj-nf','cy-nf','2026-09',6000,6000,6000,'workspace',6000,0,'caju_saldo_livre',
    'contractor-payment-1.2.0','u1','awaiting_issue');

-- A nota nasce vinculada: sem competência válida ela nem entra.
SELECT expect_error($$INSERT INTO fdp_contractor_invoices
    (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence, invoice_number,
     issue_date, amount, expected_amount, difference_amount, uploaded_by)
  VALUES ('nf-bad','ws-a','co-nf','pj-nf','cy-nf','ccl-nf','2026-13','1',
    '2026-09-05',6000,6000,0,'u1')$$, 'fdp_contractor_invoices_competence_check');

-- A diferença é derivada, não digitada: um valor inventado é recusado.
SELECT expect_error($$INSERT INTO fdp_contractor_invoices
    (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence, invoice_number,
     issue_date, amount, expected_amount, difference_amount, uploaded_by)
  VALUES ('nf-bad2','ws-a','co-nf','pj-nf','cy-nf','ccl-nf','2026-09','1',
    '2026-09-05',5500,6000,0,'u1')$$, 'fdp_contractor_invoices_difference_check');

-- Cenário do produto: NF de R$ 5.500,00 contra R$ 6.000,00 esperados.
INSERT INTO fdp_contractor_invoices
    (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence, attempt,
     invoice_number, series, issue_date, issuer_document, issuer_name,
     amount, expected_amount, difference_amount, uploaded_by)
  VALUES ('nf-1','ws-a','co-nf','pj-nf','cy-nf','ccl-nf','2026-09',1,
    '1245','1','2026-09-05','26016500000105','Empresa XPTO LTDA',5500,6000,-500,'u1');
UPDATE fdp_contractor_closings
  SET invoice_current_id = 'nf-1', invoice_number = '1245', invoice_received_amount = 5500,
      invoice_review_status = 'received'
  WHERE id = 'ccl-nf';

-- Um pagamento tem uma nota vigente por vez.
SELECT expect_error($$INSERT INTO fdp_contractor_invoices
    (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence, attempt,
     invoice_number, issue_date, amount, expected_amount, difference_amount, uploaded_by)
  VALUES ('nf-2','ws-a','co-nf','pj-nf','cy-nf','ccl-nf','2026-09',2,
    '1246','2026-09-06',6000,6000,0,'u1')$$, 'fdp_contractor_invoices_current_uq');

-- Recusar exige motivo, e "outro" exige descrição — no banco, não só na rota.
SELECT expect_error($$UPDATE fdp_contractor_invoices
  SET status = 'rejected', reviewed_by = 'u1', reviewed_at = now() WHERE id = 'nf-1'$$,
  'fdp_contractor_invoices_rejection_check');
SELECT expect_error($$UPDATE fdp_contractor_invoices
  SET status = 'rejected', rejection_reason = 'other', rejection_detail = 'x',
      reviewed_by = 'u1', reviewed_at = now() WHERE id = 'nf-1'$$,
  'fdp_contractor_invoices_rejection_detail_check');
-- E aprovar sem dizer quem aprovou também é recusado.
SELECT expect_error($$UPDATE fdp_contractor_invoices SET status = 'approved' WHERE id = 'nf-1'$$,
  'fdp_contractor_invoices_review_check');

-- Rejeição válida, com motivo do catálogo.
UPDATE fdp_contractor_invoices
  SET status = 'rejected', rejection_reason = 'amount_mismatch',
      reviewed_by = 'u1', reviewed_at = now()
  WHERE id = 'nf-1';

-- Substituição: a anterior sai de cena sem ser apagada, e a nova assume.
--
-- A ordem importa e é a mesma do serviço: a anterior sai primeiro (liberando o
-- índice de nota vigente), a nova entra, e só então a anterior aponta para a
-- substituta — a chave estrangeira é conferida na hora.
SELECT expect_error($$UPDATE fdp_contractor_invoices SET replaced_by_invoice_id = 'nf-2' WHERE id = 'nf-1'$$,
  'fdp_contractor_invoices_replaced_by_fk');
UPDATE fdp_contractor_invoices SET superseded_at = now() WHERE id = 'nf-1';
INSERT INTO fdp_contractor_invoices
    (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence, attempt,
     invoice_number, series, issue_date, issuer_document, amount, expected_amount, difference_amount,
     replaces_invoice_id, uploaded_by)
  VALUES ('nf-2','ws-a','co-nf','pj-nf','cy-nf','ccl-nf','2026-09',2,
    '1258','1','2026-09-08','26016500000105',6000,6000,0,'nf-1','u1');
UPDATE fdp_contractor_invoices SET replaced_by_invoice_id = 'nf-2' WHERE id = 'nf-1';
UPDATE fdp_contractor_closings
  SET invoice_current_id = 'nf-2', invoice_number = '1258', invoice_received_amount = 6000,
      invoice_review_status = 'received'
  WHERE id = 'ccl-nf';

DO $$
DECLARE versoes int;
BEGIN
  SELECT count(*) INTO versoes FROM fdp_contractor_invoices WHERE closing_id = 'ccl-nf';
  IF versoes <> 2 THEN RAISE EXCEPTION 'a nota substituída foi perdida: % versão(ões)', versoes; END IF;
  PERFORM 1 FROM fdp_contractor_invoices WHERE id = 'nf-1' AND replaced_by_invoice_id = 'nf-2';
  IF NOT FOUND THEN RAISE EXCEPTION 'a nota anterior não aponta para a substituta'; END IF;
  RAISE NOTICE 'OK histórico de versões preservado na substituição';
END;
$$;

-- Duplicidade: mesma numeração, mesmo emissor, valendo em outro pagamento.
INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
  VALUES ('cy-nf2','ws-a','co-nf','2026-10','open','u1');
INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, tax_id)
  VALUES ('pj-nf2','ws-a','contractor','XPTO2','Empresa XPTO Filial','26016500000105');
INSERT INTO fdp_contractor_profiles (provider_id, workspace_id, company_id, base_amount, complement_method, updated_by)
  VALUES ('pj-nf2','ws-a','co-nf',6000,'caju_saldo_livre','u1');
INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
    base_amount, net_amount, invoice_expected_amount, complement_amount, calc_version, created_by)
  VALUES ('ccl-nf2','ws-a','co-nf','pj-nf','cy-nf2','2026-10',6000,6000,6000,0,'contractor-payment-1.2.0','u1');
SELECT expect_error($$INSERT INTO fdp_contractor_invoices
    (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence, attempt,
     invoice_number, series, issue_date, issuer_document, amount, expected_amount, difference_amount, uploaded_by)
  VALUES ('nf-3','ws-a','co-nf','pj-nf','cy-nf2','ccl-nf2','2026-10',1,
    '1258','1','2026-10-02','26016500000105',6000,6000,0,'u1')$$, 'fdp_contractor_invoices_duplicate_uq');

-- O histórico é append-only na prática: cada fato é uma linha própria.
INSERT INTO fdp_contractor_invoice_events
    (id, workspace_id, invoice_id, closing_id, provider_id, competence, action, actor_user_id, summary)
  VALUES ('ev-1','ws-a','nf-1','ccl-nf','pj-nf','2026-09','uploaded','u1','NF 1245 anexada por A.'),
         ('ev-2','ws-a','nf-1','ccl-nf','pj-nf','2026-09','rejected','u1','NF 1245 rejeitada por A. Motivo: Valor incorreto.'),
         ('ev-3','ws-a','nf-2','ccl-nf','pj-nf','2026-09','uploaded','u1','NF 1258 anexada por A.');
SELECT expect_error($$INSERT INTO fdp_contractor_invoice_events
    (id, workspace_id, invoice_id, closing_id, provider_id, competence, action, actor_user_id)
  VALUES ('ev-bad','ws-a','nf-2','ccl-nf','pj-nf','2026-09','inventado','u1')$$,
  'fdp_contractor_invoice_events_action_check');

-- A aprovação da nota vigente libera o pagamento.
UPDATE fdp_contractor_invoices SET status = 'approved', reviewed_by = 'u1', reviewed_at = now() WHERE id = 'nf-2';
UPDATE fdp_contractor_closings SET invoice_review_status = 'approved' WHERE id = 'ccl-nf';
DO $$
DECLARE situacao text;
BEGIN
  SELECT invoice_review_status INTO situacao FROM fdp_contractor_closings WHERE id = 'ccl-nf';
  IF situacao <> 'approved' THEN RAISE EXCEPTION 'o pagamento não reflete a nota aprovada: %', situacao; END IF;
  RAISE NOTICE 'OK pagamento apto após aprovação da nota';
END;
$$;

-- Isolamento: o tenant B recebe os identificadores verdadeiros e não alcança nada.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fdp_invoice_rehearsal_app') THEN
    CREATE ROLE fdp_invoice_rehearsal_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
  END IF;
END;
$role$;
GRANT fdp_invoice_rehearsal_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO fdp_invoice_rehearsal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fdp_invoice_rehearsal_app;

SET ROLE fdp_invoice_rehearsal_app;
SELECT set_config('app.workspace_id', 'ws-b', false);
DO $$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM fdp_contractor_invoices WHERE id IN ('nf-1','nf-2');
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: nota fiscal de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_contractor_invoice_events;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: histórico de nota de outro workspace visível'; END IF;
  UPDATE fdp_contractor_invoices SET status = 'approved' WHERE id = 'nf-2';
  IF FOUND THEN RAISE EXCEPTION 'vazamento: aprovação cruzada aceita'; END IF;
  DELETE FROM fdp_contractor_invoices WHERE id = 'nf-1';
  IF FOUND THEN RAISE EXCEPTION 'vazamento: exclusão cruzada aceita'; END IF;
  RAISE NOTICE 'OK isolamento multi-tenant nas tabelas de nota fiscal';
END;
$$;
-- Nem escrever com workspace_id forjado.
SELECT expect_error($$INSERT INTO fdp_contractor_invoice_events
    (id, workspace_id, invoice_id, closing_id, provider_id, competence, action, actor_user_id)
  VALUES ('ev-x','ws-a','nf-2','ccl-nf','pj-nf','2026-09','approved','u2')$$, 'row-level security');

-- Sem contexto de tenant, nada é visível.
SELECT set_config('app.workspace_id', '', false);
DO $$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM fdp_contractor_invoices;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: leitura de nota sem contexto de tenant'; END IF;
  RAISE NOTICE 'OK negado sem contexto de tenant';
END;
$$;
\echo VERIFICACOES DE NOTA FISCAL PASSARAM

RESET ROLE;
REVOKE fdp_invoice_rehearsal_app FROM CURRENT_USER;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fdp_invoice_rehearsal_app;
REVOKE USAGE ON SCHEMA public FROM fdp_invoice_rehearsal_app;
DROP ROLE fdp_invoice_rehearsal_app;
DROP FUNCTION expect_error(text, text);
