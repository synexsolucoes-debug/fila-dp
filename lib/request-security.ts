const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Clientes servidor-a-servidor não enviam Origin. Estas rotas se autenticam por
// segredo próprio (chave de API ou segredo do executor), nunca por cookie de sessão.
const ORIGIN_EXEMPT_PATHS = new Set([
  "/api/integrations/worker",
  "/api/saas/webhook/stripe",
  "/api/webhooks/worker",
]);

const ORIGIN_EXEMPT_PATH_PREFIXES = [
  "/api/integrations/webhook/",
  // Upload e conclusão não usam cookie de sessão: cada operação é autenticada
  // por HMAC sobre workspace, autorização, ação e conteúdo. Exigir Origin aqui
  // bloqueia o worker legítimo e não acrescenta proteção contra CSRF.
  "/api/integrations/tangerino/attachments/",
  "/api/v1/",
];

function parseOrigin(value: string | null) {
  if (!value || value === "null") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function requiresSameOrigin(method: string, pathname: string) {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  return !ORIGIN_EXEMPT_PATHS.has(pathname) && !ORIGIN_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isAllowedRequestOrigin(input: {
  method: string;
  pathname: string;
  origin: string | null;
  requestOrigin: string;
}) {
  if (!requiresSameOrigin(input.method, input.pathname)) return true;
  const origin = parseOrigin(input.origin);
  const requestOrigin = parseOrigin(input.requestOrigin);
  return Boolean(origin && requestOrigin && origin === requestOrigin);
}
