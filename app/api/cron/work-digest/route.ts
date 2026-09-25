import { timingSafeEqual } from "node:crypto";
import { getScopedD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { sendWorkDigestEmail } from "@/lib/email";
import { log } from "@/lib/observability";
import { buildWorkDigestQueries, workDigestEmailHtml, workDigestFromRows } from "@/lib/work-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Resumo diário por e-mail — roadmap P0 "notificação externa" (§4.4 cobriu
 * convite e recuperação; este é o primeiro consumidor do canal para trabalho
 * pendente, e não para acesso à conta).
 *
 * Mesmo desenho do executor de integrações (`app/api/cron/integrations`): a
 * lista de workspaces sai de uma conexão sem tenant, e cada workspace é
 * processado com a própria conexão escopada, num `try` que isola falha de um
 * tenant do restante da varredura.
 *
 * Roda uma vez por dia (GitHub Actions, não Vercel Cron — mesma razão do
 * executor de integrações: o plano Hobby recusa mais de um disparo diário por
 * rota, e aqui basta um).
 */
const MINIMUM_SECRET_LENGTH = 32;
const TIME_BUDGET_MS = 45_000;

function matchesSecret(received: string, expected: string) {
  if (received.length < MINIMUM_SECRET_LENGTH || expected.length < MINIMUM_SECRET_LENGTH) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(request: Request) {
  const received = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/iu, "").trim();
  if (!received) return false;
  return [process.env.CRON_SECRET, process.env.FDP_WORK_DIGEST_CRON_SECRET]
    .some((expected) => typeof expected === "string" && matchesSecret(received, expected.trim()));
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Execução agendada não autorizada." }, { status: 401 });
  try {
    const deadline = Date.now() + TIME_BUDGET_MS;
    const roots = getScopedD1({ workspaceId: "", userId: null });
    const workspaces = await roots.prepare("SELECT id, name FROM fdp_workspaces WHERE status = 'active' ORDER BY created_at")
      .all<{ id: string; name: string }>();

    const baseUrl = String(process.env.FDP_APP_URL ?? "").trim();
    const today = new Date().toISOString().slice(0, 10);
    let workspacesWithDigest = 0;
    let emailsSent = 0;
    let workspacesFailed = 0;

    for (const workspace of workspaces.results) {
      if (Date.now() >= deadline) break;
      if (!baseUrl) break; // Sem endereço público, nenhum link do e-mail funcionaria — não vale montar nada.
      const scoped = getScopedD1({ workspaceId: workspace.id, userId: null });
      try {
        const queries = buildWorkDigestQueries(workspace.id);
        if (!queries) continue;
        const [counts, page] = await Promise.all([
          scoped.prepare(queries.counts.sql).bind(...queries.counts.parameters).first<Record<string, unknown>>(),
          scoped.prepare(queries.page.sql).bind(...queries.page.parameters).all<Record<string, unknown>>(),
        ]);
        const digest = workDigestFromRows(counts ?? null, page.results);
        if (!digest) continue;

        const admins = await scoped.prepare(`SELECT u.id, u.email FROM fdp_workspace_members m
            JOIN fdp_users u ON u.id = m.user_id
            WHERE m.workspace_id = ? AND m.role = 'admin'`)
          .bind(workspace.id).all<{ id: string; email: string }>();
        if (!admins.results.length) continue;

        workspacesWithDigest += 1;
        const html = workDigestEmailHtml(workspace.name, digest, baseUrl);
        for (const admin of admins.results) {
          const result = await sendWorkDigestEmail({
            to: admin.email,
            subject: `Resumo do dia: ${digest.overdueTotal} ${digest.overdueTotal === 1 ? "item vencido" : "itens vencidos"}`,
            html,
            idempotencyKey: `work-digest:${workspace.id}:${admin.id}:${today}`,
          }).catch(() => null);
          if (result) emailsSent += 1;
        }
      } catch (error) {
        workspacesFailed += 1;
        log("error", "cron.work_digest_workspace_failed", { workspaceId: workspace.id }, { error: String(error) });
      }
    }

    return Response.json({ workspacesWithDigest, emailsSent, workspacesFailed });
  } catch (error) { return apiError(error); }
}
