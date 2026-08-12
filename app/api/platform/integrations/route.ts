import { getD1, getPlatformScopedD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { publicCredentialFingerprint, safeIntegrationError } from "@/lib/integrations";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { decodePlatformCursor, encodePlatformCursor, platformListLimit } from "@/lib/platform-console";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);
const number = (value: unknown) => Number(value) || 0;
const truthy = (value: unknown) => value === true || value === 1 || value === "1" || value === "t" || value === "true";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const url = new URL(request.url);
    const workspaceId = cleanText(url.searchParams.get("workspaceId"), 120);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const connector = cleanText(url.searchParams.get("connector"), 60).toLowerCase();
    const status = cleanText(url.searchParams.get("status"), 30).toLowerCase();
    const onlyErrors = url.searchParams.get("errors") === "true";
    const onlyExpiring = url.searchParams.get("expiring") === "true";
    const onlyStalled = url.searchParams.get("stalled") === "true";
    const from = cleanText(url.searchParams.get("from"), 30);
    const to = cleanText(url.searchParams.get("to"), 30);
    const fromTime = from ? new Date(from).getTime() : Number.NEGATIVE_INFINITY;
    const toTime = to ? new Date(`${to}T23:59:59.999Z`).getTime() : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(fromTime) && fromTime !== Number.NEGATIVE_INFINITY) throw ApiError.badRequest("Período inicial inválido.", "INVALID_PERIOD");
    if (!Number.isFinite(toTime) && toTime !== Number.POSITIVE_INFINITY) throw ApiError.badRequest("Período final inválido.", "INVALID_PERIOD");
    const limit = platformListLimit(url.searchParams.get("limit"));
    const cursor = decodePlatformCursor(url.searchParams.get("cursor"));

    return await withPlatformContext(platform, async () => {
      const global = getD1();
      const workspaces = await global.prepare(`SELECT id, name FROM fdp_workspaces
        WHERE (? = '' OR id = ?) ORDER BY name, id`).bind(workspaceId, workspaceId).all<{ id: string; name: string }>();
      if (workspaceId && workspaces.results.length === 0) {
        throw ApiError.badRequest("Workspace informado não existe.", "WORKSPACE_NOT_FOUND");
      }

      const grouped = await Promise.all(workspaces.results.map(async (workspace) => {
        const scoped = getPlatformScopedD1({ workspaceId: workspace.id, userId: platform.userId });
        const rows = await scoped.prepare(`SELECT i.id, i.channel, i.display_name, i.status, i.last_sync_at, i.last_error, i.created_at, i.updated_at,
            NULLIF(i.config_json, '')::jsonb->>'companyId' AS company_id,
            company.trade_name AS company_name,
            credential.fingerprint, credential.key_version, credential.verified_at, credential.expires_at,
            (credential.id IS NOT NULL) AS has_credentials,
            mapping.id AS mapping_id, mapping.resource_type, mapping.direction, mapping.version AS mapping_version,
            run.id AS last_run_id, run.trigger_type, run.status AS run_status, run.received_count, run.processed_count,
            run.skipped_count, run.conflict_count, run.failed_count, run.created_at AS run_created_at,
            queue.queued, queue.processing, queue.retries, queue.dead_letter, reconciliation.conflicts
          FROM fdp_integrations i
          LEFT JOIN fdp_companies company ON company.workspace_id = i.workspace_id
            AND company.id = NULLIF(i.config_json, '')::jsonb->>'companyId'
          LEFT JOIN LATERAL (
            SELECT id, fingerprint, key_version, verified_at, expires_at FROM fdp_integration_credentials
            WHERE workspace_id = i.workspace_id AND integration_id = i.id AND credential_type = 'provider_auth' AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
          ) credential ON TRUE
          LEFT JOIN LATERAL (
            SELECT id, resource_type, direction, version FROM fdp_integration_mappings
            WHERE workspace_id = i.workspace_id AND integration_id = i.id AND status = 'active'
            ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 1
          ) mapping ON TRUE
          LEFT JOIN LATERAL (
            SELECT id, trigger_type, status, received_count, processed_count, skipped_count, conflict_count, failed_count, created_at
            FROM fdp_integration_sync_runs WHERE workspace_id = i.workspace_id AND integration_id = i.id
            ORDER BY created_at DESC LIMIT 1
          ) run ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'leased')::int AS processing,
              count(*) FILTER (WHERE status = 'queued' AND attempt > 0)::int AS retries,
              count(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter
            FROM fdp_integration_jobs WHERE workspace_id = i.workspace_id AND integration_id = i.id
          ) queue ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*) FILTER (WHERE status IN ('unmatched', 'conflict'))::int AS conflicts
            FROM fdp_integration_reconciliations WHERE workspace_id = i.workspace_id AND integration_id = i.id
          ) reconciliation ON TRUE
          WHERE i.workspace_id = ? ORDER BY i.created_at DESC, i.id DESC`).bind(workspace.id).all<Row>();
        return rows.results.map((row) => ({ workspace, row }));
      }));

      const now = Date.now();
      const expiringCutoff = now + 30 * 24 * 60 * 60 * 1000;
      let integrations = grouped.flat().map(({ workspace, row }) => {
        const lastError = text(row.last_error);
        const expiresAt = text(row.expires_at);
        const queueTotal = number(row.queued) + number(row.processing);
        return {
          id: text(row.id), workspaceId: workspace.id, workspaceName: workspace.name,
          companyId: text(row.company_id), companyName: text(row.company_name),
          connector: text(row.channel), displayName: text(row.display_name), status: text(row.status),
          hasCredential: truthy(row.has_credentials),
          fingerprint: row.fingerprint ? publicCredentialFingerprint(text(row.fingerprint)) : "",
          credentialVersion: number(row.key_version), verifiedAt: text(row.verified_at) || null, expiresAt: expiresAt || null,
          lastSyncAt: text(row.last_sync_at) || null,
          lastError: lastError ? safeIntegrationError(new Error(lastError)).message : "",
          mapping: row.mapping_id ? { id: text(row.mapping_id), resource: text(row.resource_type), direction: text(row.direction), version: number(row.mapping_version) } : null,
          lastRun: row.last_run_id ? {
            id: text(row.last_run_id), trigger: text(row.trigger_type), status: text(row.run_status), createdAt: text(row.run_created_at),
            received: number(row.received_count), processed: number(row.processed_count), skipped: number(row.skipped_count),
            conflicts: number(row.conflict_count), failed: number(row.failed_count),
          } : null,
          queue: { queued: number(row.queued), processing: number(row.processing), retries: number(row.retries), deadLetter: number(row.dead_letter) },
          conflicts: number(row.conflicts),
          credentialExpiring: Boolean(expiresAt && new Date(expiresAt).getTime() <= expiringCutoff),
          queueStalled: queueTotal > 0 && (!row.updated_at || now - new Date(text(row.updated_at)).getTime() > 30 * 60 * 1000),
          createdAt: text(row.created_at),
        };
      });

      integrations = integrations.filter((item) => (!connector || item.connector.toLowerCase() === connector)
        && (!status || item.status.toLowerCase() === status)
        && (!companyId || item.companyId === companyId)
        && (!onlyErrors || Boolean(item.lastError) || item.status === "error" || item.queue.deadLetter > 0)
        && (!onlyExpiring || item.credentialExpiring)
        && (!onlyStalled || item.queueStalled)
        && (() => { const periodTime = new Date(item.lastRun?.createdAt || item.createdAt).getTime(); return periodTime >= fromTime && periodTime <= toTime; })());
      integrations.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      if (cursor) integrations = integrations.filter((item) => item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id < cursor.id));
      const page = integrations.slice(0, limit);
      const next = integrations.length > limit ? page.at(-1) : null;
      return Response.json({
        integrations: page,
        nextCursor: encodePlatformCursor(next ? { createdAt: next.createdAt, id: next.id } : null),
        totalOnPage: page.length,
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
