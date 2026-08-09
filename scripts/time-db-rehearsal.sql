-- Ensaio da conferência de ponto (§28) e da regra do §22 contra PostgreSQL real.
--
-- Verifica o que teste de unidade não alcança: o CHECK que torna "valor" um
-- destino inexpressável, o congelamento da folha exportada, a imutabilidade do
-- lote de exportação e o isolamento multi-tenant sob RLS com papel sem
-- superusuário.
--
-- Roda depois de payments-db-rehearsal.sql e reaproveita a semente daquele
-- ensaio (ws-a, co-a, emp-a, cy-a).
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

-- §22: rubrica de destino aceita quantidade, referência e índice.
INSERT INTO fdp_hour_event_mappings (id, workspace_id, company_id, destination, event_code, rubric_code, target_field, unit, created_by)
VALUES
  ('map-ot','ws-a','co-a','folha','overtime_50','0910','quantity','hours_decimal','u1'),
  ('map-nt','ws-a','co-a','folha','night_hours','0920','reference','hours_minutes','u1'),
  ('map-lt','ws-a','co-a','folha','late_hours','0930','index','minutes','u1');

-- E recusa "valor" no banco, não só na aplicação.
SELECT expect_error($$INSERT INTO fdp_hour_event_mappings (id, workspace_id, company_id, destination, event_code, rubric_code, target_field, unit, created_by)
  VALUES ('map-bad','ws-a','co-a','folha','absence_hours','0940','value','hours_decimal','u1')$$, 'fdp_hour_event_mappings_target_check');
SELECT expect_error($$UPDATE fdp_hour_event_mappings SET target_field = 'valor' WHERE id = 'map-ot'$$, 'fdp_hour_event_mappings_target_check');
SELECT expect_error($$INSERT INTO fdp_hour_event_mappings (id, workspace_id, company_id, destination, event_code, rubric_code, target_field, unit, created_by)
  VALUES ('map-dup','ws-a','co-a','folha','overtime_50','0911','quantity','minutes','u1')$$, 'fdp_hour_event_mappings_scope_event_uq');

-- Folha de ponto da competência.
INSERT INTO fdp_time_sheets (id, workspace_id, company_id, employee_id, payroll_cycle_id, competence, status, source,
    entries_count, worked_minutes, expected_minutes, balance_minutes, calc_version, created_by)
  VALUES ('ts-a','ws-a','co-a','emp-a','cy-a','2026-08','draft','import',3,1560,1440,120,'time-tracking-1.0.0','u1');

-- O saldo é derivado: não existe caminho para gravar saldo inventado.
SELECT expect_error($$INSERT INTO fdp_time_sheets (id, workspace_id, company_id, employee_id, payroll_cycle_id, competence,
    worked_minutes, expected_minutes, balance_minutes, calc_version, created_by)
  VALUES ('ts-bad','ws-a','co-a','emp-a','cy-a','2026-08',480,480,999,'v','u1')$$, 'fdp_time_sheets_balance_check');

INSERT INTO fdp_time_entries (id, workspace_id, company_id, time_sheet_id, employee_id, entry_date, day_type,
    expected_minutes, worked_minutes, night_minutes, balance_minutes, punches_json, origin, created_by)
VALUES
  ('te-1','ws-a','co-a','ts-a','emp-a','2026-08-03','regular',480,480,0,0,'[{"in":"08:00","out":"12:00"},{"in":"13:00","out":"17:00"}]','import','u1'),
  ('te-2','ws-a','co-a','ts-a','emp-a','2026-08-04','regular',480,600,0,120,'[{"in":"08:00","out":"12:00"},{"in":"13:00","out":"19:00"}]','import','u1'),
  ('te-3','ws-a','co-a','ts-a','emp-a','2026-08-05','regular',480,480,0,0,'[{"in":"08:00","out":"12:00"},{"in":"13:00","out":"17:00"}]','import','u1');

-- Marcação noturna não pode passar do total trabalhado, e o dia não passa de 24h.
SELECT expect_error($$INSERT INTO fdp_time_entries (id, workspace_id, company_id, time_sheet_id, employee_id, entry_date, day_type,
    expected_minutes, worked_minutes, night_minutes, balance_minutes, created_by)
  VALUES ('te-bad','ws-a','co-a','ts-a','emp-a','2026-08-06','regular',480,60,120,-420,'u1')$$, 'fdp_time_entries_night_check');
SELECT expect_error($$INSERT INTO fdp_time_entries (id, workspace_id, company_id, time_sheet_id, employee_id, entry_date, day_type,
    expected_minutes, worked_minutes, night_minutes, balance_minutes, created_by)
  VALUES ('te-bad2','ws-a','co-a','ts-a','emp-a','2026-08-07','regular',480,1500,0,1020,'u1')$$, 'fdp_time_entries_minutes_check');
SELECT expect_error($$INSERT INTO fdp_time_entries (id, workspace_id, company_id, time_sheet_id, employee_id, entry_date, day_type,
    expected_minutes, worked_minutes, night_minutes, balance_minutes, created_by)
  VALUES ('te-dup','ws-a','co-a','ts-a','emp-a','2026-08-03','regular',480,480,0,0,'u1')$$, 'fdp_time_entries_sheet_date_uq');

-- Evento apurado e evento manual: o manual exige justificativa.
INSERT INTO fdp_time_sheet_events (id, workspace_id, time_sheet_id, event_code, minutes, source, created_by)
  VALUES ('tev-1','ws-a','ts-a','overtime_50',120,'computed','u1');
SELECT expect_error($$INSERT INTO fdp_time_sheet_events (id, workspace_id, time_sheet_id, event_code, minutes, source, created_by)
  VALUES ('tev-bad','ws-a','ts-a','on_call_hours',60,'manual','u1')$$, 'fdp_time_sheet_events_justification_check');
INSERT INTO fdp_time_sheet_events (id, workspace_id, time_sheet_id, event_code, minutes, source, justification, created_by)
  VALUES ('tev-2','ws-a','ts-a','on_call_hours',60,'manual','Sobreaviso previsto em escala','u1');

-- Inconsistência: tratar exige nota, e o mesmo problema não entra duas vezes.
INSERT INTO fdp_time_inconsistencies (id, workspace_id, time_sheet_id, entry_date, kind, severity, detail)
  VALUES ('ti-1','ws-a','ts-a','2026-08-04','overtime_without_justification','warning','02:00 de hora extra sem justificativa');
SELECT expect_error($$INSERT INTO fdp_time_inconsistencies (id, workspace_id, time_sheet_id, entry_date, kind, severity, detail)
  VALUES ('ti-dup','ws-a','ts-a','2026-08-04','overtime_without_justification','warning','repetida')$$, 'fdp_time_inconsistencies_sheet_kind_uq');
SELECT expect_error($$UPDATE fdp_time_inconsistencies SET status = 'resolved' WHERE id = 'ti-1'$$, 'fdp_time_inconsistencies_resolution_check');
UPDATE fdp_time_inconsistencies SET status = 'waived', resolution_note = 'Hora extra autorizada pelo gestor em 04/08', resolved_by = 'u1', resolved_at = now()
  WHERE id = 'ti-1';

-- Aprovar exige aprovador registrado.
SELECT expect_error($$UPDATE fdp_time_sheets SET status = 'approved' WHERE id = 'ts-a'$$, 'fdp_time_sheets_approved_check');
UPDATE fdp_time_sheets SET status = 'review' WHERE id = 'ts-a';
UPDATE fdp_time_sheets SET status = 'approved', approved_by = 'u1', approved_at = now() WHERE id = 'ts-a';

-- Exportar exige lote: não existe folha exportada sem o registro do que saiu.
SELECT expect_error($$UPDATE fdp_time_sheets SET status = 'exported', exported_at = now() WHERE id = 'ts-a'$$, 'fdp_time_sheets_export_check');
-- Um lote sem nenhuma linha também é recusado.
SELECT expect_error($$INSERT INTO fdp_time_exports (id, workspace_id, company_id, payroll_cycle_id, competence, destination, checksum, created_by)
  VALUES ('tx-bad','ws-a','co-a','cy-a','2026-08','folha','abc','u1')$$, 'fdp_time_exports_count_check');

INSERT INTO fdp_time_exports (id, workspace_id, company_id, payroll_cycle_id, competence, destination, status,
    sheets_count, lines_count, checksum, payload_json, created_by)
  VALUES ('tx-1','ws-a','co-a','cy-a','2026-08','folha','prepared',1,2,'checksum-1','[{"sheetId":"ts-a"}]','u1');
UPDATE fdp_time_sheets SET status = 'exported', export_id = 'tx-1', exported_at = now() WHERE id = 'ts-a';

-- Folha exportada congela: totais, marcações e eventos ficam como saíram.
SELECT expect_error($$UPDATE fdp_time_sheets SET worked_minutes = 60, balance_minutes = -1380 WHERE id = 'ts-a'$$, 'exported time sheet is immutable');
SELECT expect_error($$UPDATE fdp_time_entries SET worked_minutes = 60, balance_minutes = -420 WHERE id = 'te-1'$$, 'entry of an exported time sheet is immutable');
SELECT expect_error($$DELETE FROM fdp_time_entries WHERE id = 'te-1'$$, 'entry of an exported time sheet is immutable');
SELECT expect_error($$UPDATE fdp_time_sheet_events SET minutes = 999 WHERE id = 'tev-1'$$, 'entry of an exported time sheet is immutable');
SELECT expect_error($$UPDATE fdp_time_sheets SET status = 'draft' WHERE id = 'ts-a'$$, 'requires a justification');
SELECT expect_error($$DELETE FROM fdp_time_sheets WHERE id = 'ts-a'$$, 'exported time sheet is immutable');

-- O lote de exportação é registro do que saiu: só o estado de entrega muda.
SELECT expect_error($$UPDATE fdp_time_exports SET payload_json = '[]'::jsonb WHERE id = 'tx-1'$$, 'time export batches are append-only');
SELECT expect_error($$UPDATE fdp_time_exports SET checksum = 'outro' WHERE id = 'tx-1'$$, 'time export batches are append-only');
SELECT expect_error($$DELETE FROM fdp_time_exports WHERE id = 'tx-1'$$, 'time export batches are append-only');
UPDATE fdp_time_exports SET status = 'delivered' WHERE id = 'tx-1';

-- Fechar depois de exportar é permitido e grava o snapshot uma única vez.
UPDATE fdp_time_sheets SET status = 'closed', snapshot_json = '{"frozen":true}'::jsonb WHERE id = 'ts-a';
SELECT expect_error($$UPDATE fdp_time_sheets SET snapshot_json = '{}'::jsonb WHERE id = 'ts-a'$$, 'exported time sheet is immutable');

-- Reabrir é possível, mas só com justificativa registrada.
SELECT expect_error($$UPDATE fdp_time_sheets SET status = 'review', reopen_reason = 'ops' WHERE id = 'ts-a'$$, 'requires a justification');
UPDATE fdp_time_sheets SET status = 'review', reopen_reason = 'Marcacao do dia 04 corrigida pelo gestor' WHERE id = 'ts-a';

-- Isolamento multi-tenant com papel sem superusuário.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fdp_rehearsal_app') THEN
    CREATE ROLE fdp_rehearsal_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
  END IF;
END;
$role$;
GRANT USAGE ON SCHEMA public TO fdp_rehearsal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fdp_rehearsal_app;

SET ROLE fdp_rehearsal_app;
SELECT set_config('app.workspace_id', 'ws-b', false);
DO $$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM fdp_time_sheets WHERE id = 'ts-a';
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: folha de ponto de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_time_entries;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: marcação de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_hour_event_mappings;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: mapeamento de rubrica visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_time_exports;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: lote de exportação visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_time_inconsistencies;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: inconsistência visível'; END IF;
  UPDATE fdp_time_sheets SET status = 'draft' WHERE id = 'ts-a';
  IF FOUND THEN RAISE EXCEPTION 'vazamento: UPDATE cruzado aceito no ponto'; END IF;
  DELETE FROM fdp_time_entries WHERE id = 'te-1';
  IF FOUND THEN RAISE EXCEPTION 'vazamento: DELETE cruzado aceito no ponto'; END IF;
  RAISE NOTICE 'OK isolamento multi-tenant nas tabelas de ponto';
END;
$$;
SELECT expect_error($$INSERT INTO fdp_hour_event_mappings (id, workspace_id, company_id, destination, event_code, rubric_code, target_field, unit, created_by)
  VALUES ('map-x','ws-a','co-a','folha','absence_hours','0940','quantity','minutes','u2')$$, 'row-level security');

SELECT set_config('app.workspace_id', '', false);
DO $$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM fdp_time_sheets;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: ponto legível sem contexto de tenant'; END IF;
  RAISE NOTICE 'OK ponto negado sem contexto de tenant';
END;
$$;
\echo ENSAIO DO PONTO: TODAS AS VERIFICACOES PASSARAM

RESET ROLE;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fdp_rehearsal_app;
REVOKE USAGE ON SCHEMA public FROM fdp_rehearsal_app;
DROP FUNCTION expect_error(text, text);
