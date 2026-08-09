import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { apiScopes, generateApiToken, parseScopes } from "@/lib/api-v1";
import { cleanText } from "@/lib/registrations";

/** Chaves da API pública: o token completo aparece uma única vez, na criação. */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "integrations.manage");
    const rows = await d1.prepare(`SELECT id, name, prefix, scopes_json, rate_limit_per_minute, status, last_used_at, expires_at, revoked_at, created_at
      FROM fdp_api_keys WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`).bind(workspace.id).all<Record<string, unknown>>();
    return Response.json({
      keys: rows.results.map((row) => ({
        id: String(row.id), name: String(row.name), prefix: String(row.prefix),
        scopes: Array.isArray(row.scopes_json) ? row.scopes_json : JSON.parse(String(row.scopes_json || "[]")),
        rateLimitPerMinute: Number(row.rate_limit_per_minute), status: String(row.status),
        lastUsedAt: row.last_used_at, expiresAt: row.expires_at, createdAt: row.created_at,
      })),
      availableScopes: apiScopes,
    });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "integrations.manage");

    const name = cleanText(body.name, 120);
    if (!name) throw ApiError.badRequest("Informe um nome para a chave.", "API_KEY_NAME_REQUIRED");
    const scopes = parseScopes(body.scopes);
    const rateLimit = Math.min(Math.max(Number(body.rateLimitPerMinute) || 120, 1), 6000);
    const expiresInDays = Math.min(Math.max(Number(body.expiresInDays) || 365, 1), 3650);
    const { prefix, token, tokenHash } = generateApiToken();
    const id = crypto.randomUUID();

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_api_keys (id, workspace_id, name, prefix, token_hash, scopes_json, rate_limit_per_minute, status, expires_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, 'active', now() + (? * interval '1 day'), ?)`)
        .bind(id, workspace.id, name, prefix, tokenHash, JSON.stringify(scopes), rateLimit, expiresInDays, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "api_key.created", entityType: "api_key", entityId: id,
        after: { name, prefix, scopes, rateLimitPerMinute: rateLimit },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    // Única exibição do token: ele não é recuperável depois.
    return Response.json({ key: { id, name, prefix, scopes, rateLimitPerMinute: rateLimit }, token }, { status: 201 });
  } catch (error) { return apiError(error); }
}
