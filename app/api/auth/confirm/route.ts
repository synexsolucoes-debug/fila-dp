import { confirmStarterSignup } from "@/lib/self-signup";
import { apiError } from "@/lib/fila-dp-api";
import { requireSignupConfirmationRequest } from "@/lib/signup-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const token = requireSignupConfirmationRequest(new URL(request.url).searchParams.get("token"));
    const confirmed = await confirmStarterSignup(token);
    if (!confirmed) {
      return Response.json({ error: "Este link de confirmação expirou ou já foi utilizado.", code: "SIGNUP_TOKEN_INVALID" }, {
        status: 400, headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.redirect(new URL("/login?cadastro=confirmado", request.url), 303);
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { token?: unknown };
    const confirmed = await confirmStarterSignup(requireSignupConfirmationRequest(body.token));
    return confirmed
      ? Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Este link de confirmação expirou ou já foi utilizado.", code: "SIGNUP_TOKEN_INVALID" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
