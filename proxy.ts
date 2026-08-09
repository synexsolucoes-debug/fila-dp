import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAllowedRequestOrigin } from "@/lib/request-security";

export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-fila-dp-request-id") ?? crypto.randomUUID();
  const allowed = isAllowedRequestOrigin({
    method: request.method,
    pathname: request.nextUrl.pathname,
    origin: request.headers.get("origin"),
    requestOrigin: request.nextUrl.origin,
  });

  if (!allowed) {
    return NextResponse.json(
      { error: "Origem da requisição inválida." },
      { status: 403, headers: { "Cache-Control": "no-store", Vary: "Origin", "x-fila-dp-request-id": requestId } },
    );
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-fila-dp-request-id", requestId);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-fila-dp-request-id", requestId);
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
