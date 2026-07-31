import { getApiUser, text } from "@/lib/fila-dp-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;

  try {
    const body = await request.json() as { message?: unknown; digest?: unknown };
    const message = text(body.message, 800) || "Erro de renderização sem mensagem.";
    const digest = text(body.digest, 120);
    console.error("[fila-dp][client-render] painel", { message, digest: digest || undefined });
  } catch {
    console.error("[fila-dp][client-render] painel", { message: "Não foi possível ler o relatório do navegador." });
  }

  return Response.json({ accepted: true }, { status: 202 });
}
