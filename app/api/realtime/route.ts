import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const since = text(url.searchParams.get("since"), 40) || "1970-01-01 00:00:00";
    const latest = await d1.prepare("SELECT MAX(created_at) AS created_at, COUNT(*) AS count FROM fdp_activity_events WHERE workspace_id = ? AND created_at > ?").bind(workspace.id, since).first<{ created_at: string | null; count: number }>();
    return Response.json({ changed: Number(latest?.count ?? 0) > 0, latestAt: latest?.created_at ?? since, count: Number(latest?.count ?? 0) });
  } catch (error) { return apiError(error); }
}
