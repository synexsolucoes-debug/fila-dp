import { getD1, getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { checkReadiness } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const [readiness, database, workspaces] = await Promise.all([
        checkReadiness(true),
        d1.prepare("SELECT now() AS checked_at").first<{ checked_at: string }>(),
        d1.prepare("SELECT id FROM fdp_workspaces").all<{ id: string }>(),
      ]);
      const tenantHealth = await Promise.all(workspaces.results.map(async (workspace) => {
        const scoped = getPlatformScopedD1({ workspaceId: workspace.id, userId: platform.userId });
        const [scheduler, integrations] = await Promise.all([
          scoped.prepare(`SELECT max(created_at) AS last_created_at,
              count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'leased')::int AS leased,
              count(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter
            FROM fdp_integration_jobs WHERE workspace_id = ?`).bind(workspace.id).first<Record<string, unknown>>(),
          scoped.prepare(`SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status IN ('error', 'paused'))::int AS attention
            FROM fdp_integrations WHERE workspace_id = ?`).bind(workspace.id).first<Record<string, unknown>>(),
        ]);
        return { scheduler, integrations };
      }));
      const latestJob = tenantHealth.map((entry) => String(entry.scheduler?.last_created_at ?? "")).filter(Boolean).sort().at(-1) ?? null;
      const total = (field: string, group: "scheduler" | "integrations") => tenantHealth.reduce((sum, entry) => sum + Number(entry[group]?.[field] ?? 0), 0);
      return Response.json({
        readiness,
        database: { status: database?.checked_at ? "ok" : "unavailable", checkedAt: database?.checked_at ?? null },
        scheduler: { lastJobCreatedAt: latestJob, queued: total("queued", "scheduler"), processing: total("leased", "scheduler"), deadLetter: total("dead_letter", "scheduler"),
          available: Boolean(latestJob), note: latestJob ? "Atividade derivada da fila persistida." : "Ainda não há jobs persistidos para comprovar atividade do scheduler." },
        integrations: { total: total("total", "integrations"), active: total("active", "integrations"), attention: total("attention", "integrations") },
        services: {
          databaseConfigured: Boolean(String(process.env.DATABASE_URL ?? "").trim()),
          /* O cofre de credenciais de integração é `FDP_INTEGRATION_VAULT_KEYS`
             (rotação) ou `FDP_INTEGRATION_VAULT_KEY` — as mesmas variáveis que
             `lib/integrations.ts` exige antes de selar qualquer segredo.
             Este indicador apontava para `FDP_CREDENTIALS_ENCRYPTION_KEY`, que
             não existe em lugar nenhum do produto: nada cifra com ela e ela não
             está documentada. O efeito era uma luz que mentia nos dois sentidos
             — vermelha em todo deployment correto, e verde para quem definisse
             qualquer valor, sem que isso provasse nada. */
          credentialsEncryptionConfigured: Boolean(
            String(process.env.FDP_INTEGRATION_VAULT_KEYS ?? process.env.FDP_INTEGRATION_VAULT_KEY ?? "").trim(),
          ),
          sankhyaVaultConfigured: Boolean(String(process.env.FDP_SANKHYA_VAULT_KEYS ?? process.env.FDP_SANKHYA_VAULT_KEY ?? "").trim()),
          authSecretConfigured: Boolean(String(process.env.FDP_AUTH_SECRET ?? "").trim()),
          platformAdminsConfigured: Boolean(String(process.env.FDP_PLATFORM_ADMIN_EMAILS ?? "").trim()),
          sankhyaActionsConfigured: Boolean(String(process.env.FDP_SANKHYA_ACTIONS_TOKEN ?? "").trim()),
        },
        deployment: { commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local", environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development", checkedAt: new Date().toISOString() },
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
