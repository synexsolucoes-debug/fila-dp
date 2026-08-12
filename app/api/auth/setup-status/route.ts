export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A instalação é sempre administrada: usuário comum só recebe o acesso pronto. */
export async function GET() {
  return Response.json(
    { setupRequired: false, signupEnabled: false },
    { headers: { "Cache-Control": "no-store" } },
  );
}
