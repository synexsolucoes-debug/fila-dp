import { selfSignupEnabled } from "@/lib/saas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { setupRequired: false, signupEnabled: selfSignupEnabled() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
