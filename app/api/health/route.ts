import { getD1 } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    const schema = await getD1().prepare(`SELECT
      to_regclass('public.fdp_workspaces') AS workspaces,
      to_regclass('public.fdp_people') AS people,
      to_regclass('public.fdp_employments') AS employments,
      to_regclass('public.fdp_benefit_policies') AS benefit_policies,
      to_regclass('public.fdp_benefit_movements') AS benefit_movements,
      to_regclass('public.fdp_pj_closings') AS pj_closings`).first<Record<string, unknown>>();
    const requiredTables = ["workspaces", "people", "employments", "benefit_policies", "benefit_movements", "pj_closings"];
    const missingTables = requiredTables.filter((table) => !schema?.[table]);
    if (missingTables.length) {
      return Response.json({
        status: "unhealthy",
        database: "connected",
        schema: "migration_required",
        missingTables,
        responseTimeMs: Date.now() - startedAt,
        commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({
      status: "healthy",
      database: "connected",
      schema: "current",
      attachments: process.env.BLOB_READ_WRITE_TOKEN ? "configured" : "not_configured",
      transactionalEmail: process.env.RESEND_API_KEY ? "configured" : "not_configured",
      slaScheduler: process.env.CRON_SECRET ? "configured" : "not_configured",
      calendarOAuth: {
        google: Boolean(process.env.FDP_GOOGLE_CALENDAR_CLIENT_ID && process.env.FDP_GOOGLE_CALENDAR_CLIENT_SECRET),
        microsoft: Boolean((process.env.FDP_MICROSOFT_CALENDAR_CLIENT_ID || process.env.FDP_MICROSOFT_CLIENT_ID) && (process.env.FDP_MICROSOFT_CALENDAR_CLIENT_SECRET || process.env.FDP_MICROSOFT_CLIENT_SECRET)),
      },
      responseTimeMs: Date.now() - startedAt,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error("[fila-dp][health] database-unavailable", { requestId, error: error instanceof Error ? error.message : String(error) });
    return Response.json({ status: "unhealthy", database: "unavailable", requestId, responseTimeMs: Date.now() - startedAt }, { status: 503, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
  }
}
