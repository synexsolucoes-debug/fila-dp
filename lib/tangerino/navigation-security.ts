import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { tangerinoErrors, TangerinoAgentError } from "./errors.ts";
import { tangerinoBrowserHosts } from "./hosts.ts";

/**
 * Onde o navegador do agente pode ir — e apenas onde.
 *
 * Duas ameaças distintas, e as duas terminam aqui:
 *
 * 1. **Navegação não autorizada (§22).** A página do Tangerino pode redirecionar
 *    para qualquer lugar. Um agente autenticado que segue redirect cego é uma
 *    sessão viva sendo levada a passeio por um terceiro.
 * 2. **SSRF.** O worker roda dentro de uma infraestrutura com endereços internos
 *    e endpoints de metadados alcançáveis. Um `http://169.254.169.254/` numa
 *    navegação transforma o navegador do agente em leitor de credencial de nuvem.
 *
 * A resolução de DNS é refeita a cada navegação, e não uma vez por sessão: um
 * host confiável no login pode passar a resolver para endereço interno cinco
 * minutos depois, que é exatamente o que um rebind de DNS faz.
 */

const forbiddenNames = new Set([
  "localhost", "metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal",
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

export { tangerinoBrowserHosts };

export function isPrivateNetworkAddress(address: string) {
  const version = isIP(address);
  // Um valor que não é IP nenhum cai em `true`: o padrão desta função é recusar.
  return version === 4 ? privateV4(address) : version === 6 ? privateV6(address) : true;
}

/**
 * Hosts extras, quando o cliente usa domínio próprio.
 *
 * Fica em variável de ambiente e não em configuração de workspace porque quem
 * amplia o alcance da rede do robô é o operador da plataforma, não o usuário do
 * grupo. Um campo na tela transformaria a allowlist em algo que o próprio
 * atacante preenche.
 */
export function allowedTangerinoHosts(env: Record<string, string | undefined> = process.env) {
  const extra = String(env.FDP_TANGERINO_BROWSER_ALLOWED_HOSTS ?? "")
    .split(/[,\s]+/u)
    .map((host) => host.trim().toLowerCase())
    .filter((host) => /^[a-z0-9.-]{3,253}$/u.test(host));
  return [...tangerinoBrowserHosts, ...extra];
}

/** `sub.tangerino.com.br` passa; `tangerino.com.br.evil.test` não. */
export function isAllowedTangerinoHost(hostname: string, env?: Record<string, string | undefined>) {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return allowedTangerinoHosts(env).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Porta de toda navegação do agente.
 *
 * `about:blank` passa porque é o estado inicial de uma aba e não alcança nada.
 * `data:` e `blob:` **não** passam, ao contrário do conector Sankhya: lá eles
 * servem ao download de planilha, que é parte da rotina. Aqui não há download —
 * o agente só lê tela —, então cada esquema a mais é superfície sem contrapartida.
 */
export async function assertAllowedTangerinoUrl(rawUrl: string, env?: Record<string, string | undefined>) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TangerinoAgentError("TANGERINO_URL_INVALID", "CONSULTATION_FAILED", "O agente tentou abrir uma URL inválida.");
  }
  if (url.protocol === "about:") return url;
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TangerinoAgentError("TANGERINO_PROTOCOL_BLOCKED", "CONSULTATION_FAILED",
      "A navegação do agente só acontece em HTTPS e sem credenciais na URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (forbiddenNames.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new TangerinoAgentError("TANGERINO_HOST_BLOCKED", "CONSULTATION_FAILED", "A navegação tentou alcançar uma rede bloqueada.");
  }
  if (!isAllowedTangerinoHost(hostname, env)) throw tangerinoErrors.unauthorizedNavigation(hostname);

  const addresses = isIP(hostname) ? [hostname] : [
    ...await resolve4(hostname).catch(() => []),
    ...await resolve6(hostname).catch(() => []),
  ];
  if (!addresses.length) throw tangerinoErrors.unavailable("Não foi possível resolver o domínio do Tangerino.");
  if (addresses.some(isPrivateNetworkAddress)) {
    throw new TangerinoAgentError("TANGERINO_ADDRESS_BLOCKED", "CONSULTATION_FAILED",
      "A navegação tentou alcançar uma rede privada ou endpoint de metadados.");
  }
  return url;
}

/**
 * Recursos estritamente necessários para uma pessoa concluir o desafio na
 * janela assistida. A regra inclui host e caminho; ela não transforma Google ou
 * hCaptcha em destinos gerais do navegador autenticado.
 */
const challengeUrlRules: readonly { host: RegExp; path: RegExp }[] = Object.freeze([
  { host: /^(?:www\.)?google\.com$/u, path: /^\/recaptcha\//u },
  { host: /^www\.gstatic\.com$/u, path: /^\/recaptcha\//u },
  { host: /^(?:www\.)?recaptcha\.net$/u, path: /^\/recaptcha\//u },
  { host: /^(?:[a-z0-9-]+\.)*hcaptcha\.com$/u, path: /^\//u },
  { host: /^challenges\.cloudflare\.com$/u, path: /^\//u },
]);

export function isAllowedTangerinoChallengeUrl(rawUrl: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  return url.protocol === "https:" && !url.username && !url.password
    && challengeUrlRules.some((rule) => rule.host.test(host) && rule.path.test(url.pathname));
}

export async function assertAllowedTangerinoChallengeUrl(rawUrl: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw tangerinoErrors.unauthorizedNavigation("invalid"); }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!isAllowedTangerinoChallengeUrl(rawUrl)) throw tangerinoErrors.unauthorizedNavigation(host || "invalid");
  /* Reutiliza a verificação de HTTPS, DNS público e bloqueio de rede privada,
     mas amplia a allowlist somente para o host que já passou pelas regras
     fixas acima. */
  return assertAllowedTangerinoUrl(rawUrl, { FDP_TANGERINO_BROWSER_ALLOWED_HOSTS: host });
}

