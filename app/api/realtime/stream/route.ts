import { getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function sse(event: string, payload: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  const { d1, workspace } = await getWorkspaceContext(auth.user);
  const url = new URL(request.url);
  let cursor = text(url.searchParams.get("since"), 40) || new Date().toISOString();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let checking = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearTimeout(timeout);
        try { controller.close(); } catch { /* The browser already disconnected. */ }
      };
      const write = (event: string, payload: Record<string, unknown>) => {
        if (!closed) controller.enqueue(encoder.encode(sse(event, payload)));
      };
      const check = async () => {
        if (closed || checking) return;
        checking = true;
        try {
          const latest = await d1.prepare("SELECT MAX(created_at) AS created_at, COUNT(*) AS count FROM fdp_activity_events WHERE workspace_id = ? AND created_at > ?")
            .bind(workspace.id, cursor)
            .first<{ created_at: string | null; count: number }>();
          const count = Number(latest?.count ?? 0);
          if (count > 0) {
            cursor = latest?.created_at ?? cursor;
            write("change", { latestAt: cursor, count });
          } else write("heartbeat", { at: new Date().toISOString() });
        } catch (error) {
          write("server-error", { message: error instanceof Error ? error.message : "Falha na sincronização." });
          close();
        } finally {
          checking = false;
        }
      };

      write("ready", { workspaceId: workspace.id, cursor });
      const interval = setInterval(() => { void check(); }, 2_000);
      const timeout = setTimeout(close, 50_000);
      request.signal.addEventListener("abort", close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

