import { getD1, getPlatformScopedD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { publicCredentialFingerprint } from "@/lib/integrations";
import { sanitizePlatformValue } from "@/lib/platform-console";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";

type Params = { params: Promise<{ id: string }> };
type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);
const safeError = (value: unknown) => sanitizePlatformValue(text(value).slice(0, 800));

export async function GET(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user); const { id } = await params;
    const workspaceId = cleanText(new URL(request.url).searchParams.get("workspaceId"), 120);
    if (!workspaceId) throw ApiError.badRequest("Informe o workspace da integração.", "WORKSPACE_REQUIRED");
    return await withPlatformContext(platform, async () => {
      const global = getD1();
      const workspace = await global.prepare("SELECT id, name, status FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first<Row>();
      if (!workspace) throw ApiError.notFound("Workspace não encontrado.", "WORKSPACE_NOT_FOUND");
      const scoped = getPlatformScopedD1({ workspaceId, userId: platform.userId });
      const [integration, credentials, mappings, runs, reconciliations, jobs, logs, diagnostics] = await Promise.all([
        scoped.prepare(`SELECT integration.id, integration.channel, integration.display_name, integration.status, integration.last_sync_at,
            integration.last_error, integration.created_at, company.id AS company_id, company.legal_name AS company_name
          FROM fdp_integrations integration LEFT JOIN fdp_companies company
            ON company.workspace_id = integration.workspace_id
            AND company.id = NULLIF(integration.config_json, '')::jsonb->>'companyId'
          WHERE integration.workspace_id = ? AND integration.id = ?`).bind(workspaceId, id).first<Row>(),
        scoped.prepare(`SELECT id, fingerprint, key_version, status, verified_at, expires_at, rotated_at, revoked_at, created_at
          FROM fdp_integration_credentials WHERE workspace_id = ? AND integration_id = ? ORDER BY created_at DESC LIMIT 20`).bind(workspaceId, id).all<Row>(),
        scoped.prepare(`SELECT id, resource_type, direction, version, status, checksum, published_at, created_at
          FROM fdp_integration_mappings WHERE workspace_id = ? AND integration_id = ? ORDER BY created_at DESC LIMIT 50`).bind(workspaceId, id).all<Row>(),
        scoped.prepare(`SELECT id, mapping_id, trigger_type, status, attempt, received_count, processed_count, skipped_count, conflict_count, failed_count,
            error_code, error_message AS error_summary, started_at, completed_at, created_at
          FROM fdp_integration_sync_runs WHERE workspace_id = ? AND integration_id = ? ORDER BY created_at DESC LIMIT 50`).bind(workspaceId, id).all<Row>(),
        scoped.prepare(`SELECT reconciliation.id, reconciliation.run_id, reconciliation.item_id, reconciliation.entity_type,
            reconciliation.status, reconciliation.resolution, reconciliation.internal_id, reconciliation.resolved_at, reconciliation.created_at,
            COALESCE(difference.key, '') AS difference_field
          FROM fdp_integration_reconciliations reconciliation
          LEFT JOIN LATERAL jsonb_object_keys(COALESCE(reconciliation.differences_json, '{}'::jsonb)) AS difference(key) ON true
          WHERE reconciliation.workspace_id = ? AND reconciliation.integration_id = ?
          ORDER BY reconciliation.created_at DESC LIMIT 100`).bind(workspaceId, id).all<Row>(),
        scoped.prepare(`SELECT status, count(*)::int AS total, max(updated_at) AS last_update
          FROM fdp_integration_jobs WHERE workspace_id = ? AND integration_id = ? GROUP BY status`).bind(workspaceId, id).all<Row>(),
        scoped.prepare(`SELECT id, run_id, sequence, level, phase, code, message, created_at
          FROM fdp_integration_run_logs WHERE workspace_id = ? AND integration_id = ?
          ORDER BY created_at DESC, sequence DESC LIMIT 200`).bind(workspaceId, id).all<Row>(),
        scoped.prepare(`SELECT id, run_id, kind, expires_at, created_at
          FROM fdp_integration_diagnostics WHERE workspace_id = ? AND integration_id = ? AND expires_at > CURRENT_TIMESTAMP
          ORDER BY created_at DESC LIMIT 20`).bind(workspaceId, id).all<Row>(),
      ]);
      if (!integration) throw ApiError.notFound("Integração não encontrada neste workspace.", "INTEGRATION_NOT_FOUND");
      const reconciliationMap = new Map<string, Row & { differenceFields: string[] }>();
      for (const row of reconciliations.results) {
        const key = text(row.id); const current = reconciliationMap.get(key) ?? { ...row, differenceFields: [] };
        if (text(row.difference_field)) current.differenceFields.push(text(row.difference_field));
        delete current.difference_field; reconciliationMap.set(key, current);
      }
      return Response.json(sanitizePlatformValue({
        workspace,
        integration: { ...integration, last_error: safeError(integration.last_error) },
        credentials: credentials.results.map((row) => ({ ...row, fingerprint: publicCredentialFingerprint(text(row.fingerprint)) })),
        mappings: mappings.results,
        runs: runs.results.map((row) => ({ ...row, error_summary: safeError(row.error_summary) })),
        reconciliations: [...reconciliationMap.values()],
        jobs: jobs.results,
        logs: logs.results,
        diagnostics: diagnostics.results.map((row) => ({ ...row,
          url: `/api/platform/integrations/${encodeURIComponent(id)}/diagnostics/${encodeURIComponent(text(row.id))}?workspaceId=${encodeURIComponent(workspaceId)}` })),
      }), { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
