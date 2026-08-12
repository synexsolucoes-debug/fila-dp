import { getD1, getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { safeIntegrationError } from "@/lib/integrations";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";

export const dynamic = "force-dynamic";
type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);
const number = (value: unknown) => Number(value) || 0;

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    return await withPlatformContext(platform, async () => {
      const global = getD1();
      const workspaces = await global.prepare("SELECT id, name FROM fdp_workspaces ORDER BY name").all<{ id: string; name: string }>();
      const tenant = await Promise.all(workspaces.results.map(async (workspace) => {
        const scoped = getPlatformScopedD1({ workspaceId: workspace.id, userId: platform.userId });
        const [jobs, runs, reconciliations, deliveries, recentFailures] = await Promise.all([
          scoped.prepare("SELECT status, count(*)::int AS total FROM fdp_integration_jobs WHERE workspace_id = ? GROUP BY status").bind(workspace.id).all<{ status: string; total: number }>(),
          scoped.prepare("SELECT status, count(*)::int AS total FROM fdp_integration_sync_runs WHERE workspace_id = ? AND created_at >= now() - INTERVAL '24 hours' GROUP BY status").bind(workspace.id).all<{ status: string; total: number }>(),
          scoped.prepare("SELECT status, count(*)::int AS total FROM fdp_integration_reconciliations WHERE workspace_id = ? GROUP BY status").bind(workspace.id).all<{ status: string; total: number }>(),
          scoped.prepare("SELECT status, count(*)::int AS total FROM fdp_webhook_deliveries WHERE workspace_id = ? AND created_at >= now() - INTERVAL '24 hours' GROUP BY status").bind(workspace.id).all<{ status: string; total: number }>(),
          scoped.prepare(`SELECT run.id, integration.display_name, run.status, run.failed_count, run.error_message, run.created_at
            FROM fdp_integration_sync_runs run JOIN fdp_integrations integration
              ON integration.workspace_id = run.workspace_id AND integration.id = run.integration_id
            WHERE run.workspace_id = ? AND (run.status IN ('failed', 'partial') OR run.failed_count > 0)
            ORDER BY run.created_at DESC LIMIT 10`).bind(workspace.id).all<Row>(),
        ]);
        const totals = (rows: { status: string; total: number }[]) => Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
        return {
          workspaceId: workspace.id, workspaceName: workspace.name,
          jobs: totals(jobs.results), runs24h: totals(runs.results), reconciliations: totals(reconciliations.results), deliveries24h: totals(deliveries.results),
          recentFailures: recentFailures.results.map((row) => ({ id: text(row.id), integration: text(row.display_name), status: text(row.status),
            failed: number(row.failed_count), error: text(row.error_message) ? safeIntegrationError(new Error(text(row.error_message))).message : "", createdAt: text(row.created_at) })),
        };
      }));
      const sum = (key: string, area: "jobs" | "runs24h" | "reconciliations" | "deliveries24h") => tenant.reduce((total, entry) => total + number(entry[area][key]), 0);
      return Response.json({
        summary: { queued: sum("queued", "jobs"), processing: sum("leased", "jobs"), deadLetter: sum("dead_letter", "jobs"),
          failedRuns24h: sum("failed", "runs24h"), partialRuns24h: sum("partial", "runs24h"),
          conflicts: sum("conflict", "reconciliations") + sum("unmatched", "reconciliations"), failedWebhooks24h: sum("failed", "deliveries24h") + sum("dead_letter", "deliveries24h") },
        workspaces: tenant,
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
