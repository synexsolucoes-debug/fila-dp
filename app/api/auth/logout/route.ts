import { clearAuthSession, safeRelativeReturnPath } from "@/app/chatgpt-auth";

export const runtime = "nodejs";

function redirectTarget(request: Request) {
  const value = new URL(request.url).searchParams.get("return_to") ?? "/";
  return safeRelativeReturnPath(value);
}

export async function POST(request: Request) {
  await clearAuthSession();
  return Response.json({ ok: true, redirectTo: redirectTarget(request) }, { headers: { "Cache-Control": "no-store" } });
}
