import { getD1, getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { publicCredentialFingerprint } from "@/lib/integrations";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";

export const dynamic = "force-dynamic";
type Row = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);
const truthy = (value: unknown) => value === true || value === 1 || value === "1" || value === "t" || value === "true";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    return await withPlatformContext(platform, async () => {
      const global = getD1();
      const [users, sessions, workspaces, operatorAudit] = await Promise.all([
        global.prepare(`SELECT id, email, name, status, status_reason, created_at,
            (password_hash IS NOT NULL AND password_hash <> '') AS activated
          FROM fdp_users WHERE status = 'blocked' OR password_hash IS NULL OR password_hash = ''
          ORDER BY created_at DESC LIMIT 100`).all<Row>(),
        global.prepare(`SELECT session.id, session.user_id, users.email, session.device_label,
            session.created_at, session.last_seen_at, session.expires_at
          FROM fdp_auth_sessions session JOIN fdp_users users ON users.id = session.user_id
          WHERE session.revoked_at IS NULL AND session.expires_at > now()
          ORDER BY session.last_seen_at DESC LIMIT 100`).all<Row>(),
        global.prepare("SELECT id, name FROM fdp_workspaces ORDER BY name").all<{ id: string; name: string }>(),
        global.prepare(`SELECT id, actor_email, action, entity_type, entity_id, created_at
          FROM fdp_platform_audit_events ORDER BY created_at DESC LIMIT 60`).all<Row>(),
      ]);
      const tenant = await Promise.all(workspaces.results.map(async (workspace) => {
        const scoped = getPlatformScopedD1({ workspaceId: workspace.id, userId: platform.userId });
        const [credentials, apiKeys, webhooks, deliveries] = await Promise.all([
          scoped.prepare(`SELECT credential.id, integration.display_name, credential.fingerprint, credential.key_version,
              credential.status, credential.verified_at, credential.expires_at, credential.rotated_at
            FROM fdp_integration_credentials credential
            JOIN fdp_integrations integration ON integration.workspace_id = credential.workspace_id AND integration.id = credential.integration_id
            WHERE credential.workspace_id = ? AND credential.status = 'active' ORDER BY credential.expires_at NULLS LAST`).bind(workspace.id).all<Row>(),
          scoped.prepare(`SELECT id, name, prefix, scopes_json, rate_limit_per_minute, status, last_used_at, expires_at, created_at
            FROM fdp_api_keys WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`).bind(workspace.id).all<Row>(),
          scoped.prepare(`SELECT id, name, status, failure_count, last_delivery_at, last_failure_at, created_at
            FROM fdp_webhook_endpoints WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`).bind(workspace.id).all<Row>(),
          scoped.prepare(`SELECT status, count(*)::int AS total FROM fdp_webhook_deliveries
            WHERE workspace_id = ? AND status IN ('failed', 'dead_letter') GROUP BY status`).bind(workspace.id).all<Row>(),
        ]);
        return {
          workspace,
          credentials: credentials.results.map((row) => ({ id: text(row.id), integration: text(row.display_name),
            fingerprint: publicCredentialFingerprint(text(row.fingerprint)), version: Number(row.key_version), status: text(row.status),
            verifiedAt: text(row.verified_at) || null, expiresAt: text(row.expires_at) || null, rotatedAt: text(row.rotated_at) || null })),
          apiKeys: apiKeys.results,
          webhooks: webhooks.results,
          failedDeliveries: Object.fromEntries(deliveries.results.map((row) => [text(row.status), Number(row.total)])),
        };
      }));
      const operators = String(process.env.FDP_PLATFORM_ADMIN_EMAILS ?? "").split(/[;,\s]+/u).map((email) => email.trim().toLowerCase()).filter(Boolean);
      return Response.json({
        blockedUsers: users.results.filter((row) => row.status === "blocked"),
        pendingActivation: users.results.filter((row) => !truthy(row.activated)),
        activeSessions: sessions.results,
        credentials: tenant.flatMap((entry) => entry.credentials.map((item) => ({ ...item, workspaceId: entry.workspace.id, workspaceName: entry.workspace.name }))),
        apiKeys: tenant.flatMap((entry) => entry.apiKeys.map((item) => ({ ...item, workspace_id: entry.workspace.id, workspace_name: entry.workspace.name }))),
        webhooks: tenant.flatMap((entry) => entry.webhooks.map((item) => ({ ...item, workspace_id: entry.workspace.id, workspace_name: entry.workspace.name }))),
        failedWebhookDeliveries: tenant.map((entry) => ({ workspaceId: entry.workspace.id, workspaceName: entry.workspace.name, ...entry.failedDeliveries })),
        platformOperators: operators.map((email) => ({ email, active: true })),
        operatorHistory: operatorAudit.results,
        authenticationFailures: { available: false, reason: "Falhas de autenticação não são persistidas como eventos consultáveis no modelo atual." },
        mfa: { implemented: false, reason: "O provedor de identidade atual não possui fluxo completo de MFA e recuperação." },
        assistedSupport: { enabled: false, reason: "Impersonação permanece desabilitada porque o modelo ainda não garante duração, faixa visível e auditoria de cada ação." },
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
