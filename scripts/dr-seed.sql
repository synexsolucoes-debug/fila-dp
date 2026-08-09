-- Semente do ensaio de restauração: dois clientes com dados de negócio reais o
-- suficiente para provar que o backup preserva conteúdo, relação e regra.
\set ON_ERROR_STOP on

SELECT set_config('app.workspace_id', 'dr-ws-a', false);
INSERT INTO fdp_users (id, email, name) VALUES ('dr-u1','a@dr.test','Cliente A'), ('dr-u2','b@dr.test','Cliente B');
INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ('dr-ws-a','Cliente A','cliente-a','dr-u1');
INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('dr-ws-a','dr-u1','admin');
INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id) VALUES ('dr-co-a','dr-ws-a','Empresa A LTDA','Empresa A','11111111000191');
INSERT INTO fdp_employees (id, workspace_id, company_id, registration_number, full_name, admission_date, created_by, updated_by)
  VALUES ('dr-emp-a','dr-ws-a','dr-co-a','0001','Colaborador A','2026-01-05','dr-u1','dr-u1');
INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
  VALUES ('dr-cy-a','dr-ws-a','dr-co-a','2026-08','open','dr-u1');
INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name)
  VALUES ('dr-psi-a','dr-ws-a','psychologist','PSI-A','Psicologa A'), ('dr-pj-a','dr-ws-a','contractor','PJ-A','Prestador A');
INSERT INTO fdp_psychologist_profiles (provider_id, workspace_id, default_session_amount, updated_by) VALUES ('dr-psi-a','dr-ws-a',100,'dr-u1');
INSERT INTO fdp_contractor_profiles (provider_id, workspace_id, company_id, base_amount, complement_method, updated_by)
  VALUES ('dr-pj-a','dr-ws-a','dr-co-a',6500,'caju_saldo_livre','dr-u1');

-- Fechamento PJ concluído: prova que o dado congelado sobrevive ao restore.
INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
    base_amount, credits_amount, debits_amount, net_amount, invoice_limit_amount, invoice_limit_source,
    invoice_expected_amount, complement_amount, complement_method, caju_amount, status, invoice_status,
    invoice_received_amount, complement_paid_amount, reconciliation_status, calc_version, snapshot_json, created_by)
  VALUES ('dr-ccl-1','dr-ws-a','dr-co-a','dr-pj-a','dr-cy-a','2026-08',6500,500,500,6500,6000,'workspace',
    6000,500,'caju_saldo_livre',500,'closed','validated',6000,500,'reconciled','contractor-payment-1.0.0',
    '{"frozen":true}'::jsonb,'dr-u1');

INSERT INTO fdp_psychology_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
    entries_count, sessions_count, employees_count, gross_amount, net_amount, calc_version, created_by)
  VALUES ('dr-pcl-1','dr-ws-a','dr-co-a','dr-psi-a','dr-cy-a','2026-08',1,3,1,300,300,'psychology-payment-1.0.0','dr-u1');
INSERT INTO fdp_psychology_sessions (id, workspace_id, company_id, provider_id, employee_id, payroll_cycle_id, closing_id,
    competence, session_date, session_quantity, unit_amount, total_amount, created_by)
  VALUES ('dr-ps-1','dr-ws-a','dr-co-a','dr-psi-a','dr-emp-a','dr-cy-a','dr-pcl-1','2026-08','2026-08-10',3,100,300,'dr-u1');

INSERT INTO fdp_audit_events (id, workspace_id, actor_type, actor_user_id, actor_email, action, entity_type, entity_id)
  VALUES ('dr-audit-1','dr-ws-a','user','dr-u1','a@dr.test','contractor_closing.closed','contractor_closing','dr-ccl-1');
INSERT INTO fdp_domain_events (id, workspace_id, event_type, entity_type, entity_id, payload_json, status)
  VALUES ('dr-evt-1','dr-ws-a','contractor_closing.closed','contractor_closing','dr-ccl-1','{"competence":"2026-08"}'::jsonb,'published');

-- Segundo cliente, para o teste de isolamento depois do restore.
SELECT set_config('app.workspace_id', 'dr-ws-b', false);
INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ('dr-ws-b','Cliente B','cliente-b','dr-u2');
INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('dr-ws-b','dr-u2','admin');
INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id) VALUES ('dr-co-b','dr-ws-b','Empresa B LTDA','Empresa B','22222222000191');

INSERT INTO fdp_marketing_leads (id, name, email, interest) VALUES ('dr-lead-1','Contato','c@dr.test','demonstracao');
