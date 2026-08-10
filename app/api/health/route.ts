import { getApiUser } from "@/lib/fila-dp-api";
import { isPlatformAdmin } from "@/lib/platform-authorization";
import { checkReadiness } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prontidão deste deployment.
 *
 * Existe para responder, sem acesso ao log do servidor, à pergunta que o erro
 * genérico deixava no ar: o sistema está fora porque quebrou ou porque o banco
 * está atrás desta versão? Qualquer pessoa vê o veredito; só quem administra a
 * plataforma vê quais migrações faltam.
 *
 * Não expõe host, credencial, versão do banco nem SQL.
 */
export async function GET() {
  const auth = await getApiUser().catch(() => ({ user: null }));
  const detailed = Boolean(auth.user && isPlatformAdmin(auth.user));
  const report = await checkReadiness(detailed);

  return Response.json(
    {
      ...report,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    },
    { status: report.status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
