/**
 * O que impede o worker do Tangerino de subir, dito em nome de variável e remédio.
 *
 * Mora fora de `worker/tangerino/runner.ts` por dois motivos. O runner arrasta o
 * Playwright junto, e esta conferência precisa rodar — e ser testada — sem
 * navegador nenhum. E o worker Windows sobe numa janela que fecha ao terminar:
 * se a causa da parada não vier escrita aqui, em texto que a pessoa que opera
 * consegue agir, ela não chega a ninguém.
 *
 * Nenhuma mensagem daqui carrega valor de variável. O que falta é sempre dito
 * pelo nome da variável; o conteúdo dela é chave de cofre e string de conexão.
 */
import { tangerinoAgentConfig } from "./config.ts";

export type WorkerConfigurationProblem = {
  /** Nome da variável de ambiente, como aparece no arquivo. */
  variable: string;
  /** O que fazer — não apenas o que está errado. */
  remedy: string;
};

export class TangerinoWorkerConfigurationError extends Error {
  readonly code = "WORKER_CONFIGURATION";
  readonly problems: readonly WorkerConfigurationProblem[];

  constructor(problems: readonly WorkerConfigurationProblem[]) {
    super(describeWorkerConfigurationProblems(problems));
    this.name = "TangerinoWorkerConfigurationError";
    this.problems = problems;
  }
}

/** Distingue "falta configuração" de qualquer outra falha, inclusive entre processos. */
export function isWorkerConfigurationError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object"
    && (error as { code?: unknown }).code === "WORKER_CONFIGURATION";
}

export type WorkerConfigurationOptions = {
  /**
   * O worker Windows exige janela visível: é nela que alguém conclui o CAPTCHA
   * ou a verificação em duas etapas da Sólides. O worker da nuvem não.
   */
  requireInteractiveWindow?: boolean;
};

export function inspectWorkerConfiguration(
  env: Record<string, string | undefined> = process.env,
  options: WorkerConfigurationOptions = {},
): WorkerConfigurationProblem[] {
  const problems: WorkerConfigurationProblem[] = [];
  const connection = String(env.DATABASE_URL || env.POSTGRES_URL || env.NEON_DATABASE_URL || "").trim();
  if (!connection) {
    problems.push({
      variable: "DATABASE_URL",
      remedy: "copie a string de conexão do Postgres (a mesma do deployment) para o arquivo de ambiente.",
    });
  } else if (!connection.startsWith("postgres")) {
    /* Um valor que não começa com postgres:// costuma ser a URL do painel colada
       por engano. Dizer "ausente" mandaria a pessoa procurar uma linha que está
       lá, escrita, na frente dela. */
    problems.push({
      variable: "DATABASE_URL",
      remedy: "o valor precisa começar com postgres:// ou postgresql:// — o que está lá não é uma string de conexão.",
    });
  }

  const vaultMap = String(env.FDP_TANGERINO_VAULT_KEYS ?? "").trim();
  const vaultSingle = String(env.FDP_TANGERINO_VAULT_KEY ?? "").trim();
  if (!vaultMap && !vaultSingle) {
    problems.push({
      variable: "FDP_TANGERINO_VAULT_KEYS",
      remedy: "copie do deployment o mapa FDP_TANGERINO_VAULT_KEYS, inteiro, com todas as versões. "
        + "Sem ele o worker não abre as credenciais da Sólides, e uma chave nova não serve: "
        + "o que já foi guardado foi cifrado com a antiga.\n"
        + "     Campo em branco no painel da Vercel não quer dizer vazio: variável do tipo Sensitive "
        + "é gravável e não legível, e nunca mostra o valor de volta.\n"
        + "     Se você já teve a chave em FDP_TANGERINO_VAULT_KEY (no singular), ela pode ser a mesma — "
        + "tente {\"<versão da credencial>\":\"<aquele mesmo valor>\"} antes de rotacionar.",
    });
  } else {
    let versions: number[] = [];
    if (vaultMap) {
      try {
        const parsed = JSON.parse(vaultMap) as Record<string, unknown>;
        versions = Object.entries(parsed)
          .filter(([version, value]) => Number.isInteger(Number(version)) && Number(version) > 0
            && typeof value === "string" && value.trim().length > 0)
          .map(([version]) => Number(version));
        if (!versions.length) throw new Error("empty keyring");
      } catch {
        problems.push({
          variable: "FDP_TANGERINO_VAULT_KEYS",
          remedy: "o valor precisa ser o mapa JSON completo copiado do deployment, por exemplo {\"1\":\"...\"}. Não informe nem publique a chave em logs.",
        });
      }
    } else {
      /* A variável singular nunca representa uma rotação: por contrato ela
       * registra apenas a versão 1, independentemente do número escrito na
       * variável de versão ativa. */
      versions = [1];
    }

    const configuredVersion = String(env.FDP_TANGERINO_VAULT_KEY_VERSION ?? "").trim();
    const activeVersion = configuredVersion ? Number(configuredVersion) : Math.max(...versions);
    if (versions.length && (!Number.isInteger(activeVersion) || activeVersion <= 0 || !versions.includes(activeVersion))) {
      problems.push({
        variable: "FDP_TANGERINO_VAULT_KEY_VERSION",
        remedy: `aponte para uma versão existente em FDP_TANGERINO_VAULT_KEYS. Neste computador existem apenas as versões ${versions.join(", ") || "nenhuma"}. `
          + "Se estiver usando FDP_TANGERINO_VAULT_KEY no singular, a versão obrigatoriamente é 1.",
      });
    }
  }

  const config = tangerinoAgentConfig(env);
  if (!config.enabled) {
    problems.push({
      variable: "TANGERINO_BROWSER_AGENT_ENABLED",
      remedy: "defina como true; sem isso o agente fica desligado neste computador.",
    });
  }

  if (options.requireInteractiveWindow) {
    if (!config.profileRoot) {
      problems.push({
        variable: "FDP_TANGERINO_PROFILE_ROOT",
        remedy: "aponte para uma pasta só desta conta do Windows — é onde fica a sessão autenticada da Sólides.",
      });
    }
    /* A conferência é do que está escrito no arquivo, e não de
       `config.interactiveAuth`: aquele valor também fica falso quando o perfil
       está vazio, e aí o worker mandaria corrigir uma linha que já está certa —
       enquanto a causa real, o perfil, seria acusada em separado. */
    if (!/^(?:1|true|sim|on|yes)$/iu.test(String(env.FDP_TANGERINO_INTERACTIVE_AUTH ?? "").trim())) {
      problems.push({
        variable: "FDP_TANGERINO_INTERACTIVE_AUTH",
        remedy: "defina como true. Sem janela visível, um CAPTCHA da Sólides trava o worker em silêncio.",
      });
    }
  }

  return problems;
}

export function describeWorkerConfigurationProblems(problems: readonly WorkerConfigurationProblem[]): string {
  const linhas = problems.map((problem) => `  - ${problem.variable}: ${problem.remedy}`);
  return [
    problems.length === 1
      ? "O worker não pode subir: falta configuração."
      : `O worker não pode subir: faltam ${problems.length} configurações.`,
    ...linhas,
    "",
    "Corrija o arquivo .env.tangerino-worker.local na raiz do repositório",
    "(scripts\\windows\\configurar-worker.ps1 monta o arquivo) e suba o worker de novo.",
  ].join("\n");
}

/** Lança quando houver o que corrigir; silencioso quando estiver tudo de pé. */
export function assertWorkerConfiguration(
  env: Record<string, string | undefined> = process.env,
  options: WorkerConfigurationOptions = {},
) {
  const problems = inspectWorkerConfiguration(env, options);
  if (problems.length) throw new TangerinoWorkerConfigurationError(problems);
}
