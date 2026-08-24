/**
 * Configuração do agente Tangerino.
 *
 * Poucas variáveis, e cada uma justificada: variável de ambiente é dívida de
 * operação — precisa ser documentada, provisionada em dois lugares (aplicação e
 * worker) e lembrada por alguém dali a seis meses. As que existem aqui mudam
 * comportamento que não dá para inferir do código: se o agente está ligado, se
 * mostra o navegador, quanto espera, quantos abre ao mesmo tempo e por quanto
 * tempo reaproveita a sessão.
 */

const number = (raw: string | undefined, fallback: number, min: number, max: number) => {
  /* Texto vazio precisa cair no padrão, e não virar zero.
     `Number("")` é 0, que é finito — sem este recorte, toda variável não
     definida seria presa no mínimo da faixa em vez de usar o padrão, e o agente
     rodaria com concorrência 1 e cache 0 sem ninguém ter pedido isso. */
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
};

const flag = (raw: string | undefined) => /^(?:1|true|sim|on|yes)$/iu.test(String(raw ?? "").trim());

export type TangerinoAgentConfig = {
  enabled: boolean;
  headless: boolean;
  /** Perfil persistente, sempre particionado por workspace no worker. */
  profileRoot: string;
  /** Permite que uma pessoa conclua CAPTCHA/MFA no navegador visível. */
  interactiveAuth: boolean;
  /** Quanto o worker visível aguarda a conclusão do desafio humano. */
  interactiveAuthTimeoutMs: number;
  /** Teto de tempo de uma consulta inteira, do login à leitura. */
  timeoutMs: number;
  /** Navegadores simultâneos no worker, somando todos os workspaces. */
  concurrency: number;
  /** Por quanto tempo uma sessão autenticada pode ser reaproveitada (§14). */
  sessionTtlMs: number;
  /** Janela em que uma consulta recente é reaproveitada em vez de refeita (§41). */
  cacheTtlSeconds: number;
  /** Consultas por usuário por minuto (§40). */
  rateLimitPerMinute: number;
  /** Screenshots de depuração, só em ambiente controlado (§53). */
  screenshots: boolean;
};

export function tangerinoAgentConfig(env: Record<string, string | undefined> = process.env): TangerinoAgentConfig {
  const onVercel = Boolean(String(env.VERCEL ?? env.VERCEL_ENV ?? "").trim());
  const production = onVercel || String(env.NODE_ENV ?? "").toLowerCase() === "production";
  const profileRoot = String(env.FDP_TANGERINO_PROFILE_ROOT ?? "").trim();
  /* O modo assistido só existe fora da Vercel e com perfil isolado configurado.
     Sem estas duas condições, abrir uma janela não preservaria a autenticação e
     poderia misturar a sessão de workspaces diferentes. */
  const interactiveAuth = !onVercel && Boolean(profileRoot) && flag(env.FDP_TANGERINO_INTERACTIVE_AUTH);
  return {
    enabled: flag(env.TANGERINO_BROWSER_AGENT_ENABLED),
    /* A Vercel continua sempre headless. O worker Windows assistido é a única
       exceção de produção: a janela é justamente onde a pessoa resolve o
       desafio legítimo e a sessão fica no perfil persistente. */
    headless: onVercel ? true : interactiveAuth ? false : !flag(env.TANGERINO_BROWSER_HEADLESS_OFF),
    profileRoot,
    interactiveAuth,
    interactiveAuthTimeoutMs: number(env.FDP_TANGERINO_INTERACTIVE_AUTH_TIMEOUT_MS, 10 * 60_000, 60_000, 15 * 60_000),
    timeoutMs: number(env.TANGERINO_BROWSER_TIMEOUT_MS, 90_000, 10_000, 300_000),
    concurrency: number(env.TANGERINO_BROWSER_CONCURRENCY, 2, 1, 8),
    sessionTtlMs: number(env.TANGERINO_SESSION_TTL_MS, 10 * 60_000, 60_000, 30 * 60_000),
    cacheTtlSeconds: number(env.TANGERINO_CONSULTATION_CACHE_SECONDS, 60, 0, 3_600),
    rateLimitPerMinute: number(env.TANGERINO_CONSULTATION_RATE_PER_MINUTE, 6, 1, 60),
    screenshots: !production && flag(env.DEBUG_TANGERINO_SCREENSHOTS),
  };
}

/**
 * A frase que o portão devolve quando o agente está desligado.
 *
 * Dizer só "indisponível" manda a pessoa tentar de novo o que não vai funcionar.
 * O que destrava é uma variável de ambiente do deployment e a liberação do
 * módulo por workspace — duas coisas que quem lê a mensagem não faz sozinho, e
 * por isso precisa saber a quem pedir.
 */
export const TANGERINO_AGENT_DISABLED_MESSAGE = "O agente de consulta do Tangerino está desligado neste ambiente. "
  + "Ele depende de TANGERINO_BROWSER_AGENT_ENABLED no deployment e da liberação do módulo para este workspace, "
  + "feita pela plataforma em Configuração operacional › Acessos e módulos.";

export const TANGERINO_MODULE_DISABLED_MESSAGE = "O agente de consulta do Tangerino ainda não está liberado para este workspace. "
  + "Ele não faz parte de nenhum plano: a liberação é individual e feita pela plataforma, "
  + "em Configuração operacional › Acessos e módulos › Módulos do workspace.";

