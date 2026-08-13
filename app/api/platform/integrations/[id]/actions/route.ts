import { getD1, getPlatformScopedD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { queueIntegrationRun } from "@/lib/integration-engine";
import { credentialPublicHint, mappingDirection, mappingResource, publicCredentialFingerprint, sanitizeMapping, sealCredentials } from "@/lib/integrations";
import { queueSankhyaRun } from "@/lib/sankhya/queue";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { requiredPlatformReason, sanitizePlatformValue } from "@/lib/platform-console";
import { cleanText } from "@/lib/registrations";

type Params = { params: Promise<{ id: string }> };
type Row = Record<string, unknown>;
const actions = new Set(["run", "retry", "pause", "resume", "revoke_credential", "rotate_credential", "create_mapping", "publish_mapping", "resolve_reconciliation"]);
const truthy = (value: unknown) => value === true || value === 1 || value === "1" || value === "t" || value === "true";

export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const workspaceId = cleanText(body.workspaceId, 120);
    const action = cleanText(body.action, 40);
    const reason = requiredPlatformReason(body.reason);
    if (!workspaceId || !actions.has(action)) throw ApiError.badRequest("Ação global de integração inválida.", "PLATFORM_INTEGRATION_ACTION_INVALID");
    if (body.confirmed !== true) throw ApiError.badRequest("Confirme explicitamente a ação administrativa.", "PLATFORM_CONFIRMATION_REQUIRED");

    return await withPlatformContext(platform, async () => {
      const global = getD1();
      const workspace = await global.prepare("SELECT id, name, owner_user_id FROM fdp_workspaces WHERE id = ?")
        .bind(workspaceId).first<{ id: string; name: string; owner_user_id: string }>();
      if (!workspace) throw ApiError.badRequest("Workspace informado não existe.", "WORKSPACE_NOT_FOUND");
      const scoped = getPlatformScopedD1({ workspaceId, userId: platform.userId });
      const integration = await scoped.prepare("SELECT id, channel, display_name, status FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
        .bind(workspaceId, id).first<Row>();
      if (!integration) throw ApiError.notFound("Integração não encontrada neste workspace.", "INTEGRATION_NOT_FOUND");
      if (["revoke_credential", "rotate_credential"].includes(action) && cleanText(body.confirmation, 160) !== String(integration.display_name)) {
        throw ApiError.badRequest(`Digite exatamente “${integration.display_name}” para confirmar.`, "PLATFORM_CONFIRMATION_MISMATCH");
      }

      const requestId = request.headers.get("x-fila-dp-request-id") ?? crypto.randomUUID();
      let before: Record<string, unknown> = { workspaceId, status: integration.status, displayName: integration.display_name };
      let result: Record<string, unknown> = {};
      let auditEntityType = "integration";
      let auditEntityId = id;

      if (action === "run") {
        const idempotencyKey = cleanText(request.headers.get("idempotency-key"), 180) || `platform:${crypto.randomUUID()}`;
        const run = integration.channel === "sankhya_browser"
          ? await queueSankhyaRun(scoped, { workspaceId, integrationId: id, triggerType: "manual", requestedBy: null, idempotencyKey })
          : await queueIntegrationRun(scoped, { workspaceId, integrationId: id, mappingId: cleanText(body.mappingId, 120) || undefined,
            triggerType: "manual", requestedBy: null, idempotencyKey });
        result = { runId: run.id, status: run.status };
      } else if (action === "retry") {
        const runId = cleanText(body.runId, 120);
        const failed = await scoped.prepare(`SELECT id, mapping_id, status FROM fdp_integration_sync_runs
          WHERE workspace_id = ? AND integration_id = ? AND id = ? AND status IN ('failed', 'partial', 'canceled')`)
          .bind(workspaceId, id, runId).first<Row>();
        if (!failed) throw new ApiError(409, "RUN_NOT_RETRYABLE", "A execução não está em um estado que permita retry controlado.");
        const idempotencyKey = cleanText(request.headers.get("idempotency-key"), 180) || `retry:${runId}:${crypto.randomUUID()}`;
        const retry = integration.channel === "sankhya_browser"
          ? await queueSankhyaRun(scoped, { workspaceId, integrationId: id, triggerType: "retry", requestedBy: null, idempotencyKey })
          : await queueIntegrationRun(scoped, { workspaceId, integrationId: id, mappingId: String(failed.mapping_id ?? "") || undefined,
            triggerType: "retry", requestedBy: null, idempotencyKey });
        result = { runId: retry.id, retryOf: runId, status: retry.status };
      } else if (action === "pause") {
        await scoped.prepare("UPDATE fdp_integrations SET status = 'paused', updated_at = now() WHERE workspace_id = ? AND id = ?")
          .bind(workspaceId, id).run();
        result = { status: "paused" };
      } else if (action === "resume") {
        const ready = await scoped.prepare(`SELECT
            EXISTS (SELECT 1 FROM fdp_integration_credentials WHERE workspace_id = ? AND integration_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > now())) AS credential,
            EXISTS (SELECT 1 FROM fdp_integration_mappings WHERE workspace_id = ? AND integration_id = ? AND status = 'active') AS mapping`)
          .bind(workspaceId, id, workspaceId, id).first<{ credential: boolean; mapping: boolean }>();
        if (!truthy(ready?.credential) || (integration.channel !== "sankhya_browser" && !truthy(ready?.mapping))) {
          throw new ApiError(409, "INTEGRATION_NOT_READY", "Credencial ativa e configuração válida são obrigatórias para reativar.");
        }
        await scoped.prepare("UPDATE fdp_integrations SET status = 'connected', last_error = NULL, updated_at = now() WHERE workspace_id = ? AND id = ?")
          .bind(workspaceId, id).run();
        result = { status: "connected" };
      } else if (action === "revoke_credential") {
        await scoped.batch([
          scoped.prepare("UPDATE fdp_integration_credentials SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE workspace_id = ? AND integration_id = ? AND status = 'active'").bind(workspaceId, id),
          scoped.prepare("UPDATE fdp_integrations SET status = 'needs_credentials', last_error = NULL, updated_at = now() WHERE workspace_id = ? AND id = ?").bind(workspaceId, id),
        ]);
        result = { status: "needs_credentials", credential: "revoked" };
      } else if (action === "rotate_credential") {
        const sealed = sealCredentials(integration.channel, body.credentials);
        const publicHint = credentialPublicHint(String(integration.channel), body.credentials);
        const expiresAt = typeof body.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/u.test(body.expiresAt) ? body.expiresAt : null;
        const credentialId = crypto.randomUUID();
        // A FK composta é preservada: o proprietário é o custodiante do envelope;
        // o ator real permanece na auditoria global e na auditoria do workspace.
        await scoped.batch([
          scoped.prepare("UPDATE fdp_integration_credentials SET status = 'revoked', revoked_at = now(), rotated_at = now(), updated_at = now() WHERE workspace_id = ? AND integration_id = ? AND status = 'active'").bind(workspaceId, id),
          scoped.prepare(`INSERT INTO fdp_integration_credentials
            (id, workspace_id, integration_id, credential_type, encrypted_value, initialization_vector, auth_tag, key_version, fingerprint, public_hint, expires_at, created_by)
            VALUES (?, ?, ?, 'provider_auth', ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(credentialId, workspaceId, id, sealed.encryptedValue, sealed.initializationVector, sealed.authTag, sealed.keyVersion, sealed.fingerprint, publicHint, expiresAt, workspace.owner_user_id),
          scoped.prepare("UPDATE fdp_integrations SET status = 'needs_credentials', last_error = NULL, updated_at = now() WHERE workspace_id = ? AND id = ?").bind(workspaceId, id),
        ]);
        result = { credentialId, status: "needs_credentials", verified: false, keyVersion: sealed.keyVersion, fingerprint: publicCredentialFingerprint(sealed.fingerprint), expiresAt };
      } else if (action === "create_mapping") {
        const resourceType = mappingResource(body.resourceType);
        const direction = mappingDirection(body.direction);
        const { mapping, checksum } = sanitizeMapping(body.mapping);
        const current = await scoped.prepare(`SELECT COALESCE(MAX(version), 0)::integer AS version FROM fdp_integration_mappings
          WHERE workspace_id = ? AND integration_id = ? AND resource_type = ? AND direction = ?`)
          .bind(workspaceId, id, resourceType, direction).first<{ version: number }>();
        const version = Number(current?.version ?? 0) + 1;
        const mappingId = crypto.randomUUID();
        await scoped.prepare(`INSERT INTO fdp_integration_mappings
          (id, workspace_id, integration_id, resource_type, direction, version, mapping_json, checksum, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`)
          .bind(mappingId, workspaceId, id, resourceType, direction, version, JSON.stringify(mapping), checksum, workspace.owner_user_id).run();
        before = { workspaceId, integrationId: id, resourceType, direction, previousVersion: Number(current?.version ?? 0) };
        result = { mappingId, resourceType, direction, version, status: "draft", checksum, mappedFields: mapping.fields.map((field) => field.target) };
        auditEntityType = "integration_mapping";
        auditEntityId = mappingId;
      } else if (action === "publish_mapping") {
        const mappingId = cleanText(body.mappingId, 120);
        if (!mappingId) throw ApiError.badRequest("Informe o mapeamento em rascunho.", "MAPPING_ID_REQUIRED");
        const draft = await scoped.prepare(`SELECT id, resource_type, direction, version, status, checksum FROM fdp_integration_mappings
          WHERE workspace_id = ? AND integration_id = ? AND id = ?`).bind(workspaceId, id, mappingId).first<Row>();
        if (!draft || draft.status !== "draft") throw ApiError.notFound("Mapeamento em rascunho nÃ£o encontrado.", "MAPPING_DRAFT_NOT_FOUND");
        const published = await scoped.prepare(`WITH target AS (
            SELECT id, resource_type, direction FROM fdp_integration_mappings
            WHERE workspace_id = ? AND integration_id = ? AND id = ? AND status = 'draft'
          ), archived AS (
            UPDATE fdp_integration_mappings mapping SET status = 'archived', updated_at = CURRENT_TIMESTAMP
            FROM target WHERE mapping.workspace_id = ? AND mapping.integration_id = ? AND mapping.status = 'active'
              AND mapping.resource_type = target.resource_type AND mapping.direction = target.direction RETURNING mapping.id
          ) UPDATE fdp_integration_mappings mapping
            SET status = 'active', published_at = CURRENT_TIMESTAMP, published_by = ?, updated_at = CURRENT_TIMESTAMP
            FROM target WHERE mapping.id = target.id AND (SELECT COUNT(*) FROM archived) >= 0
            RETURNING mapping.id, mapping.resource_type, mapping.direction, mapping.version, mapping.status, mapping.checksum, mapping.published_at`)
          .bind(workspaceId, id, mappingId, workspaceId, id, workspace.owner_user_id).first<Row>();
        if (!published) throw ApiError.notFound("Mapeamento em rascunho nÃ£o encontrado.", "MAPPING_DRAFT_NOT_FOUND");
        before = sanitizePlatformValue({ workspaceId, integrationId: id, ...draft }) as Record<string, unknown>;
        result = sanitizePlatformValue(published) as Record<string, unknown>;
        auditEntityType = "integration_mapping";
        auditEntityId = mappingId;
      } else if (action === "resolve_reconciliation") {
        const reconciliationId = cleanText(body.reconciliationId, 120);
        const resolution = cleanText(body.resolution, 40);
        const note = cleanText(body.note, 500);
        const internalId = resolution === "link" ? cleanText(body.internalId, 160) : "";
        if (!reconciliationId || !["link", "accept_external", "keep_internal", "ignore"].includes(resolution)) {
          throw ApiError.badRequest("ResoluÃ§Ã£o de conciliaÃ§Ã£o invÃ¡lida.", "RECONCILIATION_RESOLUTION_INVALID");
        }
        if (!note) throw ApiError.badRequest("Registre uma justificativa para a conciliaÃ§Ã£o.", "RECONCILIATION_NOTE_REQUIRED");
        if (resolution === "link" && !internalId) throw ApiError.badRequest("Informe o registro interno que serÃ¡ vinculado.", "RECONCILIATION_INTERNAL_ID_REQUIRED");
        const pending = await scoped.prepare(`SELECT id, status, entity_type, run_id FROM fdp_integration_reconciliations
          WHERE workspace_id = ? AND integration_id = ? AND id = ?`).bind(workspaceId, id, reconciliationId).first<Row>();
        if (!pending || !["unmatched", "conflict"].includes(String(pending.status))) {
          throw ApiError.notFound("ConciliaÃ§Ã£o pendente nÃ£o encontrada.", "RECONCILIATION_NOT_FOUND");
        }
        const resolved = await scoped.prepare(`WITH updated AS (
            UPDATE fdp_integration_reconciliations
              SET status = CASE WHEN ? = 'ignore' THEN 'ignored' ELSE 'resolved' END,
                resolution = ?, resolution_note = ?, internal_id = CASE WHEN ? <> '' THEN ? ELSE internal_id END,
                resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE workspace_id = ? AND integration_id = ? AND id = ? AND status IN ('unmatched', 'conflict') RETURNING *
          ), item_updated AS (
            UPDATE fdp_integration_sync_items item
              SET status = CASE WHEN updated.status = 'ignored' THEN 'skipped' ELSE 'processed' END,
                target_id = CASE WHEN updated.internal_id <> '' THEN updated.internal_id ELSE item.target_id END,
                processed_at = CURRENT_TIMESTAMP
            FROM updated WHERE item.workspace_id = updated.workspace_id AND item.id = updated.item_id RETURNING item.id
          ) SELECT id, status, resolution, resolved_at, (internal_id <> '') AS internal_id_provided FROM updated`)
          .bind(resolution, resolution, note, internalId, internalId, workspace.owner_user_id, workspaceId, id, reconciliationId).first<Row>();
        if (!resolved) throw ApiError.notFound("ConciliaÃ§Ã£o pendente nÃ£o encontrada.", "RECONCILIATION_NOT_FOUND");
        before = sanitizePlatformValue({ workspaceId, integrationId: id, ...pending }) as Record<string, unknown>;
        result = sanitizePlatformValue({ ...resolved, noteProvided: true, differencesOmitted: true }) as Record<string, unknown>;
        auditEntityType = "integration_reconciliation";
        auditEntityId = reconciliationId;
      }

      const after = sanitizePlatformValue({ workspaceId, workspaceName: workspace.name, action, reason, ...result });
      await scoped.batch([
        scoped.prepare(`INSERT INTO fdp_audit_events
          (id, workspace_id, actor_type, actor_user_id, actor_email, action, outcome, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
          VALUES (?, ?, 'user', ?, ?, ?, 'success', ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?)`)
          .bind(crypto.randomUUID(), workspaceId, platform.userId, platform.email, `platform.integration.${action}`, auditEntityType, auditEntityId,
            JSON.stringify(before), JSON.stringify(after), JSON.stringify({ reason, platformAction: true }), requestId),
        scoped.prepare(`INSERT INTO fdp_platform_audit_events
          (id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)`)
          .bind(crypto.randomUUID(), platform.userId, platform.email, `platform.integration.${action}`, auditEntityType, auditEntityId,
            JSON.stringify(before), JSON.stringify(after), requestId),
      ]);
      return Response.json({ action, integrationId: id, workspaceId, result }, { status: action === "run" || action === "retry" ? 202 : 200 });
    });
  } catch (error) { return apiError(error); }
}
