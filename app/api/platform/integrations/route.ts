import { getD1, getPlatformScopedD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { publicCredentialFingerprint, safeIntegrationError } from "@/lib/integrations";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { isSankhyaWorkspaceEnabled } from "@/lib/sankhya/queue";
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
        // O portão do módulo é lido pela mesma função que o servidor usa para
        // recusar a ação, e não por uma cópia do critério aqui: cópia é o que
        // deixa a tela e o servidor discordarem com o tempo. Vai no mesmo
        // `Promise.all` da listagem, então não custa uma ida a mais ao banco.
        const [rows, sankhyaEnabled] = await Promise.all([
          scoped.prepare(`SELECT i.id, i.channel, i.display_name, i.status, i.last_sync_at, i.last_connection_at, i.last_successful_sync_at,
            i.next_sync_at, i.last_error, i.created_at, i.updated_at,
            NULLIF(i.config_json, '')::jsonb->>'companyId' AS company_id,
            -- Só a presença, não o endereço: o cartão precisa saber se a
            -- configuração gravada permite executar, e nada além disso.
            (NULLIF(i.config_json, '')::jsonb->>'endpoint' <> '') AS has_endpoint,
            company.trade_name AS company_name,
            credential.fingerprint, credential.key_version, credential.verified_at, credential.expires_at,
            (credential.id IS NOT NULL) AS has_credentials,
            mapping.id AS mapping_id, mapping.resource_type, mapping.direction, mapping.version AS mapping_version,
            run.id AS last_run_id, run.trigger_type, run.status AS run_status, run.received_count, run.processed_count,
            run.skipped_count, run.conflict_count, run.failed_count, run.created_at AS run_created_at,
            queue.queued, queue.processing, queue.retries, queue.dead_letter, reconciliation.conflicts,
            health.run_count, health.success_count, health.average_duration_ms, health.authentication_errors, health.layout_errors, health.processed_total
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
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS run_count,
              count(*) FILTER (WHERE status = 'succeeded')::int AS success_count,
              COALESCE(avg(duration_ms) FILTER (WHERE duration_ms > 0), 0)::int AS average_duration_ms,
              count(*) FILTER (WHERE error_code LIKE 'SANKHYA_LOGIN%' OR error_code LIKE 'SANKHYA_%CREDENTIAL%')::int AS authentication_errors,
              count(*) FILTER (WHERE error_code IN ('SELECTOR_NOT_FOUND', 'DP_EXPLORER_NOT_FOUND', 'UI_CHANGED'))::int AS layout_errors,
              COALESCE(sum(processed_count), 0)::int AS processed_total
            FROM fdp_integration_sync_runs WHERE workspace_id = i.workspace_id AND integration_id = i.id
          ) health ON TRUE
          WHERE i.workspace_id = ? ORDER BY i.created_at DESC, i.id DESC`).bind(workspace.id).all<Row>(),
          isSankhyaWorkspaceEnabled(scoped, workspace.id),
        ]);
        return rows.results.map((row) => ({ workspace, row, sankhyaEnabled }));
      }));

      const now = Date.now();
      const expiringCutoff = now + 30 * 24 * 60 * 60 * 1000;
      let integrations = grouped.flat().map(({ workspace, row, sankhyaEnabled }) => {
        const lastError = text(row.last_error);
        const expiresAt = text(row.expires_at);
        const queueTotal = number(row.queued) + number(row.processing);
        return {
          id: text(row.id), workspaceId: workspace.id, workspaceName: workspace.name,
          companyId: text(row.company_id), companyName: text(row.company_name),
          connector: text(row.channel), displayName: text(row.display_name), status: text(row.status),
          // Só o Sankhya depende de liberação por workspace; para os demais o
          // campo é verdadeiro para que a tela tenha uma regra só a aplicar.
          moduleEnabled: text(row.channel) !== "sankhya_browser" || sankhyaEnabled,
          // Mesma condição que `assertRunnableSankhyaConfig` aplica antes de
          // enfileirar: sem URL ou sem empresa de destino, executar é recusado.
          // Sem isto o cartão oferecia executar sobre um conector cuja gravação
          // de configuração tinha sido recusada — e a recusa do run soava como
          // "você não preencheu o formulário", que não era o que havia ocorrido.
          configured: text(row.channel) !== "sankhya_browser" || Boolean(truthy(row.has_endpoint) && text(row.company_id)),
          hasCredential: truthy(row.has_credentials),
          fingerprint: row.fingerprint ? publicCredentialFingerprint(text(row.fingerprint)) : "",
          credentialVersion: number(row.key_version), verifiedAt: text(row.verified_at) || null, expiresAt: expiresAt || null,
          lastSyncAt: text(row.last_sync_at) || null,
          lastConnectionAt: text(row.last_connection_at) || null,
          lastSuccessfulSyncAt: text(row.last_successful_sync_at) || null,
          nextSyncAt: text(row.next_sync_at) || null,
          lastError: lastError ? safeIntegrationError(new Error(lastError)).message : "",
          mapping: row.mapping_id ? { id: text(row.mapping_id), resource: text(row.resource_type), direction: text(row.direction), version: number(row.mapping_version) } : null,
          lastRun: row.last_run_id ? {
            id: text(row.last_run_id), trigger: text(row.trigger_type), status: text(row.run_status), createdAt: text(row.run_created_at),
            received: number(row.received_count), processed: number(row.processed_count), skipped: number(row.skipped_count),
            conflicts: number(row.conflict_count), failed: number(row.failed_count),
          } : null,
          queue: { queued: number(row.queued), processing: number(row.processing), retries: number(row.retries), deadLetter: number(row.dead_letter) },
          conflicts: number(row.conflicts),
          health: { runs: number(row.run_count), successes: number(row.success_count), averageDurationMs: number(row.average_duration_ms),
            authenticationErrors: number(row.authentication_errors), layoutErrors: number(row.layout_errors), processed: number(row.processed_total) },
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
      const sankhya = integrations.filter((item) => item.connector === "sankhya_browser");
      const sankhyaRuns = sankhya.reduce((sum, item) => sum + item.health.runs, 0);
      const sankhyaSuccesses = sankhya.reduce((sum, item) => sum + item.health.successes, 0);
      return Response.json({
        integrations: page,
        sankhyaHealth: { connectors: sankhya.length, runs: sankhyaRuns, successRate: sankhyaRuns ? sankhyaSuccesses / sankhyaRuns : 0,
          averageDurationMs: sankhya.length ? Math.round(sankhya.reduce((sum, item) => sum + item.health.averageDurationMs, 0) / sankhya.length) : 0,
          authenticationErrors: sankhya.reduce((sum, item) => sum + item.health.authenticationErrors, 0),
          layoutErrors: sankhya.reduce((sum, item) => sum + item.health.layoutErrors, 0),
          processed: sankhya.reduce((sum, item) => sum + item.health.processed, 0) },
        nextCursor: encodePlatformCursor(next ? { createdAt: next.createdAt, id: next.id } : null),
        totalOnPage: page.length,
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
