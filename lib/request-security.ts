const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const ORIGIN_EXEMPT_PATH_PREFIXES = [
  "/api/integrations/webhook/",
  "/api/integrations/worker",
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
  return !ORIGIN_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
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
