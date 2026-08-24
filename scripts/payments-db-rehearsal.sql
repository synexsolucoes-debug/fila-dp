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

-- Semente mínima de dois tenants.
SELECT set_config('app.workspace_id', 'ws-a', false);
INSERT INTO fdp_users (id, email, name) VALUES ('u1','a@a.com','A'), ('u2','b@b.com','B');
INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ('ws-a','A','a','u1'), ('ws-b','B','b','u2');
INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('ws-a','u1','admin');
SELECT set_config('app.workspace_id', 'ws-b', false);
INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('ws-b','u2','admin');

SELECT set_config('app.workspace_id', 'ws-a', false);
INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id) VALUES ('co-a','ws-a','Empresa A','A','1');
INSERT INTO fdp_employees (id, workspace_id, company_id, registration_number, full_name, admission_date, created_by, updated_by)
  VALUES ('emp-a','ws-a','co-a','001','João','2026-01-05','u1','u1');
INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
  VALUES ('cy-a','ws-a','co-a','2026-08','open','u1');
INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name)
  VALUES ('psi-a','ws-a','psychologist','MARIA','Maria'), ('pj-a','ws-a','contractor','JOAO','João PJ');
INSERT INTO fdp_psychologist_profiles (provider_id, workspace_id, default_session_amount, updated_by) VALUES ('psi-a','ws-a',100,'u1');
INSERT INTO fdp_contractor_profiles (provider_id, workspace_id, company_id, base_amount, complement_method, updated_by)
  VALUES ('pj-a','ws-a','co-a',6500,'caju_saldo_livre','u1');

-- Psicólogos: 3 consultas de R$ 100 = R$ 300 (exemplo da especificação).
INSERT INTO fdp_psychology_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence, entries_count, sessions_count, employees_count, gross_amount, net_amount, calc_version, created_by)
  VALUES ('pcl-a','ws-a','co-a','psi-a','cy-a','2026-08',1,3,1,300,300,'psychology-payment-1.0.0','u1');
INSERT INTO fdp_psychology_sessions (id, workspace_id, company_id, provider_id, employee_id, payroll_cycle_id, closing_id, competence, session_date, session_quantity, unit_amount, total_amount, created_by)
  VALUES ('ps-1','ws-a','co-a','psi-a','emp-a','cy-a','pcl-a','2026-08','2026-08-10',3,100,300,'u1');
SELECT expect_error($$INSERT INTO fdp_psychology_sessions (id, workspace_id, company_id, provider_id, employee_id, payroll_cycle_id, competence, session_date, session_quantity, unit_amount, total_amount, created_by)
  VALUES ('ps-bad','ws-a','co-a','psi-a','emp-a','cy-a','2026-08','2026-08-10',3,100,250,'u1')$$, 'fdp_psychology_sessions_total_check');

-- PJ: 6500 + 500 - 400 - 100 = 6500 líquido; nota 6000; complemento 500.
INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
    base_amount, credits_amount, debits_amount, net_amount, invoice_limit_amount, invoice_limit_source,
    invoice_expected_amount, complement_amount, complement_method, caju_amount, calc_version, created_by)
  VALUES ('ccl-a','ws-a','co-a','pj-a','cy-a','2026-08',6500,500,500,6500,6000,'workspace',6000,500,'caju_saldo_livre',500,'contractor-payment-1.0.0','u1');
SELECT expect_error($$INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
    base_amount, net_amount, invoice_limit_amount, invoice_expected_amount, complement_amount, calc_version, created_by)
  VALUES ('ccl-bad','ws-a','co-a','pj-a','cy-a','2026-08',8200,8200,6000,6000,1000,'v','u1')$$, 'fdp_contractor_closings_split_check');
SELECT expect_error($$INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
    base_amount, net_amount, invoice_limit_amount, invoice_expected_amount, complement_amount, calc_version, created_by)
  VALUES ('ccl-bad2','ws-a','co-a','pj-a','cy-a','2026-08',8200,8200,6000,6500,1700,'v','u1')$$, 'fdp_contractor_closings_limit_cap_check');

-- O prestador é do grupo: um fechamento por competência, mesmo com outra
-- empresa e outro ciclo. Sem isto, apurar agosto em duas empresas pagaria a
-- mesma pessoa duas vezes, e o segundo pagamento pareceria tão correto quanto
-- o primeiro.
INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id) VALUES ('co-a2','ws-a','Empresa A2','A2','2');
INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
  VALUES ('cy-a2','ws-a','co-a2','2026-08','open','u1');
SELECT expect_error($$INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
    base_amount, net_amount, invoice_expected_amount, complement_amount, calc_version, created_by)
  VALUES ('ccl-dup','ws-a','co-a2','pj-a','cy-a2','2026-08',6500,6500,6500,0,'v','u1')$$,
  'fdp_contractor_closings_workspace_provider_competence_uq');

-- E o prestador pode não ter empresa nenhuma no contrato: é o caso de quem
-- atende várias e não pertence a uma. O que nasce do contrato acompanha.
INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name)
  VALUES ('pj-grupo','ws-a','contractor','GRUPO','Prestador do Grupo');
INSERT INTO fdp_contractor_profiles (provider_id, workspace_id, company_id, base_amount, complement_method, updated_by)
  VALUES ('pj-grupo','ws-a',NULL,4000,'none','u1');
INSERT INTO fdp_contractor_fixed_items (id, workspace_id, company_id, provider_id, direction, component_type,
    description, amount, effective_from, created_by)
  VALUES ('fi-grupo','ws-a',NULL,'pj-grupo','debit','health_plan','Plano',300,'2026-08','u1');
-- Departamento é da empresa: sem empresa no contrato, não há departamento a
-- apontar. A chave composta para de conferir quando uma coluna é nula, então
-- quem cobra a regra é o CHECK.
SELECT expect_error($$UPDATE fdp_contractor_profiles SET department_id = 'dep-qualquer'
  WHERE workspace_id = 'ws-a' AND provider_id = 'pj-grupo'$$,
  'fdp_contractor_profiles_department_needs_company_check');

-- Ajustes são append-only.
INSERT INTO fdp_psychology_adjustments (id, workspace_id, closing_id, kind, amount, reason, previous_amount, new_amount, created_by)
  VALUES ('adj-1','ws-a','pcl-a','discount',50,'Consulta nao realizada',300,250,'u1');
SELECT expect_error($$UPDATE fdp_psychology_adjustments SET amount = 10 WHERE id = 'adj-1'$$, 'append-only');
SELECT expect_error($$DELETE FROM fdp_psychology_adjustments WHERE id = 'adj-1'$$, 'append-only');

-- Fechamento concluído congela valores e exige justificativa para reabrir.
UPDATE fdp_contractor_closings SET status = 'review' WHERE id = 'ccl-a';
UPDATE fdp_contractor_closings SET status = 'approval' WHERE id = 'ccl-a';
UPDATE fdp_contractor_closings SET status = 'paid' WHERE id = 'ccl-a';
SELECT expect_error($$UPDATE fdp_contractor_closings SET net_amount = 99 WHERE id = 'ccl-a'$$, 'closed payment closing is immutable');
UPDATE fdp_contractor_closings SET status = 'closed', snapshot_json = '{"frozen":true}'::jsonb WHERE id = 'ccl-a';
SELECT expect_error($$UPDATE fdp_contractor_closings SET snapshot_json = '{}'::jsonb WHERE id = 'ccl-a'$$, 'closed payment closing is immutable');
SELECT expect_error($$UPDATE fdp_contractor_closings SET status = 'open' WHERE id = 'ccl-a'$$, 'requires a justification');
SELECT expect_error($$DELETE FROM fdp_contractor_closings WHERE id = 'ccl-a'$$, 'closed payment closing is immutable');
UPDATE fdp_contractor_closings SET status = 'reopened', reopen_reason = 'Nota reemitida pelo prestador' WHERE id = 'ccl-a';

-- Lançamentos de um fechamento concluído são imutáveis.
UPDATE fdp_psychology_closings SET status = 'review' WHERE id = 'pcl-a';
UPDATE fdp_psychology_closings SET status = 'approval' WHERE id = 'pcl-a';
UPDATE fdp_psychology_closings SET status = 'scheduled' WHERE id = 'pcl-a';
UPDATE fdp_psychology_closings SET status = 'paid' WHERE id = 'pcl-a';
SELECT expect_error($$UPDATE fdp_psychology_sessions SET unit_amount = 150, total_amount = 450 WHERE id = 'ps-1'$$, 'payment entry of a closed closing is immutable');
SELECT expect_error($$DELETE FROM fdp_psychology_sessions WHERE id = 'ps-1'$$, 'payment entry of a closed closing is immutable');

-- Papel de aplicação sem superusuário: RLS só vale para quem não é superusuário.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fdp_rehearsal_app') THEN
    CREATE ROLE fdp_rehearsal_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
  END IF;
END;
$role$;
GRANT fdp_rehearsal_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO fdp_rehearsal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fdp_rehearsal_app;

SET ROLE fdp_rehearsal_app;
-- Isolamento: o tenant B recebe os IDs verdadeiros do tenant A e não alcança nada.
SELECT set_config('app.workspace_id', 'ws-b', false);
DO $$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM fdp_psychology_sessions WHERE id = 'ps-1';
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: sessão de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_contractor_closings WHERE id = 'ccl-a';
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: fechamento PJ de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_psychologist_profiles;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: cadastro de psicólogo visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_contractor_profiles;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: cadastro PJ visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_invoice_limit_policies;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: política de limite visível'; END IF;
  UPDATE fdp_contractor_closings SET status = 'open' WHERE id = 'ccl-a';
  IF FOUND THEN RAISE EXCEPTION 'vazamento: UPDATE cruzado aceito'; END IF;
  DELETE FROM fdp_psychology_sessions WHERE id = 'ps-1';
  IF FOUND THEN RAISE EXCEPTION 'vazamento: DELETE cruzado aceito'; END IF;
  RAISE NOTICE 'OK isolamento multi-tenant nas tabelas de pagamento';
END;
$$;
-- Nem escrever com workspace_id forjado.
SELECT expect_error($$INSERT INTO fdp_psychology_adjustments (id, workspace_id, closing_id, kind, amount, reason, created_by)
  VALUES ('adj-x','ws-a','pcl-a','discount',10,'tentativa cruzada','u2')$$, 'row-level security');

-- Sem contexto de tenant, nada é visível.
SELECT set_config('app.workspace_id', '', false);
DO $$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM fdp_contractor_closings;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: leitura sem contexto de tenant'; END IF;
  RAISE NOTICE 'OK negado sem contexto de tenant';
END;
$$;
\echo TODAS AS VERIFICACOES PASSARAM

RESET ROLE;
REVOKE fdp_rehearsal_app FROM CURRENT_USER;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fdp_rehearsal_app;
REVOKE USAGE ON SCHEMA public FROM fdp_rehearsal_app;
DROP ROLE fdp_rehearsal_app;
DROP FUNCTION expect_error(text, text);
