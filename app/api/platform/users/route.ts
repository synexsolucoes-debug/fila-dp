import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

/** Usuários globais do SaaS, com os workspaces de cada um. Nenhuma senha é devolvida. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const url = new URL(request.url);
    const query = cleanText(url.searchParams.get("q"), 160).toLowerCase();
    const status = cleanText(url.searchParams.get("status"), 20);

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const filters = ["1 = 1"];
      const values: unknown[] = [];
      if (query) { filters.push("(lower(u.email) LIKE ? OR lower(u.name) LIKE ?)"); values.push(`%${query}%`, `%${query}%`); }
      if (status) { filters.push("u.status = ?"); values.push(status); }

      const rows = await d1.prepare(`SELECT u.id, u.email, u.name, u.status, u.status_reason, u.created_at,
          (u.password_hash IS NOT NULL AND u.password_hash <> '') AS has_password,
          (SELECT max(s.last_seen_at) FROM fdp_auth_sessions s WHERE s.user_id = u.id) AS last_seen_at,
          (SELECT count(*)::int FROM fdp_workspace_members m WHERE m.user_id = u.id) AS workspaces,
          (SELECT string_agg(w.name || ' (' || m.role || ')', ', ' ORDER BY w.name)
             FROM fdp_workspace_members m JOIN fdp_workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = u.id) AS workspace_names
        FROM fdp_users u WHERE ${filters.join(" AND ")} ORDER BY u.created_at DESC LIMIT 200`)
        .bind(...values).all<Record<string, unknown>>();
      // A projeção nunca inclui hash nem salt: só se existe senha definida.
      return Response.json({ users: rows.results }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
