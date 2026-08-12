export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * O Vinculato não possui autocadastro: identidade, vínculo, papel e workspace
 * nascem no Console Global, com auditoria do administrador da plataforma.
 * Manter a recusa também no servidor impede que uma variável antiga de
 * ambiente ou uma chamada direta volte a abrir provisionamento público.
 */
export async function POST() {
  return Response.json({
    error: "Contas e workspaces são provisionados exclusivamente pelo administrador global.",
    code: "PLATFORM_PROVISIONING_REQUIRED",
  }, { status: 403, headers: { "Cache-Control": "no-store" } });
}
