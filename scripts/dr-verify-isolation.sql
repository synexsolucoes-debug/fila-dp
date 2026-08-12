-- Depois do restore, o isolamento entre clientes precisa continuar valendo.
\set ON_ERROR_STOP on
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fdp_dr_app') THEN
    CREATE ROLE fdp_dr_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
  END IF;
END;
$role$;
GRANT fdp_dr_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO fdp_dr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fdp_dr_app;

SET ROLE fdp_dr_app;
SELECT set_config('app.workspace_id', 'dr-ws-b', false);
DO $$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM fdp_contractor_closings WHERE id = 'dr-ccl-1';
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento apos restore: fechamento de outro cliente visivel'; END IF;
  SELECT count(*) INTO visible FROM fdp_psychology_sessions;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento apos restore: consultas de outro cliente visiveis'; END IF;
  SELECT count(*) INTO visible FROM fdp_employees;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento apos restore: colaboradores de outro cliente visiveis'; END IF;
  SELECT count(*) INTO visible FROM fdp_marketing_leads;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento apos restore: contatos visiveis sem contexto de plataforma'; END IF;
  SELECT count(*) INTO visible FROM fdp_companies;
  IF visible <> 1 THEN RAISE EXCEPTION 'escopo errado apos restore: esperado 1 empresa propria, veio %', visible; END IF;
  RAISE NOTICE 'ISOLAMENTO_OK';
END;
$$;
RESET ROLE;
REVOKE fdp_dr_app FROM CURRENT_USER;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fdp_dr_app;
REVOKE USAGE ON SCHEMA public FROM fdp_dr_app;
DROP ROLE fdp_dr_app;
SELECT 'ISOLAMENTO_OK';
