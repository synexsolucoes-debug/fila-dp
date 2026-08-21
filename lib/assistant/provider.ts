import { ApiError } from "../api-errors.ts";
import { assertNoForbiddenFields, redact, redactDeep, type RedactionHit } from "./redaction.ts";
import { createGateway, generateText } from "ai";

/**
 * Adaptador do provedor de modelo.
 *
 * O produto não decide qual provedor você usa nem embute chave de ninguém. Sem
 * configuração, o assistente **diz o que falta** em vez de fingir que funciona
 * — o mesmo padrão do modelo oficial da Caju, e pelo mesmo motivo: uma resposta
 * inventada num sistema de DP é pior que resposta nenhuma.
 *
 * Toda saída passa pela redação antes de deixar o processo. Isso não é opcional
 * e não tem chave de ambiente que desligue: um limite de privacidade que pode
 * ser desligado por variável não é um limite.
 */

export type AssistantProviderName = "anthropic" | "openai" | "gateway";

export type AssistantConfig = {
  provider: AssistantProviderName;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxOutputTokens: number;
};

export type AssistantMessage = { role: "user" | "assistant"; content: string };

export type AssistantReply = {
  text: string;
  /** O que a redação encontrou no que foi enviado. Vai para o registro. */
  redactions: RedactionHit[];
  model: string;
  provider: AssistantProviderName;
};

const PROVIDERS: Record<AssistantProviderName, {
  baseUrl: string;
  defaultModel: string;
  keyEnv: string;
  acceptsVercelOidc?: boolean;
}> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-sonnet-5",
    keyEnv: "ANTHROPIC_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    keyEnv: "OPENAI_API_KEY",
  },
  gateway: {
    baseUrl: "",
    defaultModel: "openai/gpt-5.5",
    keyEnv: "AI_GATEWAY_API_KEY",
    acceptsVercelOidc: true,
  },
};

export type ConfigurationStatus =
  | { configured: true; config: AssistantConfig }
  | { configured: false; missing: string[]; detail: string };

/**
 * Lê a configuração do ambiente sem nunca devolver a chave para fora daqui.
 *
 * O status é o que a tela consome; a chave só existe dentro de `config`, que
 * não é serializado em resposta nenhuma.
 */
export function readAssistantConfig(env: Readonly<Record<string, string | undefined>> = process.env): ConfigurationStatus {
  const raw = String(env.FDP_ASSISTANT_PROVIDER ?? "").trim().toLowerCase();
  if (!raw) {
    return {
      configured: false,
      missing: ["FDP_ASSISTANT_PROVIDER"],
      detail: "O assistente ainda não foi configurado neste ambiente. "
        + "Defina FDP_ASSISTANT_PROVIDER (gateway, anthropic ou openai) e a autenticação do provedor escolhido.",
    };
  }
  if (!Object.hasOwn(PROVIDERS, raw)) {
    return {
      configured: false,
      missing: ["FDP_ASSISTANT_PROVIDER"],
      detail: `Provedor "${raw}" não é reconhecido. Use gateway, anthropic ou openai.`,
    };
  }
  const provider = raw as AssistantProviderName;
  const definition = PROVIDERS[provider];
  const apiKey = String(env.FDP_ASSISTANT_API_KEY ?? env[definition.keyEnv] ?? "").trim();
  const hasVercelOidc = Boolean(definition.acceptsVercelOidc
    && (env.VERCEL === "1" || String(env.VERCEL_OIDC_TOKEN ?? "").trim()));
  if (!apiKey && !hasVercelOidc) {
    return {
      configured: false,
      missing: [definition.keyEnv],
      detail: `Falta a chave do provedor. Defina ${definition.keyEnv} (ou FDP_ASSISTANT_API_KEY) neste deployment.`,
    };
  }
  return {
    configured: true,
    config: {
      provider,
      model: String(env.FDP_ASSISTANT_MODEL ?? "").trim() || definition.defaultModel,
      apiKey,
      baseUrl: String(env.FDP_ASSISTANT_BASE_URL ?? "").trim() || definition.baseUrl,
      maxOutputTokens: Number(env.FDP_ASSISTANT_MAX_TOKENS ?? 900) || 900,
    },
  };
}

/** Recusa clara: o que falta, sem expor nome de chave secreta ao usuário final. */
export function assertConfigured(status: ConfigurationStatus): asserts status is { configured: true; config: AssistantConfig } {
  if (!status.configured) {
    throw new ApiError(503, "ASSISTANT_NOT_CONFIGURED",
      "O assistente não está disponível neste ambiente. Peça ao administrador da plataforma para concluir a configuração.");
  }
}

/**
 * Monta a instrução do sistema.
 *
 * Ela diz três coisas ao modelo, e as três importam: quem está perguntando (para
 * a resposta caber na permissão da pessoa), o que ele **não** tem (para não
 * inventar dado), e o que ele não deve fazer (agir sozinho sobre a operação).
 */
export function buildSystemPrompt(context: {
  workspaceName: string;
  userName: string;
  role: string;
  screen: string;
  allowedModules: Array<{ key: string; name: string }>;
  blockedModules: Array<{ key: string; name: string; reason: string }>;
}) {
  assertNoForbiddenFields(context, "systemPrompt");
  const allowed = context.allowedModules.map((item) => item.name).join(", ") || "nenhum";
  const blocked = context.blockedModules.map((item) => `${item.name} (${item.reason})`).join("; ") || "nenhum";

  return [
    "Você é o assistente do Vinculato, um sistema de Departamento Pessoal.",
    "Responda em português do Brasil, de forma direta e curta.",
    "",
    `Grupo: ${context.workspaceName}. Usuário: ${context.userName}, papel ${context.role}. Tela atual: ${context.screen}.`,
    `Módulos liberados para esta pessoa: ${allowed}.`,
    `Módulos bloqueados para esta pessoa: ${blocked}.`,
    "",
    "Regras que você não pode quebrar:",
    "- Você NÃO tem acesso a dados de colaboradores, prestadores, folha, CPF, conta bancária ou valores.",
    "  Se a pergunta exigir esse dado, diga em que tela a pessoa encontra, não invente número.",
    "- Você NÃO executa ações. Você explica o caminho e, quando existir, indica a tela e o botão.",
    "- Se a pessoa pedir algo que o papel dela não permite, diga isso e diga quem pode fazer.",
    "- Se você não souber, diga que não sabe. Não descreva telas ou campos que você não viu na lista acima.",
  ].join("\n");
}

/**
 * Envia a conversa ao provedor.
 *
 * A redação acontece aqui, no último ponto antes da rede — não na rota, onde
 * seria fácil esquecer numa chamada nova.
 */
export async function askAssistant(input: {
  config: AssistantConfig;
  system: string;
  messages: readonly AssistantMessage[];
  signal?: AbortSignal;
}): Promise<AssistantReply> {
  const { config } = input;
  const systemSafe = redact(input.system);
  const { value: messagesSafe, hits } = redactDeep(input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  })));
  const redactions = [...systemSafe.hits, ...hits];

  if (config.provider === "gateway") {
    try {
      const result = await generateText({
        model: config.apiKey ? createGateway({ apiKey: config.apiKey })(config.model) : config.model,
        instructions: systemSafe.text,
        messages: messagesSafe,
        maxOutputTokens: config.maxOutputTokens,
        abortSignal: input.signal,
      });
      const text = result.text.trim();
      if (!text) {
        throw new ApiError(502, "ASSISTANT_EMPTY_REPLY", "O assistente não conseguiu responder agora. Tente de novo em instantes.");
      }
      return { text, redactions, model: config.model, provider: config.provider };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // O erro do Gateway pode trazer detalhes de autenticação e da requisição;
      // a interface recebe somente uma orientação operacional segura.
      throw new ApiError(502, "ASSISTANT_PROVIDER_ERROR",
        "O assistente não conseguiu responder agora. Tente de novo em instantes.");
    }
  }

  const response = await fetch(config.baseUrl, {
    method: "POST",
    signal: input.signal,
    headers: config.provider === "anthropic"
      ? {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      }
      : {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
    body: JSON.stringify(config.provider === "anthropic"
      ? {
        model: config.model,
        max_tokens: config.maxOutputTokens,
        system: systemSafe.text,
        messages: messagesSafe,
      }
      : {
        model: config.model,
        max_tokens: config.maxOutputTokens,
        messages: [{ role: "system", content: systemSafe.text }, ...messagesSafe],
      }),
  });

  if (!response.ok) {
    // O corpo do erro do provedor pode conter a requisição inteira; ele não vai
    // para o usuário nem para o log.
    throw new ApiError(502, "ASSISTANT_PROVIDER_ERROR",
      response.status === 401 || response.status === 403
        ? "A credencial do assistente foi recusada pelo provedor. Peça ao administrador da plataforma para revisá-la."
        : "O assistente não conseguiu responder agora. Tente de novo em instantes.");
  }

  const payload = await response.json() as Record<string, unknown>;
  const text = extractText(config.provider, payload);
  if (!text) {
    throw new ApiError(502, "ASSISTANT_EMPTY_REPLY", "O assistente não conseguiu responder agora. Tente de novo em instantes.");
  }

  return { text, redactions, model: config.model, provider: config.provider };
}

function extractText(provider: AssistantProviderName, payload: Record<string, unknown>): string {
  if (provider === "anthropic") {
    const content = payload.content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block): block is { type: string; text: string } =>
        Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content.trim() : "";
}
