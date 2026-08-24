import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { SankhyaConnectorError } from "./errors.ts";

const forbiddenNames = new Set([
  "localhost", "metadata.google.internal", "metadata", "instance-data", "instance-data.ec2.internal",
]);

function privateV4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function privateV6(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized)) return true;
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  return mapped ? privateV4(mapped[1]) : false;
}

export function isPrivateNetworkAddress(address: string) {
  const version = isIP(address);
  return version === 4 ? privateV4(address) : version === 6 ? privateV6(address) : true;
}

export async function assertPublicNavigationUrl(rawUrl: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new SankhyaConnectorError("SSRF_URL_INVALID", "O Sankhya tentou abrir uma URL inválida."); }
  if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return url;
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new SankhyaConnectorError("SSRF_PROTOCOL_BLOCKED", "A navegação tentou usar um destino não seguro.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (forbiddenNames.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new SankhyaConnectorError("SSRF_HOST_BLOCKED", "A navegação tentou alcançar uma rede bloqueada.");
  }
  const literal = isIP(hostname) ? [hostname] : [
    ...await resolve4(hostname).catch(() => []),
    ...await resolve6(hostname).catch(() => []),
  ];
  if (!literal.length) throw new SankhyaConnectorError("SANKHYA_DNS_FAILED", "Não foi possível resolver o domínio Sankhya.", { retryable: true });
  if (literal.some(isPrivateNetworkAddress)) {
    throw new SankhyaConnectorError("SSRF_ADDRESS_BLOCKED", "A navegação tentou alcançar uma rede privada ou de metadados.");
  }
  return url;
}
