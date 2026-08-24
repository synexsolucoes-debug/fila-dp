import { getApiUser } from "@/lib/fila-dp-api";
import { isPlatformAdmin } from "@/lib/platform-authorization";
import { checkOperationalHealth, worstSeverity, type HealthSeverity, type OperationalHealth } from "@/lib/operational-health";
import { checkReadiness } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prontidão e saúde operacional deste deployment.
 *
 * Existe para responder, sem acesso ao log do servidor, à pergunta que o erro
 * genérico deixava no ar: o sistema está fora porque quebrou, porque o banco
 * está atrás desta versão, ou porque o trabalho de fundo parou de andar?
 *
 * A terceira pergunta é nova, e ela foi paga caro: a varredura das integrações
 * ficou quebrada em produção com `syntax error at or near "grant"` enquanto
 * este endpoint respondia 200 e "Banco na mesma versão do aplicativo". Prontidão
 * de schema não é saúde de operação. Agora as duas entram no veredito.
 *
 * Qualquer pessoa vê o veredito e os totais; só quem administra a plataforma vê
 * quais migrações faltam e quais workspaces estão com problema. Não expõe host,
 * credencial, versão do banco nem SQL.
 */

/** Prontidão degradada vira o pior dos vereditos: o deployment não serve direito. */
function readinessSeverity(status: "ok" | "degraded"): HealthSeverity {
  return status === "ok" ? "saudavel" : "degradado";
}

export async function GET() {
  const auth = await getApiUser().catch(() => ({ user: null }));
  const detailed = Boolean(auth.user && isPlatformAdmin(auth.user));
  const report = await checkReadiness(detailed);

  // A leitura operacional depende do banco. Quando ele não responde, quem manda
  // no veredito é a prontidão — e não faz sentido derrubar a resposta inteira
  // por causa do relatório que existe justamente para explicar a falha.
  let operation: OperationalHealth | null = null;
  try {
    operation = await checkOperationalHealth(detailed);
  } catch {
    operation = null;
  }

  const severity = worstSeverity(
    readinessSeverity(report.status),
    operation?.severity ?? "saudavel",
  );

  // 503 quando o deployment não consegue servir, ou quando a fila parou de
  // andar. Fila parada é o sintoma que ficou meses invisível: ela precisa
  // acordar o monitor, não virar uma linha de corpo que ninguém lê.
  const unavailable = report.status !== "ok" || operation?.severity === "critico";

  return Response.json(
    {
      ...report,
      severity,
      operation,
      checkedAt: new Date().toISOString(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    },
    { status: unavailable ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
