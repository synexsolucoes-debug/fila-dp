const DEFAULT_PROVIDER_HOSTS: Record<string, string[]> = {
  email: ["graph.microsoft.com", "gmail.googleapis.com"],
  whatsapp: ["graph.facebook.com"],
  teams: ["graph.microsoft.com"],
  drive: ["www.googleapis.com", "graph.microsoft.com"],
  onedrive: ["graph.microsoft.com"],
  sankhya_browser: ["*.sankhya.com.br"],
  erp: ["api.sankhya.com.br", "service.sankhya.com.br", "*.sankhya.com.br"],
};

function normalizedHost(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isPrivateHost(hostname: string) {
  const host = normalizedHost(hostname);
  return host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host === "::1"
    || host.startsWith("fe80:")
    || (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd")))
    || isPrivateIpv4(host);
}

function matchesHostRule(hostname: string, rule: string) {
  const host = normalizedHost(hostname);
  const normalizedRule = normalizedHost(rule);
  if (!normalizedRule) return false;
  if (normalizedRule.startsWith("*.")) {
    const suffix = normalizedRule.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === normalizedRule;
}

function endpointOrigin(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin.toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * Returns a canonical HTTPS endpoint only when it points to a known provider,
 * an explicitly configured endpoint origin, or an operations allowlist.
 */
export function validateIntegrationEndpoint(
  channel: string,
  endpoint: string,
  configuredEndpoint?: string,
  additionalAllowedHosts = "",
) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Endpoint de integração inválido.");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash || isPrivateHost(url.hostname)) {
    throw new Error("Endpoint de integração inválido ou não seguro.");
  }

  const configuredOrigin = endpointOrigin(configuredEndpoint);
  const isConfiguredOrigin = Boolean(configuredOrigin && url.origin.toLowerCase() === configuredOrigin);
  const allowedHosts = [
    ...(DEFAULT_PROVIDER_HOSTS[channel] ?? []),
    ...additionalAllowedHosts.split(",").map((item) => item.trim()).filter(Boolean),
  ];
  const isAllowedHost = allowedHosts.some((rule) => matchesHostRule(url.hostname, rule));

  if (!isConfiguredOrigin && !isAllowedHost) {
    throw new Error(`O domínio ${url.hostname} não está autorizado para a integração ${channel}.`);
  }

  const hasInlineSecret = Array.from(url.searchParams.keys()).some((key) => /^(access_token|api_?key|client_secret|code|sig|token)$/i.test(key));
  if (hasInlineSecret && !isConfiguredOrigin) {
    throw new Error("Credenciais não podem ser armazenadas na URL da integração.");
  }

  return url.toString();
}

export function parseWorkspaceWebhookSecrets(value: string | undefined) {
  if (!value) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {} as Record<string, string>;
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length >= 24),
    );
  } catch {
    return {} as Record<string, string>;
  }
}
