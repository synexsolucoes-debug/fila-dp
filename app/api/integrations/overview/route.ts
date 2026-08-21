import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { publicCredentialFingerprint, safeIntegrationError } from "@/lib/integrations";
import { parseSankhyaConfig } from "@/lib/sankhya/config";
import { isSankhyaWorkspaceEnabled } from "@/lib/sankhya/queue";

const sensitiveQueryKey = /token|password|secret|senha|chave|authorization|cookie|api.?key/iu;

function publicConnectorConfig(value: unknown) {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = typeof value === "string" ? JSON.parse(value) : value;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate as Record<string, unknown>;
  } catch { return {}; }

  const config: Record<string, unknown> = {};
  if (typeof parsed.endpoint === "string" && parsed.endpoint.length <= 500) {
    try {
      const endpoint = new URL(parsed.endpoint);
      const hasSensitiveQuery = [...endpoint.searchParams.keys()].some((key) => sensitiveQueryKey.test(key));
      if (endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !hasSensitiveQuery) config.endpoint = endpoint.toString();
    } catch { /* Configuração legada inválida não deve derrubar o overview. */ }
  }
  for (const key of ["accountReference", "admissionsSince", "boardId", "companyId", "tenantId", "teamId", "teamName", "channelId", "channelName"] as const) {
    if (typeof parsed[key] === "string" && parsed[key].length <= 160) config[key] = parsed[key];
  }
  const pageSize = Math.trunc(Number(parsed.pageSize) || 0);
  if (pageSize > 0) config.pageSize = Math.min(150, pageSize);
  if (parsed.automations && typeof parsed.automations === "object" && !Array.isArray(parsed.automations)) {
    config.automations = Object.fromEntries(
      ["admission", "termination", "warning", "role_change", "salary_change"]
        .map((key) => [key, (parsed.automations as Record<string, unknown>)[key] !== false]),
    );
  }
  return config;
}

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.status.read");
    const [connectors, mappings, runs, reconciliations, queue, sankhyaEnabled, companies] = await Promise.all([
      d1.prepare(`SELECT i.id, i.channel, i.display_name, i.status, i.config_json, i.last_sync_at, i.last_connection_at,
          i.last_successful_sync_at, i.next_sync_at, i.schedule_enabled, i.connector_version, i.last_error, i.updated_at,
          credential.id AS credential_id, credential.fingerprint, credential.public_hint, credential.key_version, credential.verified_at, credential.expires_at,
          (credential.id IS NOT NULL) AS has_credentials,
          EXISTS (SELECT 1 FROM fdp_integration_credentials webhook
            WHERE webhook.workspace_id = i.workspace_id AND webhook.integration_id = i.id
              AND webhook.credential_type = 'webhook_signing' AND webhook.status = 'active') AS has_webhook_secret
        FROM fdp_integrations i
        LEFT JOIN LATERAL (
          SELECT id, fingerprint, public_hint, key_version, verified_at, expires_at FROM fdp_integration_credentials
          WHERE workspace_id = i.workspace_id AND integration_id = i.id AND credential_type = 'provider_auth' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1
        ) credential ON TRUE
        WHERE i.workspace_id = ? ORDER BY i.display_name`).bind(workspace.id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, integration_id, resource_type, direction, version, status, checksum, published_at, created_at
        FROM fdp_integration_mappings WHERE workspace_id = ? ORDER BY integration_id, resource_type, version DESC`).bind(workspace.id).all(),
      d1.prepare(`SELECT r.id, r.integration_id, i.display_name, r.mapping_id, r.trigger_type, r.status, r.attempt,
          r.received_count, r.processed_count, r.skipped_count, r.conflict_count, r.failed_count, r.updated_count, r.unchanged_count,
          r.duration_ms, r.summary, r.error_code, r.error_message, r.started_at, r.completed_at, r.created_at
        FROM fdp_integration_sync_runs r JOIN fdp_integrations i ON i.workspace_id = r.workspace_id AND i.id = r.integration_id
        WHERE r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 60`).bind(workspace.id).all(),
      d1.prepare(`SELECT reconciliation.id, reconciliation.integration_id, reconciliation.run_id, reconciliation.entity_type,
          reconciliation.external_id, reconciliation.internal_id, reconciliation.status, reconciliation.differences_json,
          reconciliation.resolution, reconciliation.resolved_at, reconciliation.created_at, integration.display_name
        FROM fdp_integration_reconciliations reconciliation
        JOIN fdp_integrations integration ON integration.workspace_id = reconciliation.workspace_id AND integration.id = reconciliation.integration_id
        WHERE reconciliation.workspace_id = ? AND reconciliation.status IN ('unmatched', 'conflict')
        ORDER BY reconciliation.created_at DESC LIMIT 80`).bind(workspace.id).all(),
      d1.prepare(`SELECT status, COUNT(*)::integer AS count FROM fdp_integration_jobs WHERE workspace_id = ? GROUP BY status`).bind(workspace.id).all(),
      isSankhyaWorkspaceEnabled(d1, workspace.id),
      d1.prepare(`SELECT id, legal_name, trade_name FROM fdp_companies WHERE workspace_id = ? AND status = 'active'
        ORDER BY is_principal DESC, legal_name`).bind(workspace.id).all(),
    ]);
    const visibleConnectors = connectors.results.filter((row) => row.channel !== "sankhya_browser" || sankhyaEnabled);
    return Response.json({
      connectors: visibleConnectors.map((row) => ({
        ...row,
        config: row.channel === "sankhya_browser" ? parseSankhyaConfig(row.config_json) : publicConnectorConfig(row.config_json),
        config_json: undefined,
        fingerprint: row.fingerprint ? publicCredentialFingerprint(String(row.fingerprint)) : "",
        last_error: hasCapability(workspace, "integrations.manage") && row.last_error
          ? safeIntegrationError(new Error(String(row.last_error))).message
          : row.last_error ? "O conector requer atenção administrativa." : null,
      })),
      mappings: mappings.results,
      runs: runs.results,
      reconciliations: hasCapability(workspace, "integrations.reconcile") ? reconciliations.results : [],
      queue: queue.results,
      permissions: {
        manage: hasCapability(workspace, "integrations.manage"),
        run: hasCapability(workspace, "integrations.run"),
        reconcile: hasCapability(workspace, "integrations.reconcile"),
        view: hasCapability(workspace, "integrations.view"),
        credentialsManage: hasCapability(workspace, "integrations.credentials.manage"),
        execute: hasCapability(workspace, "integrations.execute"),
        logsView: hasCapability(workspace, "integrations.logs.view"),
      },
      sankhyaEnabled,
      companies: companies.results,
      solidesBoundary: "O conector usa o recurso oficial de colaboradores e abre a conciliação de quem já foi admitido; conectar continua exigindo autenticação e teste real, e os arquivos dos documentos permanecem na Sólides.",
    });
  } catch (error) { return apiError(error); }
}
