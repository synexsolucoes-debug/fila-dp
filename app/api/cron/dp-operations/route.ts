import { timingSafeEqual } from "node:crypto";
import { getScopedD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { log } from "@/lib/observability";
import { todayInBrazil } from "@/lib/employee-history";
import { generateRecurringTasks } from "@/lib/dp-recurring-service";
import { refreshDpAlerts } from "@/lib/dp-alerts-service";
import { sendMonthlyDpReport } from "@/lib/dp-report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Job diário do DP Operacional (GitHub Actions, mesmo motivo do resumo diário:
 * um disparo por dia, fora do limite do Vercel Cron).
 *
 * Por workspace, numa conexão escopada e num `try` que isola a falha de um
 * cliente do restante:
 * - Fase 2: gera as rotinas da competência atual, da seguinte a partir do dia
 *   25 e da semana (idempotente — o que já existe fica);
 * - Fase 4: recalcula os alertas de experiência, férias e cadastro;
 * - Fase 5: no começo do mês, envia o relatório do mês anterior (uma vez por
 *   competência).
 */
const MINIMUM_SECRET_LENGTH = 32;
const TIME_BUDGET_MS = 50_000;

function matchesSecret(received: string, expected: string) {
  if (received.length < MINIMUM_SECRET_LENGTH || expected.length < MINIMUM_SECRET_LENGTH) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(request: Request) {
  const received = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/iu, "").trim();
  if (!received) return false;
  return [process.env.CRON_SECRET, process.env.FDP_DP_OPERATIONS_CRON_SECRET]
    .some((expected) => typeof expected === "string" && matchesSecret(received, expected.trim()));
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Execução agendada não autorizada." }, { status: 401 });
  try {
    const deadline = Date.now() + TIME_BUDGET_MS;
    const roots = getScopedD1({ workspaceId: "", userId: null });
    const workspaces = await roots.prepare("SELECT id FROM fdp_workspaces WHERE status = 'active' ORDER BY created_at").all<{ id: string }>();
    const today = todayInBrazil();
    const summary = { workspaces: 0, recurringCreated: 0, alertsOpen: 0, reportsSent: 0, failed: 0 };
    for (const workspace of workspaces.results) {
      if (Date.now() >= deadline) break;
      const d1 = getScopedD1({ workspaceId: workspace.id, userId: null });
      try {
        const recurring = await generateRecurringTasks(d1, { workspaceId: workspace.id, today, actor: "SYSTEM" });
        const alerts = await refreshDpAlerts(d1, { workspaceId: workspace.id, today });
        const report = await sendMonthlyDpReport(d1, { workspaceId: workspace.id, today, actor: "SYSTEM" });
        summary.workspaces += 1;
        summary.recurringCreated += recurring.created;
        summary.alertsOpen += alerts.open;
        summary.reportsSent += report.sent ? 1 : 0;
      } catch (error) {
        summary.failed += 1;
        log("error", "dp_operations.workspace_failed", { workspaceId: workspace.id }, {
          message: error instanceof Error ? error.message.slice(0, 200) : "erro",
        });
      }
    }
    log("info", "dp_operations.completed", {}, summary);
    return Response.json(summary);
  } catch (error) { return apiError(error); }
}
