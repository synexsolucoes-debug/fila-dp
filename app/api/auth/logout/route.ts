import { clearAuthSession } from "@/app/chatgpt-auth";

export const runtime = "nodejs";

function redirectTarget(request: Request) {
  const value = new URL(request.url).searchParams.get("return_to") ?? "/";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function GET(request: Request) {
  await clearAuthSession();
  return Response.redirect(new URL(redirectTarget(request), request.url));
}

export async function POST() {
  await clearAuthSession();
  return Response.json({ ok: true });
}
