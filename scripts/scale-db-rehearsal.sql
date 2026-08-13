\set ON_ERROR_STOP on
-- Ensaio da Fase 9: outbox, entregas de webhook, chaves de API e idempotência.
CREATE OR REPLACE FUNCTION expect_error_scale(stmt text, fragment text) RETURNS void LANGUAGE plpgsql AS $$
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

SELECT set_config('app.workspace_id', 'ws-scale', false);
INSERT INTO fdp_users (id, email, name) VALUES ('su1','scale@a.com','S') ON CONFLICT DO NOTHING;
INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ('ws-scale','Scale','scale','su1');
INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('ws-scale','su1','admin');
SELECT set_config('app.workspace_id', 'ws-other', false);
INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ('ws-other','Other','other','su1');
INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('ws-other','su1','admin');

SELECT set_config('app.workspace_id', 'ws-scale', false);

-- Endpoint precisa ser HTTPS.
SELECT expect_error_scale($$INSERT INTO fdp_webhook_endpoints (id, workspace_id, name, url, secret_encrypted, secret_iv, secret_tag, created_by)
  VALUES ('ep-bad','ws-scale','Inseguro','http://cliente.com/hook','c','i','t','su1')$$, 'fdp_webhook_endpoints_url_check');

INSERT INTO fdp_webhook_endpoints (id, workspace_id, name, url, secret_encrypted, secret_iv, secret_tag, event_types_json, created_by)
  VALUES ('ep-1','ws-scale','Cliente','https://cliente.com.br/hook','cipher','iv','tag','["contractor_closing.closed"]'::jsonb,'su1');

-- Outbox: evento pendente, publicação idempotente e imutabilidade depois de publicado.
INSERT INTO fdp_domain_events (id, workspace_id, event_type, entity_type, entity_id, payload_json, request_id)
  VALUES ('evt-1','ws-scale','contractor_closing.closed','contractor_closing','ccl-1','{"competence":"2026-08","netAmount":8200}'::jsonb,'req-1');

INSERT INTO fdp_webhook_deliveries (id, workspace_id, endpoint_id, event_id, event_type)
  VALUES ('dlv-1','ws-scale','ep-1','evt-1','contractor_closing.closed');
-- Reprocessar o publicador não pode duplicar a entrega.
INSERT INTO fdp_webhook_deliveries (id, workspace_id, endpoint_id, event_id, event_type)
  VALUES ('dlv-2','ws-scale','ep-1','evt-1','contractor_closing.closed')
  ON CONFLICT (workspace_id, endpoint_id, event_id) DO NOTHING;
DO $$
DECLARE total int;
BEGIN
  SELECT count(*) INTO total FROM fdp_webhook_deliveries WHERE event_id = 'evt-1';
  IF total <> 1 THEN RAISE EXCEPTION 'entrega duplicada: % linhas', total; END IF;
  RAISE NOTICE 'OK entrega idempotente por (endpoint, evento)';
END;
$$;

UPDATE fdp_domain_events SET status = 'published', published_at = now(), deliveries_count = 1 WHERE id = 'evt-1';
SELECT expect_error_scale($$UPDATE fdp_domain_events SET payload_json = '{}'::jsonb WHERE id = 'evt-1'$$, 'published domain event is immutable');
SELECT expect_error_scale($$DELETE FROM fdp_domain_events WHERE id = 'evt-1'$$, 'domain events are append-only');

-- A reivindicação da entrega usa lease e SKIP LOCKED, como no executor.
DO $$
DECLARE claimed text;
BEGIN
  WITH candidate AS (
    SELECT id FROM fdp_webhook_deliveries
    WHERE workspace_id = 'ws-scale' AND status IN ('pending', 'failed') AND next_attempt_at <= now()
      AND (lease_expires_at IS NULL OR lease_expires_at < now())
    ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE fdp_webhook_deliveries d SET status = 'delivering', lease_token = 'lease-1',
    lease_expires_at = now() + interval '60 seconds', attempt = d.attempt + 1, updated_at = now()
  FROM candidate WHERE d.id = candidate.id AND d.workspace_id = 'ws-scale'
  RETURNING d.id INTO claimed;
  IF claimed IS NULL THEN RAISE EXCEPTION 'nenhuma entrega reivindicada'; END IF;
  RAISE NOTICE 'OK entrega reivindicada com lease: %', claimed;
END;
$$;

-- Um segundo executor não pega a mesma entrega enquanto o lease está válido.
DO $$
DECLARE claimed text;
BEGIN
  WITH candidate AS (
    SELECT id FROM fdp_webhook_deliveries
    WHERE workspace_id = 'ws-scale' AND status IN ('pending', 'failed') AND next_attempt_at <= now()
      AND (lease_expires_at IS NULL OR lease_expires_at < now())
    ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE fdp_webhook_deliveries d SET status = 'delivering', lease_token = 'lease-2', updated_at = now()
  FROM candidate WHERE d.id = candidate.id AND d.workspace_id = 'ws-scale'
  RETURNING d.id INTO claimed;
  IF claimed IS NOT NULL THEN RAISE EXCEPTION 'lease não protegeu a entrega'; END IF;
  RAISE NOTICE 'OK lease impede entrega concorrente';
END;
$$;

-- Falha reagenda; esgotar tentativas manda para a dead-letter.
UPDATE fdp_webhook_deliveries SET status = 'failed', error_code = 'HTTP_500', next_attempt_at = now() + interval '30 seconds',
  lease_token = '', lease_expires_at = NULL WHERE id = 'dlv-1';
UPDATE fdp_webhook_deliveries SET status = 'dead_letter', attempt = max_attempts WHERE id = 'dlv-1';
SELECT expect_error_scale($$UPDATE fdp_webhook_deliveries SET status = 'invalido' WHERE id = 'dlv-1'$$, 'fdp_webhook_deliveries_status_check');

-- Chave de API: hash único e limite dentro da faixa.
INSERT INTO fdp_api_keys (id, workspace_id, name, prefix, token_hash, scopes_json, created_by)
  VALUES ('key-1','ws-scale','ERP','fdp_abc123abc123','hash-1','["payments.write"]'::jsonb,'su1');
SELECT expect_error_scale($$INSERT INTO fdp_api_keys (id, workspace_id, name, prefix, token_hash, created_by)
  VALUES ('key-2','ws-scale','Outra','fdp_zzz','hash-1','su1')$$, 'fdp_api_keys_token_hash_uq');
SELECT expect_error_scale($$INSERT INTO fdp_api_keys (id, workspace_id, name, prefix, token_hash, rate_limit_per_minute, created_by)
  VALUES ('key-3','ws-scale','Excesso','fdp_yyy','hash-3',999999,'su1')$$, 'fdp_api_keys_rate_check');

-- Limite por minuto: incrementa na janela e reinicia depois dela.
INSERT INTO fdp_api_rate_limits (key_hash, window_started_at, request_count, updated_at) VALUES ('rate-1', now(), 1, now());
INSERT INTO fdp_api_rate_limits (key_hash, window_started_at, request_count, updated_at)
  VALUES ('rate-1', now(), 1, now())
  ON CONFLICT (key_hash) DO UPDATE SET
    window_started_at = CASE WHEN fdp_api_rate_limits.window_started_at < now() - (60 * interval '1 second') THEN now() ELSE fdp_api_rate_limits.window_started_at END,
    request_count = CASE WHEN fdp_api_rate_limits.window_started_at < now() - (60 * interval '1 second') THEN 1 ELSE fdp_api_rate_limits.request_count + 1 END,
    updated_at = now();
DO $$
DECLARE total int;
BEGIN
  SELECT request_count INTO total FROM fdp_api_rate_limits WHERE key_hash = 'rate-1';
  IF total <> 2 THEN RAISE EXCEPTION 'contador da janela errado: %', total; END IF;
  UPDATE fdp_api_rate_limits SET window_started_at = now() - interval '120 seconds' WHERE key_hash = 'rate-1';
  INSERT INTO fdp_api_rate_limits (key_hash, window_started_at, request_count, updated_at)
    VALUES ('rate-1', now(), 1, now())
    ON CONFLICT (key_hash) DO UPDATE SET
      window_started_at = CASE WHEN fdp_api_rate_limits.window_started_at < now() - (60 * interval '1 second') THEN now() ELSE fdp_api_rate_limits.window_started_at END,
      request_count = CASE WHEN fdp_api_rate_limits.window_started_at < now() - (60 * interval '1 second') THEN 1 ELSE fdp_api_rate_limits.request_count + 1 END,
      updated_at = now();
  SELECT request_count INTO total FROM fdp_api_rate_limits WHERE key_hash = 'rate-1';
  IF total <> 1 THEN RAISE EXCEPTION 'janela não reiniciou: %', total; END IF;
  RAISE NOTICE 'OK limite por janela conta e reinicia';
END;
$$;

-- Idempotência: a mesma chave não grava duas respostas.
INSERT INTO fdp_api_idempotency_records (id, workspace_id, api_key_id, idempotency_key, method, path, request_hash, response_status, response_body, expires_at)
  VALUES ('idem-1','ws-scale','key-1','chave-externa-1','POST','/api/v1/contractor-components','hash-req',201,'{"data":{}}', now() + interval '24 hours');
SELECT expect_error_scale($$INSERT INTO fdp_api_idempotency_records (id, workspace_id, api_key_id, idempotency_key, method, path, request_hash, expires_at)
  VALUES ('idem-2','ws-scale','key-1','chave-externa-1','POST','/api/v1/contractor-components','outro-hash', now() + interval '24 hours')$$,
  'fdp_api_idempotency_key_uq');

-- Isolamento multi-tenant com papel sem superusuário.
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
SELECT set_config('app.workspace_id', 'ws-other', false);
DO $$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM fdp_domain_events WHERE id = 'evt-1';
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: evento de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_webhook_endpoints;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: endpoint de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_webhook_deliveries;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: entrega de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_api_keys;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: chave de API de outro workspace visível'; END IF;
  SELECT count(*) INTO visible FROM fdp_api_idempotency_records;
  IF visible <> 0 THEN RAISE EXCEPTION 'vazamento: idempotência de outro workspace visível'; END IF;
  RAISE NOTICE 'OK isolamento multi-tenant nas tabelas de escala';
END;
$$;
RESET ROLE;
REVOKE fdp_rehearsal_app FROM CURRENT_USER;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fdp_rehearsal_app;
REVOKE USAGE ON SCHEMA public FROM fdp_rehearsal_app;
DROP ROLE fdp_rehearsal_app;
DROP FUNCTION expect_error_scale(text, text);
\echo ENSAIO DE ESCALA CONCLUIDO
