import { getApiUser, text } from "@/lib/fila-dp-api";
import { log, requestIdFrom } from "@/lib/observability";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;

  try {
    const body = await request.json() as { message?: unknown; digest?: unknown };
    const message = text(body.message, 800) || "Erro de renderização sem mensagem.";
    const digest = text(body.digest, 120);
    log("error", "client.render_failed", { requestId: requestIdFrom(request), userId: auth.user.id, route: "painel" }, { reason: message, digest: digest || undefined });
  } catch {
    log("error", "client.render_failed", { requestId: requestIdFrom(request), userId: auth.user.id, route: "painel" }, { reason: "Relatório do navegador ilegível." });
  }

  return Response.json({ accepted: true }, { status: 202 });
}
