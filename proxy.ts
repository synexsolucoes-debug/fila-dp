import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildContentSecurityPolicy, createCspNonce } from "@/lib/content-security-policy";
import { isAllowedRequestOrigin } from "@/lib/request-security";

/**
 * Proteção de origem nas mutações e política de segurança de conteúdo.
 *
 * A CSP mora aqui, e não em `next.config.ts`, porque ela carrega um **nonce por
 * requisição** (§67) — um valor estático no arquivo de configuração não teria
 * como conter script injetado. O cabeçalho é escrito nos dois lados: na
 * requisição, para o Next propagar o nonce aos próprios scripts; e na resposta,
 * para o navegador aplicar.
 *
 * O alcance passou de `/api/*` para tudo que não é asset estático. A verificação
 * de origem continua valendo só para as rotas de API — ela é sobre mutação, e
 * documento HTML não muta nada.
 */
export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-fila-dp-request-id") ?? crypto.randomUUID();
  const isApi = request.nextUrl.pathname.startsWith("/api/");
  const allowed = isAllowedRequestOrigin({
    method: request.method,
    pathname: request.nextUrl.pathname,
    origin: request.headers.get("origin"),
    requestOrigin: request.nextUrl.origin,
  });

  const nonce = createCspNonce();
  const policy = buildContentSecurityPolicy({ nonce });

  if (!allowed) {
    return NextResponse.json(
      { error: "Origem da requisição inválida." },
      {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
          Vary: "Origin",
          "x-fila-dp-request-id": requestId,
          "Content-Security-Policy": policy,
        },
      },
    );
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-fila-dp-request-id", requestId);
  if (!isApi) {
    // O Next lê o nonce do cabeçalho da requisição para aplicá-lo aos scripts
    // que ele mesmo emite. Sem estas duas linhas, a política bloquearia a
    // hidratação da própria aplicação.
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", policy);
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-fila-dp-request-id", requestId);
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  /*
   * Tudo, menos o que é servido como arquivo estático.
   *
   * Assets do `_next/static` são imutáveis e cacheados pela borda; passá-los
   * pelo proxy só para escrever um nonce que ninguém lê custaria latência em
   * toda requisição de bundle.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|woff2?)$).*)"],
};
