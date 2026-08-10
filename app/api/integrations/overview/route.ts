import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { publicCredentialFingerprint, safeIntegrationError } from "@/lib/integrations";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "integrations.status.read");
    const [connectors, mappings, runs, reconciliations, queue] = await Promise.all([
      d1.prepare(`SELECT i.id, i.channel, i.display_name, i.status, i.last_sync_at, i.last_error, i.updated_at,
          credential.id AS credential_id, credential.fingerprint, credential.key_version, credential.verified_at, credential.expires_at,
          (credential.id IS NOT NULL) AS has_credentials
        FROM fdp_integrations i
        LEFT JOIN LATERAL (
          SELECT id, fingerprint, key_version, verified_at, expires_at FROM fdp_integration_credentials
          WHERE workspace_id = i.workspace_id AND integration_id = i.id AND credential_type = 'provider_auth' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1
        ) credential ON TRUE
        WHERE i.workspace_id = ? ORDER BY i.display_name`).bind(workspace.id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, integration_id, resource_type, direction, version, status, checksum, published_at, created_at
        FROM fdp_integration_mappings WHERE workspace_id = ? ORDER BY integration_id, resource_type, version DESC`).bind(workspace.id).all(),
      d1.prepare(`SELECT r.id, r.integration_id, i.display_name, r.mapping_id, r.trigger_type, r.status, r.attempt,
          r.received_count, r.processed_count, r.skipped_count, r.conflict_count, r.failed_count,
          r.error_code, r.error_message, r.started_at, r.completed_at, r.created_at
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
    ]);
    return Response.json({
      connectors: connectors.results.map((row) => ({
        ...row,
        fingerprint: row.fingerprint ? publicCredentialFingerprint(String(row.fingerprint)) : "",
        last_error: hasCapability(workspace.role, "integrations.manage") && row.last_error
          ? safeIntegrationError(new Error(String(row.last_error))).message
          : row.last_error ? "O conector requer atenção administrativa." : null,
      })),
      mappings: mappings.results,
      runs: runs.results,
      reconciliations: hasCapability(workspace.role, "integrations.reconcile") ? reconciliations.results : [],
      queue: queue.results,
      permissions: {
        manage: hasCapability(workspace.role, "integrations.manage"),
        run: hasCapability(workspace.role, "integrations.run"),
        reconcile: hasCapability(workspace.role, "integrations.reconcile"),
      },
      solidesBoundary: "O conector usa o recurso oficial de colaboradores e abre a conciliação de quem já foi admitido; conectar continua exigindo autenticação e teste real, e os arquivos dos documentos permanecem na Sólides.",
    });
  } catch (error) { return apiError(error); }
}
