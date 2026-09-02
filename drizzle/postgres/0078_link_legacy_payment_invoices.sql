-- Recupera as notas que já haviam sido registradas pela tela de Pagamentos
-- antes de existir o cadastro versionado de Notas Fiscais.
--
-- A 0077 classificou esses fechamentos como "recebidos", mas não criou a linha
-- correspondente em fdp_contractor_invoices. Como a nova tela lê essa entidade,
-- o arquivo continuava no contrato e sumia de Notas Fiscais. Esta migração cria
-- o registro faltante, reaproveita o mesmo documento e aponta o fechamento para
-- ele. Nenhum binário é copiado: as duas telas passam a enxergar a mesma linha.
SELECT pg_advisory_xact_lock(hashtext('0078_link_legacy_payment_invoices'));
--> statement-breakpoint

WITH legacy AS (
  SELECT
    c.*,
    'legacy-invoice:' || md5(c.workspace_id || ':' || c.id) AS legacy_invoice_id,
    document.id AS legacy_document_id,
    document.created_by AS document_created_by,
    document.created_at AS document_created_at,
    provider.tax_id AS provider_document
  FROM fdp_contractor_closings c
  JOIN fdp_auxiliary_providers provider
    ON provider.workspace_id = c.workspace_id AND provider.id = c.provider_id
  LEFT JOIN LATERAL (
    SELECT d.id, d.created_by, d.created_at
    FROM fdp_contractor_documents d
    WHERE d.workspace_id = c.workspace_id
      AND d.closing_id = c.id
      AND d.document_kind = 'invoice'
    ORDER BY
      CASE WHEN d.id = c.invoice_attachment_reference THEN 0 ELSE 1 END,
      d.created_at DESC,
      d.id DESC
    LIMIT 1
  ) document ON true
  WHERE c.invoice_current_id IS NULL
    AND trim(c.invoice_number) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM fdp_contractor_invoices current_invoice
      WHERE current_invoice.workspace_id = c.workspace_id
        AND current_invoice.closing_id = c.id
        AND current_invoice.superseded_at IS NULL
    )
), inserted AS (
  INSERT INTO fdp_contractor_invoices (
    id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id,
    competence, attempt, invoice_number, series, issue_date, issuer_document,
    issuer_name, receiver_document, service_description, amount, expected_amount,
    difference_amount, status, document_id, notes, duplicate_ack, uploaded_by,
    uploaded_at, uploaded_ip, uploaded_user_agent
  )
  SELECT
    legacy_invoice_id, workspace_id, company_id, provider_id, payroll_cycle_id, id,
    competence, 1, trim(invoice_number), '',
    COALESCE(invoice_issue_date, document_created_at::date, updated_at::date, created_at::date),
    regexp_replace(COALESCE(provider_document, ''), '[^0-9]', '', 'g'),
    '', '', '', invoice_received_amount, invoice_expected_amount,
    invoice_received_amount - invoice_expected_amount, 'received', legacy_document_id,
    'Importada do registro histórico de Pagamentos.', false,
    COALESCE(document_created_by, created_by),
    COALESCE(document_created_at, updated_at, created_at), '', 'legacy-payment-backfill'
  FROM legacy
  ON CONFLICT DO NOTHING
  RETURNING id, workspace_id, closing_id, provider_id, competence, invoice_number,
    amount, expected_amount, document_id, uploaded_by, uploaded_at
)
INSERT INTO fdp_contractor_invoice_events (
  id, workspace_id, invoice_id, closing_id, provider_id, competence, action,
  actor_user_id, summary, before_json, after_json, created_at
)
SELECT
  'legacy-invoice-event:' || md5(workspace_id || ':' || closing_id),
  workspace_id, id, closing_id, provider_id, competence, 'uploaded', uploaded_by,
  'NF ' || invoice_number || ' recuperada do histórico de Pagamentos.',
  '{}'::jsonb,
  jsonb_build_object(
    'origin', 'payments_legacy_backfill',
    'amount', amount,
    'expectedAmount', expected_amount,
    'documentId', document_id
  ),
  uploaded_at
FROM inserted
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Repara também uma eventual nota já criada sem o document_id enquanto o
-- fechamento ainda guardava a referência do anexo antigo.
UPDATE fdp_contractor_invoices invoice
SET document_id = document.id, updated_at = now()
FROM fdp_contractor_closings closing
JOIN LATERAL (
  SELECT d.id
  FROM fdp_contractor_documents d
  WHERE d.workspace_id = closing.workspace_id
    AND d.closing_id = closing.id
    AND d.document_kind = 'invoice'
  ORDER BY
    CASE WHEN d.id = closing.invoice_attachment_reference THEN 0 ELSE 1 END,
    d.created_at DESC,
    d.id DESC
  LIMIT 1
) document ON true
WHERE invoice.workspace_id = closing.workspace_id
  AND invoice.id = closing.invoice_current_id
  AND invoice.document_id IS NULL;
--> statement-breakpoint

UPDATE fdp_contractor_closings closing
SET
  invoice_current_id = invoice.id,
  invoice_attachment_reference = COALESCE(invoice.document_id, closing.invoice_attachment_reference),
  invoice_review_status = 'received',
  updated_at = now()
FROM fdp_contractor_invoices invoice
WHERE invoice.workspace_id = closing.workspace_id
  AND invoice.closing_id = closing.id
  AND invoice.superseded_at IS NULL
  AND closing.invoice_current_id IS NULL;
